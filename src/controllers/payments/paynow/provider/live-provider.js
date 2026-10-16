/**
 * PAYNOW_MODE=production — the real integration. Uses only the merchant
 * values from the environment and the engine named in PAYNOW_QR_ENGINE.
 * There is deliberately no catch-and-fall-back here: if the jar fails or a
 * value is missing the request fails with that reason, and the pending
 * payment is cancelled by the caller. A production server never shows a
 * mock QR and never treats a payment as made without a verified ICN.
 */
const env = require("../../../../config/env");
const { generateViaJar, generateViaNative } = require("../generate-qr/engines");
const { assertProductionConfigured, productionEngine } = require("../config-validation");

module.exports = {
  mode: "production",
  assertReady() {
    assertProductionConfigured(env);
  },
  async generateQr(referenceId, amount) {
    assertProductionConfigured(env);
    const engine = productionEngine(env);
    const qrImage = engine === "jar" ? await generateViaJar(referenceId, amount, env) : await generateViaNative(referenceId, amount, env);
    return { qrImage, engine };
  },
};
