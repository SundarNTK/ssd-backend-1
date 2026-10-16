/**
 * PAYNOW_MODE=development — a QR that LOOKS like a PayNow QR so the whole
 * booking flow can be tried on screen, but that no banking app can pay: the
 * merchant is a fixed, clearly fake one, never the PAYNOW_* values from the
 * environment. Whatever those hold (even a real UEN copied in by mistake),
 * a development QR cannot move money.
 *
 * Confirming a mock payment goes through the mock-confirm route
 * (../mock-confirm.js), which runs the same code as a real ICN would.
 */
const { generateViaNative } = require("../generate-qr/engines");

const MOCK_MERCHANT = Object.freeze({
  PAYNOW_MERCHANT_CATEGORY_CODE: "0000",
  PAYNOW_TXN_CURRENCY: "702",
  PAYNOW_COUNTRY_CODE: "SG",
  PAYNOW_MERCHANT_NAME: "SSD TEST - DO NOT PAY",
  PAYNOW_MERCHANT_CITY: "Singapore",
  PAYNOW_GLOBAL_UNIQUE_ID: "SG.PAYNOW",
  PAYNOW_PROXY_TYPE: "2",
  // Not a valid UEN, so it can never match a real account.
  PAYNOW_PROXY_VALUE: "MOCKNOTAUEN",
  PAYNOW_EDITABLE_AMOUNT: "0",
  PAYNOW_POINT_OF_INITIATION: "12",
  PAYNOW_PAYLOAD_FORMAT_INDICATOR: "01",
  PAYNOW_PROXY_EXPIRY_FORMAT: "date",
  PAYNOW_PROXY_EXPIRY_DAYS: 1,
});

module.exports = {
  mode: "development",
  MOCK_MERCHANT,
  assertReady() {},
  async generateQr(referenceId, amount) {
    const qrImage = await generateViaNative(referenceId, amount, MOCK_MERCHANT);
    return { qrImage, engine: "mock" };
  },
};
