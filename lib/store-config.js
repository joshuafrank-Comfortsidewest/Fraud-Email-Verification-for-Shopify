import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

dotenv.config();

const LOCAL_CONFIG_PATH = path.join(process.cwd(), "shopify_config.json");
const STORES_CONFIG_PATH = path.join(process.cwd(), "stores.config.json");

function readOptionalFile(relativeFilePath = "") {
  if (!relativeFilePath) {
    return "";
  }

  const absolute = path.isAbsolute(relativeFilePath)
    ? relativeFilePath
    : path.join(process.cwd(), relativeFilePath);

  if (!fs.existsSync(absolute)) {
    return "";
  }

  try {
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return "";
  }
}

export function normalizeShopDomain(value = "") {
  return String(value).trim().toLowerCase().replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

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

function normalizeStore(rawStore = {}, defaultApiVersion = "2026-01") {
  const shopDomain = normalizeShopDomain(rawStore.shopDomain || rawStore.shop || rawStore.domain || "");

  return {
    shopDomain,
    apiVersion: rawStore.apiVersion || defaultApiVersion,
    adminAccessToken: rawStore.adminAccessToken || "",
    apiKey: rawStore.apiKey || rawStore.clientId || "",
    apiSecret: rawStore.apiSecret || rawStore.clientSecret || rawStore.appSecret || "",
    webhookSecret: rawStore.webhookSecret || rawStore.appSecret || "",
    gmailUser: rawStore.gmailUser || "",
    gmailAppPassword: String(rawStore.gmailAppPassword || "").replace(/\s+/g, ""),
    fromEmail: rawStore.fromEmail || rawStore.gmailUser || "",
    supportEmail: rawStore.supportEmail || rawStore.fromEmail || rawStore.gmailUser || "",
    brandName: rawStore.brandName || "Hvac Supplies",
    orderCodePrefix: rawStore.orderCodePrefix || "",
    statementPrefix: rawStore.statementPrefix || "SP HVACSUPPLIES",
    statementExampleCode: String(rawStore.statementExampleCode || "9341"),
    emailSubject: rawStore.emailSubject || "Verification Required for Your Recent Order",
    emailCategory: rawStore.emailCategory || "Need Verification",
    customEmailBody: rawStore.customEmailBody || "",
    emailSignatureHtml: rawStore.emailSignatureHtml || readOptionalFile(rawStore.emailSignatureHtmlFile || ""),
  };
}

function loadStoresFromFile(defaultApiVersion) {
  if (!fs.existsSync(STORES_CONFIG_PATH)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STORES_CONFIG_PATH, "utf8"));
    const stores = Array.isArray(parsed?.stores) ? parsed.stores : [];
    return stores
      .map((store) => normalizeStore(store, parsed?.defaultApiVersion || defaultApiVersion))
      .filter((store) => Boolean(store.shopDomain));
  } catch (error) {
    console.error(`Failed to parse stores.config.json: ${String(error?.message || error)}`);
    return [];
  }
}

function loadStoresFromJsonEnv(defaultApiVersion) {
  const raw = process.env.STORES_CONFIG_JSON || "";
  if (!raw.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    const stores = Array.isArray(parsed?.stores) ? parsed.stores : [];
    return stores
      .map((store) => normalizeStore(store, parsed?.defaultApiVersion || defaultApiVersion))
      .filter((store) => Boolean(store.shopDomain));
  } catch (error) {
    console.error(`Failed to parse STORES_CONFIG_JSON: ${String(error?.message || error)}`);
    return [];
  }
}

function loadStoreFromEnv(defaultApiVersion) {
  const local = loadLocalShopifyConfig();
  const shopDomain = normalizeShopDomain(process.env.SHOPIFY_SHOP_DOMAIN || local.shop_url || "");

  if (!shopDomain) {
    return [];
  }

  return [
    normalizeStore(
      {
        shopDomain,
        apiVersion: process.env.SHOPIFY_API_VERSION || local.api_ver || defaultApiVersion,
        adminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || local.token || "",
        apiKey: process.env.SHOPIFY_API_KEY || "",
        apiSecret: process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_APP_SECRET || "",
        webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_APP_SECRET || "",
        gmailUser: process.env.GMAIL_USER || "",
        gmailAppPassword: process.env.GMAIL_APP_PASSWORD || "",
        fromEmail: process.env.FROM_EMAIL || process.env.GMAIL_USER || "",
        supportEmail: process.env.SUPPORT_EMAIL || process.env.FROM_EMAIL || process.env.GMAIL_USER || "",
        brandName: process.env.BRAND_NAME || "Hvac Supplies",
        orderCodePrefix: process.env.ORDER_CODE_PREFIX || "",
        statementPrefix: process.env.STATEMENT_PREFIX || "SP HVACSUPPLIES",
        statementExampleCode: process.env.STATEMENT_EXAMPLE_CODE || "9341",
        emailSubject: process.env.EMAIL_SUBJECT || "Verification Required for Your Recent Order",
        emailCategory: process.env.EMAIL_CATEGORY || "Need Verification",
        emailSignatureHtml: process.env.EMAIL_SIGNATURE_HTML || "",
      },
      defaultApiVersion,
    ),
  ];
}

export function loadStoresConfig() {
  const defaultApiVersion = process.env.SHOPIFY_API_VERSION || "2026-01";
  const storesFromEnvJson = loadStoresFromJsonEnv(defaultApiVersion);
  const storesFromFile = loadStoresFromFile(defaultApiVersion);
  const activeStores = storesFromEnvJson.length
    ? storesFromEnvJson
    : storesFromFile.length
      ? storesFromFile
      : loadStoreFromEnv(defaultApiVersion);

  const storeMap = new Map(activeStores.map((store) => [store.shopDomain, store]));
  return {
    stores: activeStores,
    storeMap,
  };
}

export function resolveStore(storeMap, inputShopDomain) {
  const normalized = normalizeShopDomain(inputShopDomain || "");
  if (!normalized) {
    return null;
  }
  return storeMap.get(normalized) || null;
}
