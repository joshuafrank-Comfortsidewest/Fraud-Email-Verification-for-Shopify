import nodemailer from "nodemailer";

import { loadStoresConfig, normalizeShopDomain, resolveStore } from "../lib/store-config.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    shop: "",
    to: "",
  };

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--shop" && args[i + 1]) {
      parsed.shop = args[i + 1];
      i += 1;
      continue;
    }
    if (value === "--to" && args[i + 1]) {
      parsed.to = args[i + 1];
      i += 1;
      continue;
    }
  }

  return parsed;
}

function buildBody(store) {
  const statementPrefix = store.statementPrefix || "SP HVACSUPPLIES";
  const exampleCode = String(store.statementExampleCode || "9341");
  const example = `${statementPrefix}${exampleCode}`;

  return `Dear Customer,

Thank you for placing an order with ${store.brandName}! To ensure the security of your purchase and prevent unauthorized transactions, we require additional verification for certain high-value or flagged orders.

To proceed, please verify the unique billing value associated with your order.

Here's what you need to do:
1. Check the billing statement for the card or bank account used for this purchase.
2. Locate the transaction description that starts with ${statementPrefix}.
3. Provide the unique four-digit code listed at the end of this description (EXAMPLE: ${example}).

Please reply to this email with the four-digit code within 48 hours. If we do not receive verification, your order will be cancelled for security purposes.

Why do we require this?
- Billing and shipping addresses don't match
- High-risk internet proxy
- Multiple payment attempts
- High-value orders or flagged transactions

If you have any questions, contact our support team at ${store.supportEmail}.

Thank you for your understanding and cooperation.

All the best!`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildHtml(textBody, store) {
  const textHtml = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">${escapeHtml(textBody).replace(/\n/g, "<br>")}</div>`;
  if (!store.emailSignatureHtml) {
    return textHtml;
  }
  return `${textHtml}<br><br>${store.emailSignatureHtml}`;
}

const args = parseArgs();
const { stores, storeMap } = loadStoresConfig();

if (!stores.length) {
  console.error("No stores configured.");
  process.exit(1);
}

let store;
if (args.shop) {
  store = resolveStore(storeMap, normalizeShopDomain(args.shop));
  if (!store) {
    console.error(`Store not found: ${args.shop}`);
    process.exit(1);
  }
} else if (stores.length === 1) {
  store = stores[0];
} else {
  console.error("Multiple stores configured. Pass --shop <shop-domain>.");
  process.exit(1);
}

const toEmail = args.to || process.env.SEND_TO_OVERRIDE || "";
if (!toEmail) {
  console.error("Missing destination email. Pass --to or set SEND_TO_OVERRIDE.");
  process.exit(1);
}

if (!store.gmailUser || !store.gmailAppPassword || !store.fromEmail) {
  console.error(`Missing Gmail config for ${store.shopDomain}.`);
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: store.gmailUser,
    pass: store.gmailAppPassword,
  },
});

const textBody = buildBody(store);
const htmlBody = buildHtml(textBody, store);

await transporter.verify();
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

console.log(`Test email sent to ${toEmail} for ${store.shopDomain}`);