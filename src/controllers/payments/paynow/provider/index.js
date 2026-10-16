/**
 * The one interface the rest of the app uses for PayNow QR generation:
 *
 *   getPaynowProvider() → { mode, assertReady(), generateQr(referenceId, amount) → { qrImage, engine } }
 *
 * The mode (mode.js) picks the implementation, so pos-orders and the
 * generate-qr route stay the same whichever one runs. Resolved on every call
 * (not cached at load) so a changed PAYNOW_MODE is honoured by tests.
 */
const { getPaynowMode } = require("../mode");

function getPaynowProvider() {
  switch (getPaynowMode()) {
    case "production":
      return require("./live-provider");
    case "development":
      return require("./mock-provider");
    default:
      return require("./disabled-provider");
  }
}

module.exports = { getPaynowProvider };
