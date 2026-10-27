/**
 * Which PayNow behaviour this server runs, decided by PAYNOW_MODE (config/env.js).
 *
 *   development → mock QR + mock confirmation; no real payment can happen
 *   production  → the real PayNow integration, validated at startup
 *   manual      → no QR and no bank connection: a PayNow payment is confirmed by hand (the cashier enters the bank's
 *                 transaction reference). The default on a production-built server.
 *   disabled    → kept for completeness; nothing selects it today
 *
 * An unset PAYNOW_MODE is "development" on a developer machine but "manual"
 * on a production-built server, so a server nobody set up for the real PayNow
 * integration still takes PayNow payments by manual confirmation, and never
 * shows a mock QR or accepts a mock confirmation. A value that is set but not one of the two names is an
 * error, never a silent default — a typo like "prod" must not quietly turn
 * the real integration into something else.
 */
const env = require("../../../config/env");

const MODES = ["development", "production", "manual"];

function getPaynowMode() {
  const raw = String(env.PAYNOW_MODE || "").trim().toLowerCase();
  if (MODES.includes(raw)) return raw;
  if (raw) {
    throw `PAYNOW_MODE must be "development", "production" or "manual" (got "${raw}"). Leave it unset to use manual confirmation on a production server.`;
  }
  return env.NODE_ENV === "production" ? "manual" : "development";
}

const isDevelopment = () => getPaynowMode() === "development";
const isProduction = () => getPaynowMode() === "production";

module.exports = { getPaynowMode, isDevelopment, isProduction, MODES };
