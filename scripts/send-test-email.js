import dotenv from "dotenv";
import nodemailer from "nodemailer";

dotenv.config();

const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const FROM_EMAIL = process.env.FROM_EMAIL || GMAIL_USER;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "sales@hvacsupplies.com";
const SEND_TO_OVERRIDE = process.env.SEND_TO_OVERRIDE || "";

const argTo = process.argv[2] || "";
const toEmail = argTo || SEND_TO_OVERRIDE;

if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !FROM_EMAIL) {
  console.error("Missing Gmail config. Set GMAIL_USER, GMAIL_APP_PASSWORD, FROM_EMAIL.");
  process.exit(1);
}

if (!toEmail) {
  console.error("Missing destination email. Set SEND_TO_OVERRIDE or pass one argument.");
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
});

const body = `Dear Customer,

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

await transporter.verify();
await transporter.sendMail({
  from: FROM_EMAIL,
  to: toEmail,
  subject: "Verification Required for Your Recent Order",
  text: body,
  headers: {
    "X-Category": "Need Verification",
  },
});

console.log(`Test email sent to ${toEmail}`);