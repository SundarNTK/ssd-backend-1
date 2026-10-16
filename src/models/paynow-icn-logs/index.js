const mongoose = require("mongoose");

/**
 * One row per PayNow ICN (Instant Credit Notification) the server handled —
 * real ones from DBS and mock ones from development mode. It exists so a
 * disputed or missing payment can be traced afterwards: when the message
 * arrived, which payment reference and DBS transaction id it named, the
 * amount, and what we did with it (or why we refused it).
 *
 * Only the fields needed for that are kept — not the whole decrypted
 * message, which can carry the payer's details.
 */
const PAYNOW_ICN_OUTCOMES = ["settled", "duplicate", "pending", "rejected"];

const paynowIcnLogSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ["dbs", "mock"], default: "dbs" },
    outcome: { type: String, enum: PAYNOW_ICN_OUTCOMES, required: true },
    customerReference: { type: String, default: null },
    txnRefId: { type: String, default: null },
    amount: { type: Number, default: null },
    messageId: { type: String, default: null },
    // Why the message was refused, when outcome is "rejected".
    error: { type: String, default: null },
  },
  { timestamps: { createdAt: "receivedAt", updatedAt: false } }
);

paynowIcnLogSchema.index({ customerReference: 1, receivedAt: -1 });
paynowIcnLogSchema.index({ receivedAt: -1 });

module.exports = {
  PaynowIcnLog: mongoose.model("PaynowIcnLog", paynowIcnLogSchema, "paynow_icn_logs"),
  PAYNOW_ICN_OUTCOMES,
};
