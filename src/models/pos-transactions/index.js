const mongoose = require("mongoose");
const { auditablePlugin } = require("../../common/plugins/auditable");

/**
 * The POS counter's own payment-history ledger — the `pos_` counterpart to
 * models/transactions, one row per payment attempt against a PosBooking.
 * `bookingId` is deliberately not unique-constrained, same reason as the
 * shared Transaction model: a full-payment confirm writes one row, and the
 * partial-payment flow appends further rows as the balance is collected. A
 * booking's amountPaid is never stored redundantly — always the sum of its
 * "paid" rows, computed at read time.
 *
 * Unlike the shared Transaction model (which only ever needed
 * paid|pending|refunded because Cash was the only mode, settled
 * synchronously), this ledger has a genuine async pending -> paid/failed
 * lifecycle for PayNow/NETS: a row is written PENDING, with its amount
 * already fixed, the moment a QR is generated (see controllers/payments/
 * paynow/generate-qr) — never re-created, and never re-priced later. The
 * confirmation step (a real DBS ICN, or an admin's manual confirm — see
 * controllers/pos-order-confirmation) only ever flips this SAME row from
 * pending to paid; it does not get to choose a different amount, the same
 * way a Cash cashier can't "confirm" a receipt for more than what was rung
 * up. `gatewayReference` is what makes that flip idempotent: whatever the
 * bank/terminal hands back (DBS txnRefId, a NETS terminal reference) so a
 * duplicate callback for an already-settled row is recognizable and safely
 * ignored rather than double-counted.
 *
 * `bookingId` is nullable — a PENDING row for an order's FIRST payment is
 * written before any PosBooking exists yet (the booking is only created
 * once that payment is actually confirmed, same as Cash's own confirm-time
 * write), and gets backfilled onto this same row at that point. A PENDING
 * row for a balance top-up on an already-confirmed booking has it from the
 * start.
 */

const POS_TRANSACTION_STATUSES = ["pending", "paid", "failed", "cancelled", "expired", "refunded"];

const posTransactionSchema = new mongoose.Schema({
  receiptNo: { type: String, required: true },

  // The per-ATTEMPT gateway-facing correlation id — same 13-char format as
  // PosOrder.referenceId (common/utils/payment-reference.js), but minted
  // FRESH for every PayNow/NETS/Credit Card payment attempt against an
  // order (the first payment AND every later top-up), never reused across
  // them. This — not PosOrder.referenceId — is what actually gets embedded
  // in the PayNow QR / sent to the NETS terminal, and what
  // confirmPosPayment looks the pending row up by directly. Reusing one
  // order-level reference across multiple sequential PayNow/NETS attempts
  // was the original design and turned out to be a real problem: a bank/
  // terminal can refuse, or mis-reconcile, a second live payment carrying a
  // reference it already saw settle once — see confirmPosPayment's own
  // comment. Left entirely unset for Cash (settled synchronously, never
  // dispatched through the shared confirmation path at all) — deliberately
  // no `default: null` here. A sparse unique index only excludes documents
  // where the field is truly ABSENT, not ones storing an explicit `null`;
  // a `default: null` would stamp every Cash row with `referenceId: null`,
  // and the second such row would collide with the first on the unique
  // index below instead of being skipped by it.
  referenceId: { type: String },

  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "PosBooking", default: null },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "PosOrder", required: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },

  paymentMode: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentMode", required: true },
  paymentModeName: { type: String, required: true },
  amount: { type: Number, required: true, min: 0 },
  // Named paymentStatus, not status — see models/transactions' own comment
  // on why (auditablePlugin already owns `status`).
  paymentStatus: { type: String, enum: POS_TRANSACTION_STATUSES, default: "paid" },

  // Whatever the gateway/terminal hands back once settled — DBS's
  // txnRefId for PayNow, the terminal's own reference for NETS. Not set
  // for Cash (nothing to correlate against). Stored for audit/display —
  // NOT what a duplicate callback is matched against any more (that's
  // `referenceId` above, unique per attempt); kept because it's still the
  // bank/terminal's own transaction id, useful on its own merits.
  gatewayReference: { type: mongoose.Schema.Types.Mixed, default: null },

  // Only meaningful while paymentStatus is "pending" — a QR/terminal
  // attempt that's never confirmed by this time can no longer be confirmed
  // at all (see controllers/pos-orders' confirmPosPayment and
  // controllers/pos-order-confirmation, both of which check this before
  // acting on a pending row) and needs a fresh one generated instead. Null
  // for Cash (settled synchronously, nothing to expire) and for any row
  // already paid/failed/cancelled.
  expiresAt: { type: Date, default: null },

  transactionDate: { type: Date, required: true },
  processedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

  // Set only by a manual admin confirmation (controllers/pos-order-
  // confirmation's confirmManually) — an audit trail alongside
  // gatewayReference (which stays the field idempotency/matching actually
  // uses), modeled on the extra fields HEB's own admin confirm screens
  // capture (transaction type, payment/value date, receiving/sender
  // party). Never set by a real gateway/terminal webhook — those only ever
  // set gatewayReference.
  manualConfirmationDetails: { type: mongoose.Schema.Types.Mixed, default: null },
  // True when a person confirmed this payment by hand (the cashier / admin entered the bank or terminal reference
  // instead of the gateway confirming it itself). Kept as its own flag, beside the details above, so every list and
  // report can pick out the manually confirmed payments with one indexed condition.
  isManuallyConfirmed: { type: Boolean, default: false },

  // Set only by a genuine automatic gateway/terminal confirmation — the
  // NETS/Credit Card machine's own response (approval code, terminal id,
  // and whatever else the terminal SDK translates back — card type, masked
  // PAN, retrieval reference number, response text) captured verbatim for
  // audit, the same spirit as manualConfirmationDetails but for the
  // opposite case. See controllers/payments/nets/callback and
  // confirmPosPayment. Never set by a manual admin/cashier confirmation —
  // that only ever sets manualConfirmationDetails. Cash and PayNow leave
  // this null (PayNow's own DBS ICN payload isn't a physical terminal
  // response — nothing to capture here for it today).
  terminalConfirmationDetails: { type: mongoose.Schema.Types.Mixed, default: null },

  // Denormalized snapshots — see common/utils/entity-snapshot.
  customerInfo: { type: mongoose.Schema.Types.Mixed, default: null },
  processedByInfo: { type: mongoose.Schema.Types.Mixed, default: null },
});

posTransactionSchema.pre("save", async function populatePosTransactionSnapshots() {
  const { buildUserSnapshot, buildCustomerSnapshot } = require("../../common/utils/entity-snapshot");
  if (this.isModified("customer") && this.customer) {
    this.customerInfo = await buildCustomerSnapshot(this.customer);
  }
  if (this.isModified("processedBy") && this.processedBy) {
    this.processedByInfo = await buildUserSnapshot(this.processedBy);
  }
});

posTransactionSchema.plugin(auditablePlugin);

posTransactionSchema.index({ receiptNo: 1 }, { unique: true });
posTransactionSchema.index({ bookingId: 1 });
posTransactionSchema.index({ orderId: 1 });
posTransactionSchema.index({ customer: 1, createdAt: -1 });
posTransactionSchema.index({ paymentStatus: 1, createdAt: -1 });
// Sparse — most rows (Cash) never set this, only PayNow/NETS rows do; a
// dense index here would carry every Cash row for no benefit.
posTransactionSchema.index({ gatewayReference: 1 }, { sparse: true });
// Unique + sparse — every PayNow/NETS/Credit Card row gets one (Cash never
// does), and confirmPosPayment looks a specific attempt up by this field
// directly, so it must never collide across rows the way gatewayReference
// (audit-only now) is allowed to.
posTransactionSchema.index({ referenceId: 1 }, { unique: true, sparse: true });
posTransactionSchema.index({ isManuallyConfirmed: 1, transactionDate: -1 });

module.exports = {
  PosTransaction: mongoose.model("PosTransaction", posTransactionSchema, "pos_transactions"),
  POS_TRANSACTION_STATUSES,
};
