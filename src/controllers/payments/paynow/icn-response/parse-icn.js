/**
 * Reads the JSON inside a decrypted PayNow ICN and decides what it says.
 * Pure — no I/O — so the rules can be tested exhaustively.
 *
 * IMPORTANT: decoding a message is not proof that money arrived. By the time
 * this runs, decrypt-response.js has already refused anything not signed by
 * DBS; this step then checks the CONTENT is usable, and the dispatcher
 * checks it against the pending payment we created (amount, expiry, not
 * already paid).
 *
 * The field names and the "settled" rule below follow what HEB's working
 * Payment-Service does with DBS's ICNs (txnInfo.customerReference,
 * txnInfo.txnRefId, txnInfo.amtDtls.txnAmt). They are NOT yet confirmed
 * against DBS's own specification for SSD — see docs/paynow-integration.md
 * ("Pending from the PayNow team"). Where DBS may differ, this file is the
 * one place to change.
 */

// 3-letter origin prefix + 10 characters, as minted by common/utils/payment-reference.js
const REFERENCE_PATTERN = /^[A-Z0-9]{13}$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * @param {string} decryptedJson
 * @returns {{
 *   status: "settled" | "pending",
 *   customerReference: string,
 *   txnRefId: string | null,
 *   amount: number | null,
 *   currency: string | null,
 *   messageId: string | null,
 *   timestamp: string | null,
 * }}
 * @throws {string} a readable reason when the message cannot be used
 */
function parseIcn(decryptedJson) {
  let payload;
  try {
    payload = JSON.parse(decryptedJson);
  } catch {
    throw "PayNow ICN rejected: the decrypted message is not valid JSON.";
  }
  if (!isObject(payload)) throw "PayNow ICN rejected: the decrypted message is not a JSON object.";

  const txnInfo = payload.txnInfo;
  if (!isObject(txnInfo)) throw "PayNow ICN rejected: the message carried no txnInfo.";

  const customerReference = typeof txnInfo.customerReference === "string" ? txnInfo.customerReference.trim() : "";
  if (!customerReference) throw "PayNow ICN rejected: the message carried no customerReference, so the payment cannot be identified.";
  if (!REFERENCE_PATTERN.test(customerReference)) {
    throw `PayNow ICN rejected: customerReference "${customerReference.slice(0, 40)}" is not a payment reference this system issues.`;
  }

  const rawTxnRefId = txnInfo.txnRefId;
  const txnRefId = rawTxnRefId === undefined || rawTxnRefId === null || String(rawTxnRefId).trim() === "" ? null : String(rawTxnRefId).trim();

  const amtDtls = isObject(txnInfo.amtDtls) ? txnInfo.amtDtls : {};
  let amount = null;
  if (amtDtls.txnAmt !== undefined && amtDtls.txnAmt !== null && amtDtls.txnAmt !== "") {
    amount = Number(amtDtls.txnAmt);
    if (!Number.isFinite(amount) || amount <= 0) throw `PayNow ICN rejected: the amount "${amtDtls.txnAmt}" is not a positive number.`;
  }

  const currency = typeof amtDtls.txnCcy === "string" && amtDtls.txnCcy.trim() ? amtDtls.txnCcy.trim().toUpperCase() : null;
  if (currency && currency !== "SGD") throw `PayNow ICN rejected: the currency is ${currency}, only SGD is accepted.`;

  // HEB's rule: DBS only fills in txnRefId once the transfer has actually
  // completed; a notification can legitimately arrive before that.
  const status = txnRefId ? "settled" : "pending";

  // Never confirm money we cannot size: a settled message with no amount
  // would skip the amount check against the pending payment.
  if (status === "settled" && amount === null) {
    throw "PayNow ICN rejected: the message says the payment completed but carries no amount, so it cannot be checked against the order.";
  }

  const header = isObject(payload.header) ? payload.header : {};
  return {
    status,
    customerReference,
    txnRefId,
    amount,
    currency,
    messageId: header.msgId ? String(header.msgId) : null,
    timestamp: header.timeStamp ? String(header.timeStamp) : null,
  };
}

module.exports = { parseIcn, REFERENCE_PATTERN };
