import { loadStoresConfig, normalizeShopDomain, resolveStore } from "../lib/store-config.js";
import { shopifyGraphQL } from "../lib/shopify-client.js";

const WEBHOOK_CALLBACK_URL = process.env.WEBHOOK_CALLBACK_URL || "";

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    all: false,
    shop: "",
  };

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--all") {
      parsed.all = true;
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

if (!WEBHOOK_CALLBACK_URL) {
  console.error("Missing WEBHOOK_CALLBACK_URL.");
  process.exit(1);
}

const args = parseArgs();
const { stores, storeMap } = loadStoresConfig();

if (!stores.length) {
  console.error("No stores configured.");
  process.exit(1);
}

let targetStores;
if (args.shop) {
  const store = resolveStore(storeMap, normalizeShopDomain(args.shop));
  if (!store) {
    console.error(`Store not found: ${args.shop}`);
    process.exit(1);
  }
  targetStores = [store];
} else if (args.all || stores.length > 1) {
  targetStores = stores;
} else {
  targetStores = [stores[0]];
}

let failed = false;

for (const store of targetStores) {
  try {
    const data = await shopifyGraphQL(store, mutation, {
      topic: "ORDERS_RISK_ASSESSMENT_CHANGED",
      webhookSubscription: {
        uri: WEBHOOK_CALLBACK_URL,
        format: "JSON",
      },
    });

    const result = data?.webhookSubscriptionCreate;
    if (result?.userErrors?.length) {
      failed = true;
      console.error(`Webhook registration userErrors for ${store.shopDomain}:`);
      console.error(JSON.stringify(result.userErrors, null, 2));
      continue;
    }

    console.log(`Webhook registered for ${store.shopDomain}:`);
    console.log(JSON.stringify(result?.webhookSubscription, null, 2));
  } catch (error) {
    failed = true;
    console.error(`Webhook registration failed for ${store.shopDomain}: ${String(error?.message || error)}`);
  }
}

if (failed) {
  process.exit(1);
}