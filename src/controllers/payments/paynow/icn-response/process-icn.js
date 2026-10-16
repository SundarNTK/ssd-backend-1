/**
 * What happens to a decrypted ICN: parse it, route it to the payment it
 * belongs to, and keep a log row of the outcome. Shared by the real webhook
 * (index.js, after decrypt + signature check) and the development-only mock
 * (../mock-confirm.js), so the mock exercises exactly the code a real
 * notification would.
 *
 * Outcomes:
 *   settled   — payment confirmed now
 *   duplicate — this payment was already confirmed (a retry); nothing changes
 *   pending   — DBS says it has not completed yet; nothing is confirmed
 *   rejected  — unusable, or refused by the pending payment (wrong amount,
 *               expired, cancelled, unknown reference); thrown to the caller
 */
const { dispatchPaymentConfirmation } = require("../../dispatch");
const { PaynowIcnLog } = require("../../../../models/paynow-icn-logs");
const { parseIcn } = require("./parse-icn");

async function recordIcn(fields) {
  try {
    await PaynowIcnLog.create(fields);
  } catch (error) {
    // The log is an aid, not part of the payment — never fail a payment over it.
    console.error(">>> [paynow-icn] could not write the ICN log row:", error.message);
  }
}

/**
 * @param {string} decryptedJson
 * @param {{ source?: "dbs" | "mock" }} [options]
 * @returns {Promise<object>} `{ customerReference, status, ... }`
 */
async function processDecryptedIcn(decryptedJson, { source = "dbs" } = {}) {
  let icn;
  try {
    icn = parseIcn(decryptedJson);
  } catch (reason) {
    await recordIcn({ source, outcome: "rejected", error: String(reason) });
    throw reason;
  }

  const logBase = {
    source,
    customerReference: icn.customerReference,
    txnRefId: icn.txnRefId,
    amount: icn.amount,
    messageId: icn.messageId,
  };

  if (icn.status === "pending") {
    await recordIcn({ ...logBase, outcome: "pending" });
    return { customerReference: icn.customerReference, status: "pending" };
  }

  let result;
  try {
    result = await dispatchPaymentConfirmation(icn.customerReference, {
      amount: icn.amount,
      gatewayReference: icn.txnRefId,
      processedBy: null,
    });
  } catch (reason) {
    await recordIcn({ ...logBase, outcome: "rejected", error: typeof reason === "string" ? reason : reason?.message || "error" });
    throw reason;
  }

  await recordIcn({ ...logBase, outcome: result.alreadyProcessed ? "duplicate" : "settled" });
  return { customerReference: icn.customerReference, ...result };
}

module.exports = { processDecryptedIcn };
