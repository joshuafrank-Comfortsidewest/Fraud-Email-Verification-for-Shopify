import { loadStoresConfig, normalizeShopDomain, resolveStore } from "../lib/store-config.js";
import { shopifyGraphQL } from "../lib/shopify-client.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    apply: false,
    orderId: "",
    shop: "",
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
    if (value === "--shop" && args[i + 1]) {
      parsed.shop = args[i + 1];
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

const targetOrderId = normalizeOrderGid(args.orderId || process.env.TEST_ORDER_ID || "");
let orderId = targetOrderId;

if (!orderId) {
  let latest;
  try {
    latest = await shopifyGraphQL(store, GET_LATEST_ORDER);
  } catch (error) {
    const message = String(error?.message || "");
    if (message.includes("Access denied for orders field")) {
      console.error(`Cannot read latest order on ${store.shopDomain}: missing read_orders scope.`);
      console.error("Use --order-id gid://shopify/Order/<id> or update app scopes.");
      process.exit(1);
    }
    throw error;
  }

  const order = latest?.orders?.nodes?.[0];

  if (!order?.id) {
    console.error(`No orders found on ${store.shopDomain}.`);
    process.exit(1);
  }

  orderId = order.id;
  console.log(`Latest order selected on ${store.shopDomain}:`);
  console.log(JSON.stringify(order, null, 2));
}

if (!args.apply) {
  console.log("Dry run only. No risk assessment created.");
  console.log("Run with --apply to create HIGH risk assessment:");
  console.log(`node scripts/test-risk.js --apply --shop ${store.shopDomain} --order-id ${orderId}`);
  process.exit(0);
}

const result = await shopifyGraphQL(store, CREATE_HIGH_RISK, {
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

console.log(`HIGH risk assessment created on ${store.shopDomain}:`);
console.log(JSON.stringify(payload?.orderRiskAssessment, null, 2));
console.log("If webhook is configured, your service should process this order now.");