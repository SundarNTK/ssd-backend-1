/**
 * POS Order Confirmation — admin panel screen for manually confirming a
 * PayNow (or, later, NETS) payment that a real bank/terminal confirmation
 * hasn't reached yet. Exists for exactly the gap the real DBS ICN webhook
 * can't fill locally: `POST /payments/paynow/icn-response` needs a public
 * URL DBS can reach, which `localhost` never is — so during dev/testing (or
 * if a real webhook genuinely never arrives) staff need a way to tell the
 * system "this payment actually happened."
 *
 * Reference: HEB's Admin-Frontend (D:\PROJECTS\HEB\Admin-Frontend, e.g.
 * src\views\kiosk-pos\pos-order-confirmation) does this exact thing for its
 * own PayNow orders — the confirm form there always renders the amount
 * read-only, sourced from the pending record's own stored value, never an
 * editable input. This module follows the same rule: the amount and
 * payment mode were already fixed the moment the QR was generated
 * (controllers/pos-orders' createPendingPayment), and confirming here can
 * only attest that fixed amount was paid — it cannot change it. See
 * request-objects.js's own comment on why the confirm request carries no
 * `amount` field at all.
 *
 * Calls the exact same dispatchPaymentConfirmation() a real DBS ICN would
 * (controllers/payments/dispatch.js) — genuinely the same code path, not a
 * parallel one, so idempotency (confirming the same pending payment twice)
 * is inherited for free from confirmPosPayment's own atomic claim.
 *
 * Endpoints (`:referenceId` throughout is the PosTransaction's own
 * per-attempt reference — see models/pos-transactions' own comment — NOT
 * the order's; a booking topped up more than once has one of these per
 * installment, not one shared across all of them):
 *   GET  /pos-order-confirmation/pending              — awaiting-confirmation list
 *   GET  /pos-order-confirmation/pending/:referenceId  — one pending payment's full detail
 *   POST /pos-order-confirmation/:referenceId/confirm  — manual confirmation
 *
 * Cash is deliberately excluded from the "pending" list — it confirms
 * itself synchronously at the counter and never creates a pending
 * PosTransaction in the first place.
 */

const express = require("express");
const authGuard = require("../../common/middleware/auth-guard");
const adminOnly = require("../../common/middleware/admin-only");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");
const { PosOrder } = require("../../models/pos-orders");
const { PosBooking } = require("../../models/pos-bookings");
const { PosTransaction } = require("../../models/pos-transactions");
const { dispatchPaymentConfirmation } = require("../payments/dispatch");
const { manualConfirmSchema } = require("./request-objects");

const MODULE = "pos-order-confirmation";

function isNonCash(paymentModeName) {
  return Boolean(paymentModeName) && paymentModeName.trim().toLowerCase() !== "cash";
}

/**
 * GET /pos-order-confirmation/pending
 *
 * One row per PENDING PosTransaction — the single fixed-amount payment
 * attempt a QR is currently open for. Keyed off the transaction itself
 * (not the order/booking): it's the transaction that carries the fixed
 * amount, expiry, and (see models/pos-transactions) its own unique
 * `referenceId` — createPendingPayment() still cancels any earlier pending
 * attempt for the same order as a matter of hygiene (see that function's
 * own comment), so there's still no risk of the same order appearing here
 * twice, but confirmManually below now resolves a PosTransaction directly
 * by this exposed `referenceId`, not by finding "the order's one pending
 * row" the way it used to. Once a row is confirmed (paymentStatus flips to
 * "paid") or its `expiresAt` passes, it simply stops matching this query —
 * no separate "remove from list" step exists or is needed anywhere else.
 */
async function listPending(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);

    const transactions = await PosTransaction.find(
      PosTransaction.notDeletedFilter({ paymentStatus: "pending", expiresAt: { $gt: new Date() } })
    )
      .populate("customer", "name customerCode")
      .populate("orderId", "orderNumber")
      .populate("bookingId", "bookingNumber")
      .select("referenceId orderId bookingId customer paymentModeName amount expiresAt transactionDate")
      .sort({ transactionDate: -1 });

    let items = transactions
      .filter((t) => isNonCash(t.paymentModeName) && t.referenceId)
      .map((t) => ({
        transactionId: t._id,
        // The transaction's own per-attempt reference — see the model's
        // own comment. This is what confirmManually's URL param resolves
        // to now, not the order's.
        referenceId: t.referenceId,
        orderNumber: t.orderId?.orderNumber ?? null,
        // Only a balance top-up has a booking yet; a first payment is still just an order.
        bookingNumber: t.bookingId?.bookingNumber ?? null,
        // A pending row already carrying a bookingId is a top-up on an
        // already-confirmed booking; one with none is an order's first
        // payment — same distinction the earlier list-merge design made,
        // now read directly off the transaction instead of inferred from
        // two separate collections.
        kind: t.bookingId ? "balance_due" : "new_payment",
        customer: t.customer ? { _id: t.customer._id, name: t.customer.name, customerCode: t.customer.customerCode } : null,
        paymentModeName: t.paymentModeName,
        amount: t.amount,
        createdAt: t.transactionDate,
        expiresAt: t.expiresAt,
      }));

    const search = (req.query.search || "").trim().toLowerCase();
    if (search) {
      items = items.filter(
        (item) =>
          item.referenceId.toLowerCase().includes(search) ||
          item.orderNumber?.toLowerCase().includes(search) ||
          item.bookingNumber?.toLowerCase().includes(search) ||
          item.customer?.name?.toLowerCase().includes(search)
      );
    }

    const total = items.length;
    items = items.slice((page - 1) * pageSize, page * pageSize);

    return responseHandler({ res, response: { items, total, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * GET /pos-order-confirmation/pending/:referenceId
 *
 * `referenceId` here is the PosTransaction's own per-attempt reference
 * (see that model's own comment) — this now looks the pending row up
 * directly, then loads its order, rather than the other way around.
 */
async function getPendingDetail(req, res) {
  try {
    const { referenceId } = req.params;

    const pending = await PosTransaction.findOne(
      PosTransaction.notDeletedFilter({ referenceId, paymentStatus: "pending", expiresAt: { $gt: new Date() } })
    );
    if (!pending) throw "No pending payment found for this reference — it may already be confirmed, cancelled, or expired.";

    const order = await PosOrder.findOne(PosOrder.notDeletedFilter({ _id: pending.orderId }))
      .populate("customer", "customerCode name email mobileNumber")
      .populate("lines.deities", "name");
    if (!order) throw "No order found for this payment.";

    // A top-up's lines/total are the booking's own (the order's own
    // snapshot predates however much has already been paid); a first
    // payment has no booking yet, so the order's own snapshot is all there is.
    let lines = order.lines;
    let grandTotal = order.grandTotal;
    let bookingNumber = null;
    if (pending.bookingId) {
      const booking = await PosBooking.findById(pending.bookingId).populate("lines.deities", "name");
      if (booking) {
        lines = booking.lines;
        grandTotal = booking.grandTotal;
        bookingNumber = booking.bookingNumber;
      }
    }

    return responseHandler({
      res,
      response: {
        // The transaction's own reference — what confirmManually's URL
        // param must be, not order.referenceId.
        referenceId: pending.referenceId,
        orderNumber: order.orderNumber,
        bookingNumber,
        kind: pending.bookingId ? "balance_due" : "new_payment",
        customer: order.customer,
        lines,
        grandTotal,
        // The fixed amount this specific pending payment is for — NOT the
        // booking's full total and NOT editable. See request-objects.js.
        amount: pending.amount,
        paymentModeName: pending.paymentModeName,
        expiresAt: pending.expiresAt,
      },
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 404 : undefined });
  }
}

/**
 * POST /pos-order-confirmation/:referenceId/confirm
 */
async function confirmManually(req, res) {
  try {
    const { referenceId } = req.params;
    const { error, value } = manualConfirmSchema.validate(req.body ?? {});
    if (error) throw error.details[0].message;

    const { gatewayReference, ...auditFields } = value;
    const hasAuditFields = Object.keys(auditFields).length > 0;

    const result = await dispatchPaymentConfirmation(referenceId, {
      gatewayReference,
      processedBy: req.auth?.userId ?? null,
      // Pure audit trail (txnType/txnDate/valueDt/receivingParty/
      // senderParty) — see request-objects.js's own comment. Not used for
      // idempotency/matching by confirmPosPayment, only stored.
      manualConfirmationDetails: hasAuditFields ? auditFields : null,
    });

    return responseHandler({
      res,
      response: result,
      successMessage: result.alreadyProcessed
        ? "This transaction reference was already confirmed — nothing was changed."
        : "Payment confirmed manually.",
      statusCode: result.alreadyProcessed ? 200 : 201,
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

const router = express.Router();
router.use(authGuard, adminOnly);

router.get("/pending", requirePermission(MODULE, "view"), listPending);
router.get("/pending/:referenceId", requirePermission(MODULE, "view"), getPendingDetail);
router.post("/:referenceId/confirm", requirePermission(MODULE, "fullAccess"), validateBody(manualConfirmSchema), confirmManually);

module.exports = router;
module.exports.listPending = listPending;
module.exports.getPendingDetail = getPendingDetail;
module.exports.confirmManually = confirmManually;
