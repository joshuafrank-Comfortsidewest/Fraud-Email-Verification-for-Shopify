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

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    apply: false,
    orderId: "",
  };

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--apply") {
      parsed.apply = true;
      continue;
    }
    if (value === "--order-id" && args[i + 1]) {
      parsed.orderId = args[i + 1];
      i += 1;
      continue;
    }
  }

  return parsed;
}

function normalizeOrderGid(value) {
  if (!value) {
    return "";
  }
  if (String(value).startsWith("gid://shopify/Order/")) {
    return String(value);
  }
  return `gid://shopify/Order/${String(value).trim()}`;
}

const args = parseArgs();
const localShopifyConfig = loadLocalShopifyConfig();

const SHOPIFY_SHOP_DOMAIN = stripProtocol(
  process.env.SHOPIFY_SHOP_DOMAIN || localShopifyConfig.shop_url || ""
);
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || localShopifyConfig.api_ver || "2025-04";
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || localShopifyConfig.token || "";

if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) {
  console.error("Missing config. Set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN.");
  process.exit(1);
}

async function shopifyGraphQL(query, variables = {}) {
  const endpoint = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();

  if (!response.ok || json.errors?.length) {
    throw new Error(`GraphQL request failed: ${JSON.stringify(json)}`);
  }

  return json.data;
}

const GET_LATEST_ORDER = `
  query LatestOrderForRiskTest {
    orders(first: 1, reverse: true, sortKey: CREATED_AT) {
      nodes {
        id
        name
        createdAt
        email
      }
    }
  }
`;

const CREATE_HIGH_RISK = `
  mutation CreateHighRiskAssessment($input: OrderRiskAssessmentCreateInput!) {
    orderRiskAssessmentCreate(orderRiskAssessmentInput: $input) {
      userErrors {
        field
        message
      }
      orderRiskAssessment {
        riskLevel
      }
    }
  }
`;

const targetOrderId = normalizeOrderGid(args.orderId || process.env.TEST_ORDER_ID || "");
let orderId = targetOrderId;

if (!orderId) {
  let latest;
  try {
    latest = await shopifyGraphQL(GET_LATEST_ORDER);
  } catch (error) {
    const message = String(error?.message || "");
    if (message.includes("Access denied for orders field")) {
      console.error("Cannot read latest order: token is missing read_orders scope.");
      console.error("Use --order-id gid://shopify/Order/<id> or add read_orders scope and reinstall the app.");
      process.exit(1);
    }
    throw error;
  }

  const order = latest?.orders?.nodes?.[0];

  if (!order?.id) {
    console.error("No orders found on this shop.");
    process.exit(1);
  }

  orderId = order.id;
  console.log("Latest order selected:");
  console.log(JSON.stringify(order, null, 2));
}

if (!args.apply) {
  console.log("Dry run only. No risk assessment created.");
  console.log("Run with --apply to create HIGH risk assessment:");
  console.log(`node scripts/test-risk.js --apply --order-id ${orderId}`);
  process.exit(0);
}

const result = await shopifyGraphQL(CREATE_HIGH_RISK, {
  input: {
    orderId,
    riskLevel: "HIGH",
    facts: [
      {
        description: "Manual test run from scripts/test-risk.js",
        sentiment: "NEUTRAL",
      },
    ],
  },
});

const payload = result?.orderRiskAssessmentCreate;
if (payload?.userErrors?.length) {
  console.error("Mutation returned userErrors:");
  console.error(JSON.stringify(payload.userErrors, null, 2));
  process.exit(1);
}

console.log("HIGH risk assessment created:");
console.log(JSON.stringify(payload?.orderRiskAssessment, null, 2));
console.log("If webhook is configured, your service should process this order now.");
