const tokenCache = new Map();

export async function getAdminAccessToken(store, options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);

  if (store.adminAccessToken && !forceRefresh) {
    return store.adminAccessToken;
  }

  const cacheKey = store.shopDomain;
  const cached = tokenCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  if (!store.apiKey || !store.apiSecret) {
    throw new Error(`Missing Admin API access token and API key/secret for ${store.shopDomain}`);
  }

  const endpoint = `https://${store.shopDomain}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: store.apiKey,
    client_secret: store.apiSecret,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const raw = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.access_token) {
    if (payload?.error === "shop_not_permitted") {
      throw new Error(
        `Token request failed for ${store.shopDomain}: shop is not permitted for client_credentials. Use a valid adminAccessToken for this store, or create/reinstall an app that supports client_credentials.`,
      );
    }

    if (!payload) {
      const preview = raw.slice(0, 200).replace(/\s+/g, " ").trim();
      throw new Error(
        `Token request failed for ${store.shopDomain}: non-JSON response (${response.status}). Preview: ${preview}`,
      );
    }

    throw new Error(`Token request failed for ${store.shopDomain}: ${JSON.stringify(payload)}`);
  }

  const expiresIn = Number(payload?.expires_in || 86_399);
  const expiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;

  tokenCache.set(cacheKey, {
    accessToken: payload.access_token,
    expiresAt,
  });

  return payload.access_token;
}

export async function shopifyGraphQL(store, query, variables = {}) {
  const token = await getAdminAccessToken(store);
  const endpoint = `https://${store.shopDomain}/admin/api/${store.apiVersion}/graphql.json`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Shopify GraphQL failed for ${store.shopDomain} (${response.status}): ${JSON.stringify(payload)}`);
  }

  if (payload.errors?.length) {
    throw new Error(`Shopify GraphQL errors for ${store.shopDomain}: ${JSON.stringify(payload.errors)}`);
  }

  return payload.data;
}
