require("dotenv").config();

function origin(value) {
  return String(value || "").replace(/\/$/, "");
}

/**
 * Every module reads config from here, never from process.env directly —
 * one place to see what the whole app depends on, and one place to add a
 * default when a new env var shows up.
 */
module.exports = {
  NODE_ENV: process.env.NODE_ENV || "development",
  // SSD-Backend is the merged Auth/Users/Roles/Customers/Masters/POS/Inventory/
  // Payments/Reports API (formerly User-Service + Catalog-Service + Payment-Service
  // + Notification-Service, four separate processes). One port for the whole thing.
  PORT: process.env.PORT || 5003,
  API_PREFIX: process.env.API_PREFIX || "/api/v1",
  // Comma-separated so both a Vercel production domain and its per-branch
  // preview domains can be allowed at once, e.g.
  // "https://ssd-admin.vercel.app,https://ssd-frontend-git-develop-xxx.vercel.app".
  // See app.js's cors() call, which splits this into an array.
  CORS_ORIGIN: process.env.CORS_ORIGIN || "http://localhost:3000",

  MONGO_URI: process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ssd-temple",

  JWT_SECRET: process.env.JWT_SECRET || "dev-only-insecure-secret-change-me",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "8h",

  BCRYPT_COST: Number(process.env.BCRYPT_COST || 12),

  ACTIVATION_TOKEN_TTL_HOURS: Number(process.env.ACTIVATION_TOKEN_TTL_HOURS || 48),
  RESET_TOKEN_TTL_MINUTES: Number(process.env.RESET_TOKEN_TTL_MINUTES || 30),
  MOBILE_OTP_TTL_MINUTES: Number(process.env.MOBILE_OTP_TTL_MINUTES || 5),

  // Staff activation and password-reset links. Customer links use CUSTOMER_APP_URL.
  ADMIN_APP_URL: origin(process.env.ADMIN_APP_URL || "http://localhost:5001"),
  // Devotee activation and password-reset links. Falls back to the admin
  // origin when unset, so a local setup with one frontend still works.
  CUSTOMER_APP_URL: origin(process.env.CUSTOMER_APP_URL || process.env.ADMIN_APP_URL || "http://localhost:5001"),

  // The email header logo. A `localhost` ADMIN_APP_URL can never be reached
  // by a real mail client (Gmail/Outlook fetch images through their own
  // servers, not the developer's machine), so this is pinned to a permanent
  // Cloudinary URL instead — works identically in local dev, on Render, and
  // after the AWS move. Override only if the logo asset itself changes.
  EMAIL_LOGO_URL:
    process.env.EMAIL_LOGO_URL ||
    "https://res.cloudinary.com/dfh7upn1f/image/upload/v1787328992/ssd-temple/branding/ssd-full-logo.png",

  /**
   * DRY_RUN=true (the default) logs every outgoing email/SMS to the console
   * and to /logs instead of actually calling the provider — exactly what's
   * needed while these are still HEB's placeholder keys, before the real
   * SSD temple credentials are dropped in.
   */
  DRY_RUN_NOTIFICATIONS: (process.env.DRY_RUN_NOTIFICATIONS ?? "true") === "true",

  // Sender order, see common/mailer/transport.js: Brevo's HTTP API when BREVO_API_KEY is set
  // (Gmail SMTP is blocked on Render's free tier), then Gmail SMTP via nodemailer when GMAIL_* is
  // set (local dev), otherwise Amazon SES. The DRY_RUN_NOTIFICATIONS gate applies to all of them.
  // On AWS leave BREVO_* / GMAIL_* empty: SES then uses the EC2 instance role, no keys.
  // SENDER_EMAIL_ID must be a verified SES identity (an address or a domain) in AWS_REGION.
  AWS_REGION: process.env.AWS_REGION || "ap-southeast-1",
  // Outgoing emails are spaced out so a burst never exceeds the provider's sending speed
  // (SES allows 1/second in the sandbox, 14/second at first once approved). Optional.
  EMAIL_MAX_PER_SECOND: Math.max(1, Number(process.env.EMAIL_MAX_PER_SECOND) || 5),
  BREVO_API_KEY: process.env.BREVO_API_KEY || "",
  GMAIL_USER: process.env.GMAIL_USER || "",
  GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD || "",
  SENDER_EMAIL_ID: process.env.SENDER_EMAIL_ID || "no-reply@example-temple.org",

  // Image uploads — see common/utils/storage.js and common/middleware/upload.js. Never local disk.
  // S3_BUCKET set = Amazon S3 (EC2 instance role); empty = Cloudinary (local dev / Render).
  // S3_PUBLIC_BASE_URL is optional: a CloudFront domain; blank = the bucket's own https address.
  S3_BUCKET: process.env.S3_BUCKET || "",
  S3_PUBLIC_BASE_URL: process.env.S3_PUBLIC_BASE_URL || "",
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",

  // SMS — placeholders only; nothing in the Day-1 auth flow sends an SMS yet
  // (mobile-change OTP arrives later per the build sequence), but the env
  // shape is reserved now so the notification-worker can reuse it unchanged.
  SMS_SENDER_ID: process.env.SMS_SENDER_ID || "SSDTEMPLE",

  // Seed script — the default entity every user/master belongs to today.
  DEFAULT_ENTITY_CODE: process.env.DEFAULT_ENTITY_CODE || "SST",
  SEED_SUPER_ADMIN_NAME: process.env.SEED_SUPER_ADMIN_NAME || "Temple System Admin",
  SEED_SUPER_ADMIN_EMAIL: (process.env.SEED_SUPER_ADMIN_EMAIL || "superadmin@example-temple.org").toLowerCase(),

  /**
   * PayNow (DBS PayNow Corporate) — QR generation + ICN webhook. No real
   * fallback values here on purpose, unlike EMAIL_LOGO_URL/DEFAULT_ENTITY_CODE
   * above — see docs/paynow-integration.md for the full picture, but in
   * short: these values (PAYNOW_MERCHANT_NAME, PAYNOW_PROXY_VALUE
   * especially) determine which bank account a scanned QR's money actually
   * goes to, so nothing here should default to a real value baked into
   * source — only an explicit .env entry, set on the deploying machine,
   * should ever put a live value here. Every field is required at
   * QR-generation time; controllers/payments/paynow/generate-qr throws a
   * clear "PayNow is not configured" error rather than silently generating
   * a broken QR if any of these is empty.
   */
  PAYNOW_CREDENTIALS_ARE_SSD_OWN: (process.env.PAYNOW_CREDENTIALS_ARE_SSD_OWN ?? "false") === "true",
  /**
   * Integration mode — see controllers/payments/paynow/mode.js.
   *   "development" → mock QR (a clearly fake, non-payable merchant) and the
   *                   mock-confirmation route; no real money can move.
   *   "production"  → the real PayNow integration. Every PAYNOW_* value below
   *                   is validated at startup and the server refuses to start
   *                   if one is missing — it never falls back to a mock.
   *   (unset)       → "development" outside NODE_ENV=production, and
   *                   "disabled" inside it, so a server that was never set up
   *                   for PayNow cannot show a QR at all.
   */
  PAYNOW_MODE: (process.env.PAYNOW_MODE || "").trim().toLowerCase(),
  /**
   * How a production QR is built (ignored in development mode).
   *   "jar"    → shells out to DBS's PayQRSDK.jar (needs a JRE and the jar
   *              under public/Paynowsdk/dist). "java" is accepted as an alias.
   *   "native" → builds the same payload in JS (build-payload.js) and draws it
   *              with the `qrcode` package. Its output has been checked
   *              byte-for-byte against the jar's, but whether DBS accepts it
   *              for production is still to be confirmed with them.
   * Production must name one explicitly; there is no default.
   */
  PAYNOW_QR_ENGINE: (process.env.PAYNOW_QR_ENGINE || "").trim().toLowerCase(),
  // Tag 00 of the QR payload. The EMVCo spec says "01"; DBS's own jar writes
  // "00". Defaults to what the jar writes — confirm with DBS.
  PAYNOW_PAYLOAD_FORMAT_INDICATOR: process.env.PAYNOW_PAYLOAD_FORMAT_INDICATOR || "00",
  // Tag 26.04 (proxy expiry): "datetime" = YYYYMMDDHHmmss (what the jar
  // writes), "date" = YYYYMMDD. Confirm with DBS.
  PAYNOW_PROXY_EXPIRY_FORMAT: process.env.PAYNOW_PROXY_EXPIRY_FORMAT || "datetime",
  PAYNOW_PROXY_EXPIRY_DAYS: Number(process.env.PAYNOW_PROXY_EXPIRY_DAYS) || 365,
  PAYNOW_MERCHANT_CATEGORY_CODE: process.env.PAYNOW_MERCHANT_CATEGORY_CODE || "",
  PAYNOW_TXN_CURRENCY: process.env.PAYNOW_TXN_CURRENCY || "",
  PAYNOW_COUNTRY_CODE: process.env.PAYNOW_COUNTRY_CODE || "",
  PAYNOW_MERCHANT_NAME: process.env.PAYNOW_MERCHANT_NAME || "",
  PAYNOW_MERCHANT_CITY: process.env.PAYNOW_MERCHANT_CITY || "",
  PAYNOW_GLOBAL_UNIQUE_ID: process.env.PAYNOW_GLOBAL_UNIQUE_ID || "",
  PAYNOW_PROXY_TYPE: process.env.PAYNOW_PROXY_TYPE || "",
  PAYNOW_PROXY_VALUE: process.env.PAYNOW_PROXY_VALUE || "",
  PAYNOW_EDITABLE_AMOUNT: process.env.PAYNOW_EDITABLE_AMOUNT || "",
  PAYNOW_POINT_OF_INITIATION: process.env.PAYNOW_POINT_OF_INITIATION || "",
  PAYNOW_QR_COLOR_CODE: process.env.PAYNOW_QR_COLOR_CODE || "",
  // Not read at request time — DBS calls this URL directly, configured on
  // their side. Kept here purely so there's one place in the app that
  // states what that URL currently is, for whoever next talks to DBS.
  PAYNOW_ICN_RESPONSE_URL: process.env.PAYNOW_ICN_RESPONSE_URL || "",
  // Paths to the DBS key material — see public/Paynowsdk's own note (and
  // .gitignore) for why these files are local-only, not committed.
  PAYNOW_PRIVATE_KEY_PATH: process.env.PAYNOW_PRIVATE_KEY_PATH || "public/Paynowsdk/dbs-paynow-private-SECRET.asc",
  PAYNOW_PUBLIC_KEY_PATH: process.env.PAYNOW_PUBLIC_KEY_PATH || "public/Paynowsdk/dbs-paynow-public-uat.asc",

  /**
   * NETS terminal/EXE -> backend confirmation — see
   * controllers/payments/nets/callback. The Nets-Service EXE sends this
   * same value as X-Nets-Callback-Secret; this route is mounted
   * unauthenticated (no admin JWT — the EXE is a machine, not a logged-in
   * operator) the same way PayNow's ICN webhook is, and this header is what
   * stands in for DBS's PGP signature there.
   *
   * Used to be a per-install Configuration-page field on the EXE side too,
   * matched against this env var by hand — any time one side changed
   * without the other, every NETS payment confirmation silently broke until
   * someone noticed the error. Now hardcoded to the same literal string on
   * both sides (source/amq/ssdBackendClient.js's NETS_CALLBACK_SECRET
   * constant) so there's nothing left to keep in sync; .env can still
   * override it here if a real secret is ever wanted, but nothing requires
   * it to be set.
   */
  NETS_CALLBACK_SECRET: process.env.NETS_CALLBACK_SECRET || "sdfsfdsfadfsafs",

  /**
   * IP allow list for the admin and POS sites — see controllers/ip-access and
   * docs/ip-access-control.md. The list itself and its mode (off / report /
   * enforce) are edited on screen by a System Admin and live in the database.
   * These two exist OUTSIDE the screen on purpose, as the way back in:
   *
   * IP_ACCESS_FORCE_OFF=true      emergency switch: the restriction is off
   *                               whatever the screen says. Set it through
   *                               Session Manager and restart the backend.
   * IP_ACCESS_ALWAYS_ALLOWED      comma-separated addresses/ranges that are
   *                               always let in (the temple's address, an
   *                               administrator's) and cannot be removed from
   *                               the screen, so a mistake there can never
   *                               lock everybody out.
   */
  IP_ACCESS_FORCE_OFF: (process.env.IP_ACCESS_FORCE_OFF ?? "false") === "true",
  IP_ACCESS_ALWAYS_ALLOWED: process.env.IP_ACCESS_ALWAYS_ALLOWED || "",
};