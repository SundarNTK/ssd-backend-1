/**
 * Which PayNow behaviour this server runs, decided by PAYNOW_MODE (config/env.js).
 *
 *   development → mock QR + mock confirmation; no real payment can happen
 *   production  → the real PayNow integration, validated at startup
 *   disabled    → PayNow is off (PAYNOW_MODE unset while NODE_ENV=production)
 *
 * An unset PAYNOW_MODE is "development" on a developer machine but "disabled"
 * on a production-built server, so a server nobody set up for PayNow cannot
 * show a QR at all. A value that is set but not one of the two names is an
 * error, never a silent default — a typo like "prod" must not quietly turn
 * the real integration into something else.
 */
const env = require("../../../config/env");

const MODES = ["development", "production"];

function getPaynowMode() {
  const raw = String(env.PAYNOW_MODE || "").trim().toLowerCase();
  if (MODES.includes(raw)) return raw;
  if (raw) {
    throw `PAYNOW_MODE must be "development" or "production" (got "${raw}"). Leave it unset to keep PayNow off on a production server.`;
  }
  return env.NODE_ENV === "production" ? "disabled" : "development";
}

const isDevelopment = () => getPaynowMode() === "development";
const isProduction = () => getPaynowMode() === "production";

module.exports = { getPaynowMode, isDevelopment, isProduction, MODES };
