import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

dotenv.config();

const LOCAL_CONFIG_PATH = path.join(process.cwd(), "shopify_config.json");

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
const WEBHOOK_CALLBACK_URL = process.env.WEBHOOK_CALLBACK_URL || "";

if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN || !WEBHOOK_CALLBACK_URL) {
  console.error("Missing config. Set SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN, WEBHOOK_CALLBACK_URL.");
  process.exit(1);
}

const mutation = `
mutation RegisterRiskWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription {
      id
      topic
      uri
    }
    userErrors {
      field
      message
    }
  }
}
`;

const variables = {
  topic: "ORDERS_RISK_ASSESSMENT_CHANGED",
  webhookSubscription: {
    uri: WEBHOOK_CALLBACK_URL,
    format: "JSON",
  },
};

const endpoint = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
  },
  body: JSON.stringify({ query: mutation, variables }),
});

const json = await response.json();

if (!response.ok || json.errors?.length || json.data?.webhookSubscriptionCreate?.userErrors?.length) {
  console.error("Webhook registration failed:");
  console.error(JSON.stringify(json, null, 2));
  process.exit(1);
}

console.log("Webhook registered:");
console.log(JSON.stringify(json.data.webhookSubscriptionCreate.webhookSubscription, null, 2));