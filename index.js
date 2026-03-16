import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import express from "express";
import nodemailer from "nodemailer";

import { loadStoresConfig, normalizeShopDomain, resolveStore } from "./lib/store-config.js";
import { shopifyGraphQL } from "./lib/shopify-client.js";

const SENT_ORDERS_PATH = path.join(process.cwd(), "sent-verification-orders.json");
const PORT = Number(process.env.PORT || 3000);
const SEND_TO_OVERRIDE = process.env.SEND_TO_OVERRIDE || "";

const { stores, storeMap } = loadStoresConfig();

if (!stores.length) {
  console.error("No stores configured. Provide stores.config.json or single-store env values.");
  process.exit(1);
}

const app = express();
const transporterCache = new Map();
const transporterVerified = new Set();

const ORDER_RISK_QUERY = `
  query OrderRiskForVerificationEmail($id: ID!) {
    order(id: $id) {
      id
      name
      email
      note
      risk {
        recommendation
        assessments {
          riskLevel
        }
      }
    }
  }
`;

const ORDER_NOTE_UPDATE_MUTATION = `
  mutation OrderNoteUpdateForVerification($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
        note
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function loadSentOrders() {
  if (!fs.existsSync(SENT_ORDERS_PATH)) {
    return new Set();
  }

  try {
    const data = JSON.parse(fs.readFileSync(SENT_ORDERS_PATH, "utf8"));
    if (!Array.isArray(data)) {
      return new Set();
    }
    return new Set(data.map((id) => String(id)));
  } catch {
    return new Set();
  }
}

function saveSentOrders(sentOrderIds) {
  fs.writeFileSync(SENT_ORDERS_PATH, JSON.stringify([...sentOrderIds], null, 2), "utf8");
}

const sentOrderIds = loadSentOrders();

function normalizeOrderGid(payload) {
  const raw = payload?.admin_graphql_api_id || payload?.order_admin_graphql_api_id || payload?.order_id || payload?.id;
  if (!raw) {
    return null;
  }

  if (typeof raw === "string" && raw.startsWith("gid://shopify/Order/")) {
    return raw;
  }

  return `gid://shopify/Order/${String(raw).trim()}`;
}

function verifyWebhookHmac(rawBody, receivedHmac, secret) {
  if (!receivedHmac || !rawBody?.length || !secret) {
    return false;
  }

  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const received = Buffer.from(receivedHmac, "base64");
  const expected = Buffer.from(digest, "base64");

  if (received.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(received, expected);
}

function shouldRequestVerification(order) {
  const recommendation = order?.risk?.recommendation || "";
  const recommendationIsRisky = ["HIGH", "MEDIUM"].includes(String(recommendation).toUpperCase());

  if (recommendationIsRisky) {
    return true;
  }

  const levels = (order?.risk?.assessments || []).map((assessment) => String(assessment?.riskLevel || "").toUpperCase());
  return levels.some((level) => level === "HIGH" || level === "MEDIUM");
}

function renderTemplate(template, context) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, token) => {
    const value = context[token];
    return value == null ? "" : String(value);
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildEmailBody(order, store) {
  const customerName = "Customer";
  const statementPrefix = store.statementPrefix || "SP HVACSUPPLIES";
  const statementExampleCode = String(store.statementExampleCode || "9341");

  const context = {
    customerName,
    brandName: store.brandName || "Hvac Supplies",
    supportEmail: store.supportEmail,
    statementPrefix,
    statementExampleCode,
    statementExample: `${statementPrefix}${statementExampleCode}`,
  };

  if (store.customEmailBody) {
    return renderTemplate(store.customEmailBody, context);
  }

  return `Dear ${context.customerName},

Thank you for placing an order with ${context.brandName}! To ensure the security of your purchase and prevent unauthorized transactions, we require additional verification for certain high-value or flagged orders.

To proceed, please verify the unique billing value associated with your order.

Here's what you need to do:
1. Check the billing statement for the card or bank account used for this purchase.
2. Locate the transaction description that starts with ${context.statementPrefix}.
3. Provide the unique four-digit code listed at the end of this description (EXAMPLE: ${context.statementExample}).

Please reply to this email with the four-digit code within 48 hours. If we do not receive verification, your order will be cancelled for security purposes.

Why do we require this?
- Billing and shipping addresses don't match
- High-risk internet proxy
- Multiple payment attempts
- High-value orders or flagged transactions

If you have any questions, contact our support team at ${context.supportEmail}.

Thank you for your understanding and cooperation.

All the best!`;
}

function buildEmailHtml(textBody, store) {
  const textHtml = `<div style=\"font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222\">${escapeHtml(textBody).replace(/\n/g, "<br>")}</div>`;
  if (!store.emailSignatureHtml) {
    return textHtml;
  }
  return `${textHtml}<br><br>${store.emailSignatureHtml}`;
}

async function getTransporter(store) {
  if (!store.gmailUser || !store.gmailAppPassword || !store.fromEmail) {
    throw new Error(`Missing Gmail config for ${store.shopDomain}`);
  }

  const key = store.shopDomain;
  if (!transporterCache.has(key)) {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: store.gmailUser,
        pass: store.gmailAppPassword,
      },
    });
    transporterCache.set(key, transporter);
  }

  const transporter = transporterCache.get(key);
  if (!transporterVerified.has(key)) {
    await transporter.verify();
    transporterVerified.add(key);
  }

  return transporter;
}

async function sendVerificationEmail(order, store) {
  const toEmail = SEND_TO_OVERRIDE || order?.email;
  if (!toEmail) {
    console.log(`Skipping ${store.shopDomain} ${order?.id || "unknown order"}: no customer email`);
    return {
      status: "failed_no_email",
      reason: "Verification email failed because no email was provided.",
    };
  }

  try {
    const transporter = await getTransporter(store);
    const textBody = buildEmailBody(order, store);
    const htmlBody = buildEmailHtml(textBody, store);
    await transporter.sendMail({
      from: store.fromEmail,
      to: toEmail,
      subject: store.emailSubject,
      text: textBody,
      html: htmlBody,
      headers: {
        "X-Category": store.emailCategory,
      },
    });
  } catch (error) {
    const reason = String(error?.message || "unknown email transport error").replace(/\s+/g, " ").trim();
    console.error(`Verification email failed for ${store.shopDomain} ${order?.name || order?.id || "order"}: ${reason}`);
    return {
      status: "failed_send_error",
      reason: `Verification email failed: ${reason}`.slice(0, 500),
    };
  }

  console.log(`Verification email sent to ${toEmail} for ${store.shopDomain} ${order?.name || order?.id || "order"}`);
  return {
    status: "sent",
    reason: "Verification Sent! Waiting on verification from customer",
  };
}

async function appendVerificationOrderNote(order, noteMessage, store) {
  if (!order?.id || !noteMessage) {
    return false;
  }

  const timestamp = new Date().toISOString();
  const line = `[Verification] ${timestamp} ${noteMessage}`;
  const existing = String(order?.note || "").trim();
  const note = existing ? `${existing}\n${line}` : line;

  try {
    const data = await shopifyGraphQL(store, ORDER_NOTE_UPDATE_MUTATION, {
      input: {
        id: order.id,
        note,
      },
    });

    const userErrors = data?.orderUpdate?.userErrors || [];
    if (userErrors.length) {
      console.log(`Order note update userErrors for ${store.shopDomain} ${order.id}: ${JSON.stringify(userErrors)}`);
      return false;
    }

    order.note = data?.orderUpdate?.order?.note || note;
    return true;
  } catch (error) {
    console.log(`Order note update failed for ${store.shopDomain} ${order.id}: ${String(error?.message || error)}`);
    return false;
  }
}

function makeSentOrderKey(store, orderId) {
  return `${store.shopDomain}:${orderId}`;
}

function getStoreForRequest(req) {
  const headerShop = normalizeShopDomain(req.get("x-shopify-shop-domain") || "");
  if (headerShop) {
    return resolveStore(storeMap, headerShop);
  }

  if (stores.length === 1) {
    return stores[0];
  }

  return null;
}

app.post("/webhooks/orders-risk", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const topic = req.get("x-shopify-topic") || "";
    const hmac = req.get("x-shopify-hmac-sha256") || "";
    const store = getStoreForRequest(req);

    if (!store) {
      res.status(400).send("Unknown shop");
      return;
    }

    if (!verifyWebhookHmac(req.body, hmac, store.webhookSecret)) {
      res.status(401).send("Invalid HMAC");
      return;
    }

    if (!topic.startsWith("orders/")) {
      res.status(200).send("Ignored: non-order topic");
      return;
    }

    const payload = JSON.parse(req.body.toString("utf8"));
    const orderGid = normalizeOrderGid(payload);

    if (!orderGid) {
      res.status(200).send("Ignored: missing order ID");
      return;
    }

    const data = await shopifyGraphQL(store, ORDER_RISK_QUERY, { id: orderGid });
    const order = data?.order;

    if (!order) {
      res.status(200).send("Ignored: order not found");
      return;
    }

    if (!shouldRequestVerification(order)) {
      res.status(200).send("Ignored: risk below threshold");
      return;
    }

    const sentKey = makeSentOrderKey(store, order.id);
    if (sentOrderIds.has(sentKey)) {
      res.status(200).send("Ignored: verification already sent");
      return;
    }

    const emailResult = await sendVerificationEmail(order, store);
    const noteUpdated = await appendVerificationOrderNote(order, emailResult.reason, store);
    if (!noteUpdated) {
      console.log(`Order note was not updated for ${store.shopDomain} ${order?.name || order.id}`);
    }

    if (emailResult.status === "sent") {
      sentOrderIds.add(sentKey);
      saveSentOrders(sentOrderIds);
      res.status(200).send("OK");
      return;
    }

    res.status(200).send(`Handled: ${emailResult.status}`);
  } catch (error) {
    console.error("Webhook processing failed:", error);
    res.status(500).send("Webhook processing error");
  }
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", stores: stores.map((store) => store.shopDomain) });
});

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  console.log(`Configured stores: ${stores.map((store) => store.shopDomain).join(", ")}`);
});
