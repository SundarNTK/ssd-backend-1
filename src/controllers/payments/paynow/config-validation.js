/**
 * Everything PAYNOW_MODE=production needs, checked in two layers:
 *
 *   productionConfigProblems()  — pure and synchronous: are the settings
 *       present and sensible? Used on every QR request as a last guard.
 *   assertPaynowReadyAtStartup() — also touches the disk: do the PGP key
 *       files exist and parse, and (jar engine) are the jar and Java there?
 *       Called once from server.js; a production server that fails it does
 *       not start, so a half-configured PayNow can never reach a customer.
 *
 * The list of required fields is the set this codebase's own QR builder
 * needs. It is NOT yet confirmed against DBS's specification — the PayNow
 * team may add or drop fields (see docs/paynow-integration.md, "Pending").
 */
const fs = require("fs");
const env = require("../../../config/env");
const { getPaynowMode } = require("./mode");
const { resolveKeyPaths } = require("./keys");

const PRODUCTION_REQUIRED_FIELDS = [
  "PAYNOW_MERCHANT_CATEGORY_CODE",
  "PAYNOW_TXN_CURRENCY",
  "PAYNOW_COUNTRY_CODE",
  "PAYNOW_MERCHANT_NAME",
  "PAYNOW_MERCHANT_CITY",
  "PAYNOW_GLOBAL_UNIQUE_ID",
  "PAYNOW_PROXY_TYPE",
  "PAYNOW_PROXY_VALUE",
  "PAYNOW_EDITABLE_AMOUNT",
  "PAYNOW_POINT_OF_INITIATION",
];

const PRODUCTION_ENGINES = ["jar", "native"];
const EXPIRY_FORMATS = ["date", "datetime"];

/** "java" is the old name for "jar". */
const normalizeEngine = (value) => (value === "java" ? "jar" : value);
const productionEngine = (config = env) => normalizeEngine(config.PAYNOW_QR_ENGINE);

function productionConfigProblems(config = env) {
  const problems = [];

  const missing = PRODUCTION_REQUIRED_FIELDS.filter((key) => !String(config[key] ?? "").trim());
  if (missing.length > 0) problems.push(`missing ${missing.join(", ")}`);

  if (!PRODUCTION_ENGINES.includes(productionEngine(config))) {
    problems.push(`PAYNOW_QR_ENGINE must be "jar" or "native" (got "${config.PAYNOW_QR_ENGINE || ""}")`);
  }
  if (!config.PAYNOW_CREDENTIALS_ARE_SSD_OWN) {
    problems.push("PAYNOW_CREDENTIALS_ARE_SSD_OWN is not true — the merchant details and keys must be the temple's own, not borrowed");
  }
  if (!EXPIRY_FORMATS.includes(config.PAYNOW_PROXY_EXPIRY_FORMAT)) {
    problems.push(`PAYNOW_PROXY_EXPIRY_FORMAT must be "date" or "datetime" (got "${config.PAYNOW_PROXY_EXPIRY_FORMAT}")`);
  }
  return problems;
}

/** Non-fatal observations worth printing at startup. */
function productionConfigWarnings(config = env) {
  const warnings = [];
  if (String(config.PAYNOW_EDITABLE_AMOUNT) !== "0") {
    warnings.push('PAYNOW_EDITABLE_AMOUNT is not "0" — a payer could change the amount; the confirmation would then be rejected but the money would already have moved');
  }
  if (String(config.PAYNOW_MERCHANT_NAME || "").length > 25) {
    warnings.push("PAYNOW_MERCHANT_NAME is longer than 25 characters and will be cut in the QR");
  }
  if (String(config.PAYNOW_MERCHANT_CITY || "").length > 15) {
    warnings.push("PAYNOW_MERCHANT_CITY is longer than 15 characters and will be cut in the QR");
  }
  return warnings;
}

/** Sync guard used on every request in production mode. */
function assertProductionConfigured(config = env) {
  const problems = productionConfigProblems(config);
  if (problems.length > 0) {
    throw `PayNow is not configured for production — ${problems.join("; ")}. See docs/paynow-integration.md.`;
  }
}

async function keyFileProblems() {
  const openpgp = require("openpgp");
  const { publicKeyPath, privateKeyPath } = resolveKeyPaths();
  const problems = [];

  if (!fs.existsSync(publicKeyPath)) problems.push(`DBS public key not found at ${publicKeyPath}`);
  else {
    try {
      await openpgp.readKey({ armoredKey: fs.readFileSync(publicKeyPath, "utf8") });
    } catch (error) {
      problems.push(`DBS public key at ${publicKeyPath} is not a readable PGP key (${error.message})`);
    }
  }

  if (!fs.existsSync(privateKeyPath)) problems.push(`private key not found at ${privateKeyPath}`);
  else {
    try {
      const privateKey = await openpgp.readPrivateKey({ armoredKey: fs.readFileSync(privateKeyPath, "utf8") });
      if (!privateKey.isDecrypted()) problems.push(`private key at ${privateKeyPath} is passphrase-protected; the ICN decoder does not support a passphrase`);
    } catch (error) {
      problems.push(`private key at ${privateKeyPath} is not a readable PGP private key (${error.message})`);
    }
  }
  return problems;
}

async function jarProblems() {
  const path = require("path");
  const { findJavaExecutable } = require("./generate-qr/find-java");
  const problems = [];
  const jarPath = path.join(__dirname, "../../../../public/Paynowsdk/dist/PayQRSDK.jar");
  if (!fs.existsSync(jarPath)) problems.push("PayQRSDK.jar not found in public/Paynowsdk/dist");
  try {
    await findJavaExecutable();
  } catch {
    problems.push("Java was not found on this server (needed for PAYNOW_QR_ENGINE=jar)");
  }
  return problems;
}

/**
 * Called once at startup. Resolves with a one-line summary to log, or throws
 * an Error listing everything wrong — which stops the server from starting.
 */
async function assertPaynowReadyAtStartup(config = env) {
  const mode = getPaynowMode();
  if (mode === "disabled") return "PayNow is OFF on this server.";
  if (mode === "manual") return "PayNow mode: manual - no QR, payments are confirmed by hand.";
  if (mode === "development") return "PayNow mode: development — mock QR codes (not payable) and mock confirmation only.";

  const problems = productionConfigProblems(config);
  problems.push(...(await keyFileProblems()));
  if (productionEngine(config) === "jar") problems.push(...(await jarProblems()));

  if (problems.length > 0) {
    throw new Error(
      `PAYNOW_MODE=production but PayNow is not ready:\n  - ${problems.join("\n  - ")}\nFix these, or unset PAYNOW_MODE to keep PayNow off.`
    );
  }
  const warnings = productionConfigWarnings(config).map((w) => `\n  warning: ${w}`).join("");
  return `PayNow mode: production (engine: ${productionEngine(config)}).${warnings}`;
}

module.exports = {
  PRODUCTION_REQUIRED_FIELDS,
  productionConfigProblems,
  productionConfigWarnings,
  assertProductionConfigured,
  assertPaynowReadyAtStartup,
  productionEngine,
};
