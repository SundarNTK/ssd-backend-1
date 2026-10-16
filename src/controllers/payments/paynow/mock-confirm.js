/**
 * POST /payments/paynow/mock/icn  — development mode only.
 *
 * Stands in for DBS while there is no real PayNow connection: it builds an
 * ICN the way DBS would have, then runs it through the SAME code a real one
 * goes through after decryption (icn-response/process-icn.js), so the order
 * flips to paid, an already-paid order is recognised, an expired or
 * cancelled payment is refused, and so on — exactly as in production.
 *
 * What it skips is the PGP layer (nothing here is encrypted or signed),
 * which is why it must never exist in production: in any mode other than
 * "development" this route refuses to do anything. It also needs a signed-in
 * staff member with the same permission the POS counter's own payment
 * routes need.
 *
 * Scenarios (`scenario`, default "success"):
 *   success           the payment completes
 *   pending           DBS says "not completed yet" — nothing is confirmed
 *   duplicate         the same completion arrives twice — the 2nd is a no-op
 *   wrong_amount      the payer paid a different amount — refused
 *   expired           the QR's payment window had already closed — refused
 *   cancelled         the payment was cancelled before it arrived — refused
 *   unknown_reference a reference this system never issued — refused
 */
const Joi = require("joi");
const { responseHandler, exceptionHandler } = require("../../../utilities/handlers");
const { PosTransaction } = require("../../../models/pos-transactions");
const { getPaynowMode } = require("./mode");
const { processDecryptedIcn } = require("./icn-response/process-icn");

const SCENARIOS = ["success", "pending", "duplicate", "wrong_amount", "expired", "cancelled", "unknown_reference"];

const schema = Joi.object({
  referenceId: Joi.string().trim().length(13).required(),
  scenario: Joi.string().valid(...SCENARIOS).default("success"),
});

/** An ICN in the shape parse-icn.js reads — see that file for which fields matter. */
function buildMockIcn({ referenceId, amount, settled }) {
  return JSON.stringify({
    header: { msgId: `MOCK-${Date.now()}`, timeStamp: new Date().toISOString() },
    txnInfo: {
      customerReference: referenceId,
      ...(settled ? { txnRefId: `MOCK-TXN-${Date.now()}` } : {}),
      txnType: "PAYNOW",
      txnDate: new Date().toISOString().slice(0, 10),
      amtDtls: { txnCcy: "SGD", txnAmt: amount },
    },
  });
}

async function runIcn(icn) {
  try {
    const result = await processDecryptedIcn(icn, { source: "mock" });
    return { outcome: result.status === "pending" ? "pending" : result.alreadyProcessed ? "duplicate" : "settled", result };
  } catch (reason) {
    return { outcome: "rejected", reason: typeof reason === "string" ? reason : reason?.message || "error" };
  }
}

async function mockPaynowConfirm(req, res) {
  try {
    if (getPaynowMode() !== "development") {
      throw "Mock PayNow confirmation is only available in development mode (PAYNOW_MODE=development).";
    }
    const { error, value } = schema.validate(req.body ?? {});
    if (error) throw error.details[0].message;
    const { referenceId, scenario } = value;

    if (scenario === "unknown_reference") {
      const outcome = await runIcn(buildMockIcn({ referenceId: "ZZZ9999999999", amount: 1, settled: true }));
      return responseHandler({ res, response: { scenario, referenceId, ...outcome }, successMessage: `Mock ICN (${scenario}) processed.` });
    }

    const transaction = await PosTransaction.findOne(PosTransaction.notDeletedFilter({ referenceId }));
    if (!transaction) throw `No payment found for reference "${referenceId}" — generate a PayNow QR first and use that QR's reference.`;
    const amount = transaction.amount;

    let outcome;
    switch (scenario) {
      case "pending":
        outcome = await runIcn(buildMockIcn({ referenceId, amount, settled: false }));
        break;
      case "wrong_amount":
        outcome = await runIcn(buildMockIcn({ referenceId, amount: Number((amount + 1).toFixed(2)), settled: true }));
        break;
      case "expired":
        await PosTransaction.updateOne({ _id: transaction._id, paymentStatus: "pending" }, { $set: { expiresAt: new Date(Date.now() - 60 * 1000) } });
        outcome = await runIcn(buildMockIcn({ referenceId, amount, settled: true }));
        break;
      case "cancelled":
        await PosTransaction.updateOne({ _id: transaction._id, paymentStatus: "pending" }, { $set: { paymentStatus: "cancelled" } });
        outcome = await runIcn(buildMockIcn({ referenceId, amount, settled: true }));
        break;
      case "duplicate": {
        await runIcn(buildMockIcn({ referenceId, amount, settled: true }));
        outcome = await runIcn(buildMockIcn({ referenceId, amount, settled: true }));
        break;
      }
      default:
        outcome = await runIcn(buildMockIcn({ referenceId, amount, settled: true }));
    }

    return responseHandler({ res, response: { scenario, referenceId, amount, ...outcome }, successMessage: `Mock ICN (${scenario}) processed.` });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

module.exports = mockPaynowConfirm;
module.exports.SCENARIOS = SCENARIOS;
module.exports.buildMockIcn = buildMockIcn;
