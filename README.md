# Shopify Risk Verification Emailer

This service listens for Shopify order risk webhook events and sends a verification email from Gmail when an order is medium/high risk.

## What this does

- Receives `orders/risk_assessment_changed` webhooks from Shopify.
- Verifies the webhook HMAC using your webhook signing secret.
- Fetches the order's risk summary from Admin GraphQL.
- Sends the verification email to the customer when risk is `MEDIUM` or `HIGH`.
- Prevents duplicate sends per order by tracking sent order IDs in `sent-verification-orders.json`.

## Prerequisites

- Node.js 18+
- A Shopify custom app with `read_orders` scope
- Gmail account with 2-Step Verification enabled
- Gmail App Password (16-character) for SMTP
- Public HTTPS URL for webhook delivery (Cloudflare tunnel, ngrok, VPS, etc.)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy env template and fill values:

```bash
cp .env.example .env
```

3. Update `.env`:

- `SHOPIFY_SHOP_DOMAIN`: your `*.myshopify.com` domain
- `SHOPIFY_API_VERSION`: keep `2025-04` unless you upgrade
- `SHOPIFY_ADMIN_ACCESS_TOKEN`: Admin API token from your custom app
- `SHOPIFY_APP_SECRET`: API secret key (client secret) from your custom app, used for webhook HMAC validation
- `SHOPIFY_WEBHOOK_SECRET`: optional alias variable name for the same secret (if you prefer that naming)
- `WEBHOOK_CALLBACK_URL`: your public endpoint, e.g. `https://example.com/webhooks/orders-risk`
- `GMAIL_USER`: your Gmail address
- `GMAIL_APP_PASSWORD`: 16-character app password from Google
- `FROM_EMAIL`: sender address (normally same as Gmail user)
- `SUPPORT_EMAIL`: support contact shown in the message

`shopify_config.json` is also read automatically for `shop_url`, `api_ver`, and `token` if env vars are missing.

## Run

```bash
npm start
```

Health check:

```bash
GET /health
```

Webhook endpoint:

```bash
POST /webhooks/orders-risk
```

## Register the webhook

After your server is running at a public URL, register topic `ORDERS_RISK_ASSESSMENT_CHANGED`:

```bash
npm run register:webhook
```

If successful, it prints the created webhook subscription ID.

## How to get required credentials

### Shopify Admin API token

1. Shopify Admin -> `Settings` -> `Apps and sales channels`.
2. Open your custom app (or create one).
3. Configure Admin API scopes: add `read_orders`.
4. Install/reinstall app.
5. Copy `Admin API access token`.

### Shopify app secret (used for webhook HMAC)

1. In the same custom app, open webhook settings.
2. Copy the app API secret key (client secret).
3. Put it in `.env` as `SHOPIFY_APP_SECRET`.

### Gmail app password

1. Go to Google Account -> `Security`.
2. Enable `2-Step Verification`.
3. Open `App passwords`.
4. Create app password (Mail).
5. Use the generated 16-character value as `GMAIL_APP_PASSWORD`.

## Important security note

Your `shopify_config.json` currently stores a live Admin token. Treat it as compromised if it has been shared; rotate the token in Shopify and move secrets to `.env`.
