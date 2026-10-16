/**
 * PayNow QR rendering, as seen by the rest of the app. Split out of the
 * generate-qr route so controllers/pos-orders can build a QR in-process
 * while creating an order without requiring the route (which itself
 * requires pos-orders) and forming a cycle.
 *
 * What actually happens depends on PAYNOW_MODE (../mode.js):
 *   development → a mock QR that cannot be paid       (../provider/mock-provider.js)
 *   production  → the real QR, by the engine in PAYNOW_QR_ENGINE (../provider/live-provider.js)
 *   disabled    → refuses                              (../provider/disabled-provider.js)
 * The low-level engines (jar / native) live in ./engines.js.
 */
const { getPaynowProvider } = require("../provider");

/** Throws a readable reason if PayNow cannot produce a QR on this server right now. */
function assertPaynowConfigured() {
  getPaynowProvider().assertReady();
}

/** The one entrypoint every caller uses: resolves to `{ qrImage, engine }`. */
async function renderQrImage(referenceId, amount) {
  return getPaynowProvider().generateQr(referenceId, amount);
}

module.exports = { assertPaynowConfigured, renderQrImage };
