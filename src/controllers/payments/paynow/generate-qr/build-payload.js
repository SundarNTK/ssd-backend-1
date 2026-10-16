/**
 * Builds a real EMVCo Merchant-Presented QR Code payload string (the same
 * open TLV format PayNow, PromptPay, and the other ASEAN QR schemes all
 * use) entirely in JS — no Java, no bank SDK, no network call. This is the
 * "dummy" QR generation path: the QR is structurally a genuine PayNow QR
 * (real merchant/proxy fields, the order's real amount, the order's real
 * referenceId as the merchant reference), it's just not run through DBS's
 * own certified signing pipeline (PayQRSDK.jar — still available, see
 * runQrJar() in ./index.js, for whenever that's actually wired up with
 * real Java + real DBS credentials). Toggle between the two via
 * PAYNOW_QR_ENGINE (see config/env.js and ./index.js).
 *
 * EMVCo TLV field reference (the ones this uses):
 *   00  Payload Format Indicator        ("01")
 *   01  Point of Initiation Method      ("11" static / "12" dynamic)
 *   26  Merchant Account Info (PayNow)  — sub-fields:
 *         00  Globally Unique Identifier ("SG.PAYNOW")
 *         01  Proxy Type                 ("0" mobile / "1" NRIC / "2" UEN)
 *         02  Proxy Value
 *         03  Editable Amount indicator  ("0"/"1")
 *         04  Proxy Expiry Date          (YYYYMMDD)
 *   52  Merchant Category Code
 *   53  Transaction Currency             (ISO 4217 numeric, "702" = SGD)
 *   54  Transaction Amount               (omitted entirely for an
 *                                          amount-editable QR with no
 *                                          fixed amount)
 *   58  Country Code                     ("SG")
 *   59  Merchant Name                    (max 25 chars per spec)
 *   60  Merchant City                    (max 15 chars per spec)
 *   62  Additional Data Field Template   — sub-field 01: Bill Number,
 *                                          carries the order's referenceId
 *   63  CRC                              (CRC-16/CCITT-FALSE over
 *                                          everything before it, including
 *                                          this field's own "6304" tag+length)
 */

const MERCHANT_NAME_MAX_LENGTH = 25;
const MERCHANT_CITY_MAX_LENGTH = 15;

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final XOR — the exact variant EMVCo's spec requires. */
function crc16CcittFalse(input) {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** One TLV field: 2-digit id + 2-digit length + value. */
function tlv(id, value) {
  const v = String(value);
  return `${id}${String(v.length).padStart(2, "0")}${v}`;
}

function buildMerchantAccountInfo({ globalUniqueId, proxyType, proxyValue, editableAmount, expiryDate }) {
  let s = tlv("00", globalUniqueId) + tlv("01", proxyType) + tlv("02", proxyValue) + tlv("03", editableAmount);
  if (expiryDate) s += tlv("04", expiryDate);
  return s;
}

function buildAdditionalData({ referenceId }) {
  return tlv("01", referenceId);
}

/**
 * The Proxy Expiry Date sub-field, local time, N days from now.
 *   "date"     → YYYYMMDD         (the EMVCo/SGQR spec wording)
 *   "datetime" → YYYYMMDDHHmmss   (what DBS's own PayQRSDK.jar writes)
 * Which one DBS wants is an open question for them — see
 * docs/paynow-integration.md — so it is configuration, not a constant.
 */
function formatExpiryDate(daysFromNow, format = "date", now = Date.now()) {
  const date = new Date(now + daysFromNow * 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  if (format === "datetime") return `${day}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return day;
}

/**
 * @param {object} config  every PAYNOW_* field from config/env.js, plus:
 * @param {string} config.referenceId  the pos_order's 13-char reference id — becomes the QR's merchant reference (EMVCo tag 62.01)
 * @param {number} config.amount       the amount this QR is for
 * @param {string} [config.payloadFormatIndicator]  tag 00; "01" per the spec (default), "00" is what DBS's jar writes
 * @param {"date"|"datetime"} [config.expiryFormat] tag 26.04 format, see formatExpiryDate (default "date")
 * @param {number} [config.expiryDays]              how far ahead the proxy expiry is set (default 365)
 * @param {string} [config.expiryDate]              an exact tag 26.04 value; overrides the two above (used by tests)
 * @returns {string} the full EMVCo payload string, ready to render as a QR code
 */
function buildPaynowQrPayload(config) {
  const merchantName = String(config.merchantName).slice(0, MERCHANT_NAME_MAX_LENGTH);
  const merchantCity = String(config.merchantCity).slice(0, MERCHANT_CITY_MAX_LENGTH);
  const expiryDate = config.expiryDate || formatExpiryDate(config.expiryDays || 365, config.expiryFormat || "date");

  let payload = "";
  payload += tlv("00", config.payloadFormatIndicator || "01");
  payload += tlv("01", config.pointOfInitiation);
  payload += tlv(
    "26",
    buildMerchantAccountInfo({
      globalUniqueId: config.globalUniqueId,
      proxyType: config.proxyType,
      proxyValue: config.proxyValue,
      editableAmount: config.editableAmount,
      expiryDate,
    })
  );
  payload += tlv("52", config.merchantCategoryCode);
  payload += tlv("53", config.currency);
  if (config.amount != null) payload += tlv("54", Number(config.amount).toFixed(2));
  payload += tlv("58", config.countryCode);
  payload += tlv("59", merchantName);
  payload += tlv("60", merchantCity);
  payload += tlv("62", buildAdditionalData({ referenceId: config.referenceId }));
  payload += "6304"; // CRC field's own tag+length, included in what gets checksummed
  return payload + crc16CcittFalse(payload);
}

module.exports = { buildPaynowQrPayload, crc16CcittFalse, tlv, formatExpiryDate };
