import { loadStoresConfig, normalizeShopDomain, resolveStore } from "../lib/store-config.js";
import { getAdminAccessToken } from "../lib/shopify-client.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    shop: "",
    refresh: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--shop" && args[i + 1]) {
      parsed.shop = args[i + 1];
      i += 1;
      continue;
    }
    if (value === "--refresh") {
      parsed.refresh = true;
      continue;
    }
  }

  return parsed;
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

try {
  const token = await getAdminAccessToken(store, { forceRefresh: args.refresh });
  console.log(token);
} catch (error) {
  console.error(`Failed to get token for ${store.shopDomain}: ${String(error?.message || error)}`);
  process.exit(1);
}