import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import express from "express";
import nodemailer from "nodemailer";

dotenv.config();

const LOCAL_CONFIG_PATH = path.join(process.cwd(), "shopify_config.json");
const SENT_ORDERS_PATH = path.join(process.cwd(), "sent-verification-orders.json");
const PORT = Number(process.env.PORT || 3000);

function loadLocalShopifyConfig() {
  if (!fs.existsSync(LOCAL_CONFIG_PATH)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function stripProtocol(urlOrDomain = "") {
  return urlOrDomain.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

const localShopifyConfig = loadLocalShopifyConfig();

const SHOPIFY_SHOP_DOMAIN = stripProtocol(
  process.env.SHOPIFY_SHOP_DOMAIN || localShopifyConfig.shop_url || ""
);
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || localShopifyConfig.api_ver || "2025-04";
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || localShopifyConfig.token || "";
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_APP_SECRET || "";

const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";
const FROM_EMAIL = process.env.FROM_EMAIL || GMAIL_USER;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "sales@hvacsupplies.com";
const SEND_TO_OVERRIDE = process.env.SEND_TO_OVERRIDE || "";

if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN || !SHOPIFY_WEBHOOK_SECRET) {
  console.error("Missing Shopify config. Set SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN, and SHOPIFY_APP_SECRET (or SHOPIFY_WEBHOOK_SECRET).");
  process.exit(1);
}

if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !FROM_EMAIL) {
  console.error("Missing Gmail config. Set GMAIL_USER, GMAIL_APP_PASSWORD, FROM_EMAIL.");
  process.exit(1);
}

const app = express();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
});

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

function verifyWebhookHmac(rawBody, receivedHmac) {
  if (!receivedHmac || !rawBody?.length) {
    return false;
  }

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("base64");

  const received = Buffer.from(receivedHmac, "utf8");
  const expected = Buffer.from(digest, "utf8");

  if (received.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(received, expected);
}

async function shopifyGraphQL(query, variables) {
  const endpoint = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Shopify GraphQL failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(payload.errors)}`);
  }

  return payload.data;
}

const ORDER_RISK_QUERY = `
  query OrderRiskForVerificationEmail($id: ID!) {
    order(id: $id) {
      id
      name
      email
      risk {
        recommendation
        assessments {
          riskLevel
        }
      }
    }
  }
`;

function shouldRequestVerification(order) {
  const recommendation = order?.risk?.recommendation || "";
  const recommendationIsRisky = ["HIGH", "MEDIUM"].includes(String(recommendation).toUpperCase());

  if (recommendationIsRisky) {
    return true;
  }

  const levels = (order?.risk?.assessments || []).map((a) => String(a?.riskLevel || "").toUpperCase());
  return levels.some((level) => level === "HIGH" || level === "MEDIUM");
}

function buildEmailBody(order) {
  const firstName = "Customer";

  return `Dear ${firstName},

Thank you for placing an order with Hvac Supplies! To ensure the security of your purchase and prevent unauthorized transactions, we require additional verification for certain high-value or flagged orders.

To proceed, please verify the unique billing value associated with your order.

Here's what you need to do:
1. Check the billing statement for the card or bank account used for this purchase.
2. Locate the transaction description that starts with SP HVACSUPPLIES.
3. Provide the unique four-digit code listed at the end of this description (EXAMPLE: SP HVACSUPPLIES9341).

Please reply to this email with the four-digit code within 48 hours. If we do not receive verification, your order will be cancelled for security purposes.

Why do we require this?
- Billing and shipping addresses don't match
- High-risk internet proxy
- Multiple payment attempts
- High-value orders or flagged transactions

If you have any questions, contact our support team at ${SUPPORT_EMAIL}.

Thank you for your understanding and cooperation.

All the best!`;
}

async function sendVerificationEmail(order) {
  const toEmail = SEND_TO_OVERRIDE || order?.email;
  if (!toEmail) {
    console.log(`Skipping ${order?.id || "unknown order"}: no customer email`);
    return;
  }

  await transporter.sendMail({
    from: FROM_EMAIL,
    to: toEmail,
    subject: "Verification Required for Your Recent Order",
    text: buildEmailBody(order),
    headers: {
      "X-Category": "Need Verification",
    },
  });

  console.log(`Verification email sent to ${toEmail} for ${order?.name || order?.id || "order"}`);
}

app.post("/webhooks/orders-risk", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const topic = req.get("x-shopify-topic") || "";
    const hmac = req.get("x-shopify-hmac-sha256") || "";

    if (!verifyWebhookHmac(req.body, hmac)) {
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

    const data = await shopifyGraphQL(ORDER_RISK_QUERY, { id: orderGid });
    const order = data?.order;

    if (!order) {
      res.status(200).send("Ignored: order not found");
      return;
    }

    if (!shouldRequestVerification(order)) {
      res.status(200).send("Ignored: risk below threshold");
      return;
    }

    if (sentOrderIds.has(order.id)) {
      res.status(200).send("Ignored: verification already sent");
      return;
    }

    await sendVerificationEmail(order);
    sentOrderIds.add(order.id);
    saveSentOrders(sentOrderIds);
    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook processing failed:", error);
    res.status(500).send("Webhook processing error");
  }
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.listen(PORT, async () => {
  try {
    await transporter.verify();
    console.log(`SMTP ready. Listening on port ${PORT}`);
  } catch (error) {
    console.error("SMTP check failed:", error);
    process.exit(1);
  }
});
