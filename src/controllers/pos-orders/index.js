/**
 * POS counter order/payment flow — the `pos_` counterpart to
 * controllers/pos/index.js's order/booking/payment write routes, backed by
 * its own pos_orders/pos_bookings/pos_transactions collections instead of
 * the shared Order/Booking/Transaction the Admin Booking screen still uses.
 *
 * Catalogue browsing, customer lookup, and the cart-pricing summary are
 * NOT duplicated here — those already read from shared masters
 * (Item/Service/Customer) with no persistence of their own, so
 * controllers/pos/index.js keeps serving them for both the POS and Admin
 * booking trees unchanged. Only the endpoints that actually write an
 * order/booking/payment move to this module:
 *
 *   POST /orders                    — create order + reserve inventory
 *   POST /orders/:id/confirm        — confirm order -> PosBooking + PosTransaction
 *   GET  /orders/:id/status         — poll target
 *   GET  /bookings                  — POS Transactions ledger (pos_bookings)
 *   GET  /bookings/:id              — full booking + payment history
 *   POST /bookings/:id/payments     — collect another installment
 *
 * Cash confirms synchronously, in the same request, exactly like
 * controllers/pos/index.js's createOrder does today — a cashier collecting
 * cash in person IS the confirmation. PayNow/NETS instead leave the order
 * "pending" and reach confirmPosPayment() later, once the real gateway/
 * terminal confirmation lands, via the shared dispatcher in
 * controllers/payments/dispatch.js. Either path ends up calling the same
 * writePosBookingFromOrder() — there is exactly one place a PosBooking ever
 * gets written, regardless of which payment mode triggered it.
 */

const mongoose = require("mongoose");
const { ticketImageUrl } = require("../../common/utils/ticket-image");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { resolveGstRate, extractGstForLines } = require("../../common/utils/gst-rate");
const { sortLineDeities } = require("../../common/utils/sort-line-deities");
const { enrichBookingDevoteesForPrint } = require("../../common/utils/enrich-devotees-for-print");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");
const { nextSequence } = require("../../common/utils/sequence");
const { withUniqueReferenceId, ORIGIN_PREFIXES } = require("../../common/utils/payment-reference");
const { registerPaymentHandler, dispatchPaymentConfirmation } = require("../payments/dispatch");
// Pure QR-image rendering, no dependency back on this module — see that
// file's own comment for why this has to be the direction the require goes
// (payments/paynow/generate-qr/index.js already requires THIS module for
// createPendingPayment; requiring it back here would be a cycle).
const { assertPaynowConfigured, renderQrImage } = require("../payments/paynow/generate-qr/render");

const Item = require("../../models/items");
const Service = require("../../models/services");
const GeneralItem = require("../../models/general-items");
const Event = require("../../models/events");
const { resolveEventLine } = require("../../common/utils/event-line");
const { resolveSessionDate, resolveSession } = require("../../common/utils/session-rule");
const { notPastCutoff } = require("../../common/utils/booking-cutoff");
const { quantityLimitsOf, assertQuantityLimits } = require("../../common/utils/quantity-limits");
const { customerDetailsFor } = require("../../common/utils/customer-details");
const { Customer } = require("../../models/customers");
const PaymentMode = require("../../models/payment-modes");
const { PosOrder } = require("../../models/pos-orders");
const { PosBooking, POS_BOOKING_STATUSES } = require("../../models/pos-bookings");
const { makeReprintHandler, ticketReprintCounts } = require("../../common/utils/booking-reprint");
const reprintPosBooking = makeReprintHandler(PosBooking);
const { sendBookingEmail } = require("../booking-email");
const { PosTransaction } = require("../../models/pos-transactions");
const PrintSplitSetting = require("../../models/print-split-settings");
const findActiveEntityById = require("../../utilities/helpers/find-active-entity-by-id");
const { resolveLineUnits, buildTicketGroups } = require("../../common/utils/ticket-grouping");

const {
  placeReservationsForOrder,
  consumeReservations,
  cancelReservations,
} = require("../pos/inventory-reservation");
const { effectiveQuantity } = require("../../common/utils/effective-quantity");
const { loadHierarchyForPortal, offeringInPosHierarchy } = require("../../common/utils/pos-catalogue-visibility");

const {
  createOrderSchema,
  confirmOrderSchema,
  recordPaymentSchema,
  initiateNetsByReferenceSchema,
  manualTerminalConfirmSchema,
} = require("./request-objects");

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * POS-YYYYMMDD-NNNN — reuses the SAME "pos_order" counter
 * controllers/pos/index.js's own generateOrderNumber() draws from, so order
 * numbers stay globally distinct-looking across the old admin-booking
 * Orders and these new PosOrders even though they now live in separate
 * collections with their own independent uniqueness constraints.
 */
async function generateOrderNumber() {
  const n = await nextSequence("pos_order");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `POS${today}${String(n).padStart(4, "0")}`;
}

async function generateBookingNumber() {
  const n = await nextSequence("booking");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `BKG${today}${String(n).padStart(4, "0")}`;
}

async function generateReceiptNumber() {
  const n = await nextSequence("receipt");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `RCP-${today}-${String(n).padStart(4, "0")}`;
}

/**
 * A booking's amountPaid is never stored on the booking itself — always the
 * sum of its "paid" PosTransaction rows. See models/pos-transactions' own
 * comment for why.
 */
function sumPaidAmount(transactions) {
  return +transactions
    .filter((t) => t.paymentStatus === "paid")
    .reduce((sum, t) => sum + t.amount, 0)
    .toFixed(2);
}

function derivePaymentStatus(amountPaid, grandTotal) {
  if (amountPaid >= grandTotal - 0.005) return "paid";
  if (amountPaid > 0) return "partial";
  return "pending";
}

/**
 * How much is still owed on this order/booking, regardless of whether it's
 * still a pending PosOrder (first payment) or an already-confirmed
 * PosBooking with some balance left (a top-up) — the one place that
 * question is answered, used by both createPendingPayment() below and
 * controllers/payments/paynow/generate-qr.
 */
async function resolveOutstandingBalance(order) {
  if (order.orderStatus !== "confirmed") {
    return { booking: null, balance: order.grandTotal };
  }
  const booking = await PosBooking.findById(order.bookingId);
  if (!booking) throw "Booking record not found for this order.";
  const transactions = await PosTransaction.find(
    PosTransaction.notDeletedFilter({ bookingId: booking._id })
  ).select("amount paymentStatus");
  const paid = sumPaidAmount(transactions);
  return { booking, balance: +(booking.grandTotal - paid).toFixed(2) };
}

// ─── create order ─────────────────────────────────────────────────────────

/**
 * POST /pos/booking/orders
 * Same shape as controllers/pos/index.js's createOrder — see that file's
 * own comment for the full step-by-step rationale (server-side pricing,
 * atomic reservation placement with rollback, server-decided confirmation).
 * Serves both the POS counter and the Admin Panel's Booking page: the route
 * tree it arrived on (req.posPortal) decides which visibility flags apply and
 * which portal the order is stamped with. Also mints a `referenceId` every order carries from creation, whether or
 * not it ends up needed (Cash never sees it again; PayNow/NETS pass it to
 * the gateway/terminal).
 */
async function createOrder(req, res) {
  try {
    const { error, value } = createOrderSchema.validate(req.body);
    if (error) throw error.details[0].message;

    const { customerId, lines, paymentModeId, paidAmount, customerDetails, remarks } = value;
    const portal = req.posPortal === "admin" ? "admin" : "pos";
    const itemVisField = portal === "admin" ? "adminBookingVisibility" : "posAvailability";
    const svcVisField = portal === "admin" ? "adminBookingVisibility" : "isPosAvailable";
    const hierarchy = await loadHierarchyForPortal(portal);

    const customer = await Customer.findOne(
      Customer.notDeletedFilter({ _id: customerId, status: 1 })
    ).select("customerCode name email mobileNumber");
    if (!customer) throw "Customer not found or inactive.";

    const paymentMode = await PaymentMode.findOne(
      PaymentMode.notDeletedFilter({ _id: paymentModeId, status: 1 })
    ).select("name");
    if (!paymentMode) throw "Payment mode not found or inactive.";

    // ── 1. Resolve all line details (prices, names, codes) ──────────────
    const rawLines = [];

    for (const line of lines) {
      const { refType, refId } = line;
      let { deities, devotees } = line;
      let name, code, unitPrice, gstType, generalLedgerId;
      let sessionDate = null;
      let session = null;
      let quantityLimits = null;
      let eventParts = null;

      if (refType === "Event") {
        eventParts = await resolveEventLine(line, { portal });
        ({ name, code, unitPrice, gstType, deities, devotees } = eventParts);
        sessionDate = eventParts.sessionDate;
        generalLedgerId = eventParts.generalLedgerId;
      } else if (refType === "Item") {
        const item = await Item.findOne(
          Item.notDeletedFilter({ _id: refId, status: 1, [itemVisField]: true, $and: [notPastCutoff("futureBookingCutOffDate")] })
        ).populate("generalLedger", "gstType");
        if (!item || !offeringInPosHierarchy(item, hierarchy.categoryIds, hierarchy.subCategoryIds)) {
          throw `An item in the cart is no longer available.`;
        }
        name = item.name;
        sessionDate = resolveSessionDate(item, line);
        session = resolveSession(item, line);
        quantityLimits = quantityLimitsOf(item);
        code = item.code;
        unitPrice = item.salePrice;
        gstType = item.generalLedger?.gstType ?? null;
        generalLedgerId = item.generalLedger?._id ?? null;
      } else if (refType === "Service") {
        const svc = await Service.findOne(
          Service.notDeletedFilter({ _id: refId, status: 1, [svcVisField]: true, $and: [notPastCutoff("bookingCutoffDate")] })
        ).populate("generalLedger", "gstType");
        if (!svc || !offeringInPosHierarchy(svc, hierarchy.categoryIds, hierarchy.subCategoryIds)) {
          throw `A service in the cart is no longer available.`;
        }
        name = svc.name;
        sessionDate = resolveSessionDate(svc, line);
        session = resolveSession(svc, line);
        quantityLimits = quantityLimitsOf(svc);
        code = svc.code;
        unitPrice = svc.salePrice ?? 0;
        gstType = svc.generalLedger?.gstType ?? null;
        generalLedgerId = svc.generalLedger?._id ?? null;
      } else {
        const gi = await GeneralItem.findOne(
          GeneralItem.notDeletedFilter({ _id: refId, status: 1, [itemVisField]: true, $and: [notPastCutoff("futureBookingCutOffDate")] })
        ).populate("generalLedger", "gstType");
        if (!gi || !offeringInPosHierarchy(gi, hierarchy.categoryIds, hierarchy.subCategoryIds)) {
          throw `A product in the cart is no longer available.`;
        }
        name = gi.name;
        code = gi.code;
        // General Items carry no master price — trusted here ONLY because
        // Joi forbids manualUnitPrice for every other refType.
        unitPrice = line.manualUnitPrice;
        gstType = gi.generalLedger?.gstType ?? null;
        generalLedgerId = gi.generalLedger?._id ?? null;
      }

      const gstRate = await resolveGstRate(gstType);
      const qty = effectiveQuantity(line);
      assertQuantityLimits(quantityLimits, qty);

      // unitPrice is the GST-inclusive counter price shown in the cart —
      // GST is extracted out of it, never added on top. Each line's own
      // gstAmount/glAmount is its own independent rounding (see
      // extractGstForLines, called after this loop) — the cart-level
      // subtotal/gstAmount below come from that same call's totals, summed
      // from the unrounded per-line figures rather than by re-summing
      // these already-rounded ones, so they never drift from a single
      // extraction on the whole cart.
      rawLines.push({
        refType,
        refId,
        quantity: qty,
        name,
        code,
        unitPrice,
        lineGross: unitPrice * qty,
        generalLedger: generalLedgerId,
        gstType,
        gstRate,
        deities,
        devotees,
        eventSlot: eventParts?.eventSlot ?? null,
        sessionDate,
        session,
        seats: eventParts?.seats ?? 1,
        holdId: eventParts?.holdId ?? null,
      });
    }

    const gst = extractGstForLines(rawLines);
    const resolvedLines = rawLines.map((l, i) => ({
      refType: l.refType,
      refId: l.refId,
      quantity: l.quantity,
      name: l.name,
      code: l.code,
      unitPrice: l.unitPrice,
      lineTotal: l.lineGross,
      generalLedger: l.generalLedger,
      gstType: l.gstType,
      gstRate: l.gstRate,
      gstAmount: gst.lines[i].gstAmount,
      glAmount: gst.lines[i].glAmount,
      deities: l.deities,
      devotees: l.devotees,
      eventSlot: l.eventSlot,
      sessionDate: l.sessionDate ?? null,
      session: l.session ?? null,
      seats: l.seats,
      holdId: l.holdId,
    }));
    const subtotal = gst.totalGlAmount;
    const totalGst = gst.totalGstAmount;

    const grandTotal = +(subtotal + totalGst).toFixed(2);
    if (paidAmount != null && paidAmount > grandTotal + 0.005) {
      throw `Payment amount cannot exceed the total payable amount of ${grandTotal.toFixed(2)}.`;
    }

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const orderNumber = await generateOrderNumber();

    // ── 2. Write the PosOrder first (gives us an _id for reservations) ──
    // referenceId is crypto-random (see common/utils/payment-reference.js),
    // not sequential — withUniqueReferenceId regenerates and retries this
    // whole write on the practically-never-hit chance two orders mint the
    // same one, same defensive pattern this codebase already uses for uid.
    const order = await withUniqueReferenceId(ORIGIN_PREFIXES.POS, (referenceId) =>
      PosOrder.create({
        referenceId,
        orderNumber,
        customer: customerId,
        customerDetails: customerDetailsFor(customer, customerDetails),
        remarks: remarks || "",
        lines: resolvedLines.map((l) => ({
          refType: l.refType,
          refId: l.refId,
          name: l.name,
          code: l.code,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
          generalLedger: l.generalLedger,
          gstType: l.gstType,
          gstRate: l.gstRate,
          gstAmount: l.gstAmount,
          glAmount: l.glAmount,
          deities: l.deities,
          devotees: l.devotees,
          eventSlot: l.eventSlot,
      sessionDate: l.sessionDate ?? null,
      session: l.session ?? null,
          seats: l.seats,
        })),
        subtotal: +subtotal.toFixed(2),
        gstAmount: +totalGst.toFixed(2),
        grandTotal,
        paymentMode: paymentModeId,
        paymentModeName: paymentMode.name,
        orderStatus: "pending",
        portal,
        expiresAt,
        bookedBy: req.auth?.userId ?? null,
        entity: req.auth?.entityId ?? null,
        createdBy: req.auth?.userId ?? null,
      })
    );

    // ── 3. Place inventory reservations ─────────────────────────────────
    try {
      // Who is booking (and from which portal) only matters to Event seat holds.
      const holdOptions = resolvedLines.some((l) => l.refType === "Event") ? [{ ownerId: req.auth?.userId ?? null, posOnly: portal !== "admin" }] : [];
      await placeReservationsForOrder(resolvedLines, order._id, ...holdOptions);
    } catch (reservationError) {
      await PosOrder.findByIdAndUpdate(order._id, { orderStatus: "cancelled" });
      throw reservationError;
    }

    // ── 4. Cash confirms itself, right here, server-side ────────────────
    if (paymentMode.name.trim().toLowerCase() === "cash") {
      const confirmed = await writePosBookingFromOrder({ ...order.toObject?.() ?? order, customer }, paidAmount);
      return responseHandler({
        res,
        response: { ...confirmed, status: "confirmed" },
        successMessage:
          confirmed.paymentStatus === "paid" ? "Booking confirmed successfully." : "Booking confirmed with a partial payment.",
        statusCode: 201,
      });
    }

    // PayNow builds its QR right here and embeds it as `paymentDetails` —
    // the POS counter gets { amount, qr } in this SAME response and never
    // has to make a second call to /payments/paynow/generate-qr just to see
    // one. A QR failure (config incomplete, render error) does NOT fail
    // order creation — the order and its inventory hold are already
    // committed by this point, and the customer still needs a referenceId
    // back to retry against; it comes back as `paymentDetailsError`
    // instead, and the frontend can fall back to calling
    // POST /payments/paynow/generate-qr directly with this referenceId
    // (still a live route — also what top-ups against an already-confirmed
    // booking use, since there's no order-create response to embed into
    // there).
    let paymentDetails = null;
    let paymentDetailsError = null;
    if (paymentMode.name.trim().toLowerCase() === "paynow") {
      try {
        paymentDetails = await buildPaynowQrForOrder({
          referenceId: order.referenceId,
          amount: paidAmount,
          processedBy: req.auth?.userId ?? null,
        });
      } catch (qrError) {
        paymentDetailsError = typeof qrError === "string" ? qrError : "Could not generate the PayNow QR. Please try again.";
      }
    }

    // Any other mode (NETS) stays "pending" with no paymentDetails yet —
    // its own initiate route (Phase 3) is what happens next, using this
    // order's `referenceId`.
    return responseHandler({
      res,
      response: {
        _id: order._id,
        referenceId: order.referenceId,
        orderNumber: order.orderNumber,
        customer: {
          _id: customer._id,
          customerCode: customer.customerCode,
          name: customer.name,
          email: customer.email,
          mobileNumber: customer.mobileNumber,
        },
        lines: order.lines,
        subtotal: order.subtotal,
        gstAmount: order.gstAmount,
        grandTotal: order.grandTotal,
        paymentModeName: order.paymentModeName,
        orderStatus: order.orderStatus,
        expiresAt: order.expiresAt,
        status: "pending",
        paymentDetails,
        paymentDetailsError,
      },
      successMessage: "Order created. Inventory held for 30 minutes.",
      statusCode: 201,
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

// ─── confirm order -> booking ───────────────────────────────────────────

/**
 * The one place a PosBooking is ever written. `paidAmount` is how much is
 * being collected right now — omit it to pay the grandTotal in full.
 * `paymentOverride` optionally carries a different paymentMode/Name and a
 * gatewayReference than the order's own (PayNow/NETS confirmations settle
 * against whatever mode the order was actually created for, so this is
 * unused there today, but kept for the same reason recordBookingPayment
 * accepts a different mode for a top-up — an installment doesn't have to
 * match the original).
 */
async function writePosBookingFromOrder(order, paidAmount, paymentOverride = {}) {
  const [bookingNumber, receiptNo] = await Promise.all([generateBookingNumber(), generateReceiptNumber()]);
  const now = new Date();
  const customerId = order.customer._id ?? order.customer;

  const amountNow = paidAmount == null ? order.grandTotal : Math.max(0, Math.min(paidAmount, order.grandTotal));
  const bookingPaymentStatus = derivePaymentStatus(amountNow, order.grandTotal);

  let booking;
  let transaction;
  try {
    booking = await PosBooking.create({
      bookingNumber,
      orderId: order._id,
      customer: customerId,
      customerDetails: order.customerDetails ?? customerDetailsFor(order.customer, null),
      remarks: order.remarks || "",
      lines: order.lines,
      subtotal: order.subtotal,
      gstAmount: order.gstAmount,
      grandTotal: order.grandTotal,
      paymentMode: paymentOverride.paymentMode ?? order.paymentMode,
      paymentModeName: paymentOverride.paymentModeName ?? order.paymentModeName,
      paymentStatus: bookingPaymentStatus,
      bookingStatus: "confirmed",
      portal: order.portal ?? "pos",
      bookedBy: order.bookedBy,
      entity: order.entity,
      bookedAt: now,
      createdBy: order.bookedBy ?? null,
    });

    if (amountNow > 0) {
      transaction = await PosTransaction.create({
        receiptNo,
        bookingId: booking._id,
        orderId: order._id,
        customer: customerId,
        paymentMode: paymentOverride.paymentMode ?? order.paymentMode,
        paymentModeName: paymentOverride.paymentModeName ?? order.paymentModeName,
        amount: amountNow,
        paymentStatus: "paid",
        gatewayReference: paymentOverride.gatewayReference ?? null,
        transactionDate: now,
        processedBy: paymentOverride.processedBy ?? order.bookedBy,
        createdBy: paymentOverride.processedBy ?? order.bookedBy ?? null,
      });
    }

    await PosOrder.findByIdAndUpdate(order._id, { orderStatus: "confirmed", bookingId: booking._id });
  } catch (writeError) {
    if (transaction) await PosTransaction.deleteOne({ _id: transaction._id }).catch(() => {});
    if (booking) await PosBooking.deleteOne({ _id: booking._id }).catch(() => {});
    throw writeError;
  }

  const consumed = await consumeReservations(order._id, order.lines, order.bookedBy, bookingNumber);
  const shortfalls = consumed?.shortfalls ?? [];
  if (shortfalls.length > 0) {
    // Paid after the reservation expired and the stock is gone: the booking stands, flagged for a manual follow-up.
    await PosBooking.updateOne({ _id: booking._id }, { $set: { inventoryShortfall: shortfalls } });
    console.warn(`>>> [inventory] booking ${bookingNumber} confirmed with a stock shortfall:`, JSON.stringify(shortfalls));
  }

  const customerSnap = order.customer?.customerCode
    ? order.customer
    : await Customer.findById(order.customer).select("customerCode name email mobileNumber");

  return {
    _id: booking._id,
    bookingNumber: booking.bookingNumber,
    orderNumber: order.orderNumber,
    referenceId: order.referenceId,
    receiptNo: transaction?.receiptNo ?? null,
    customer: {
      _id: customerSnap._id,
      customerCode: customerSnap.customerCode,
      name: customerSnap.name,
      email: customerSnap.email,
      mobileNumber: customerSnap.mobileNumber,
    },
    lines: booking.lines,
    subtotal: booking.subtotal,
    gstAmount: booking.gstAmount,
    grandTotal: booking.grandTotal,
    paymentModeName: booking.paymentModeName,
    paymentStatus: booking.paymentStatus,
    bookingStatus: booking.bookingStatus,
    bookedAt: booking.bookedAt,
    amountPaid: amountNow,
    balanceAmount: +(booking.grandTotal - amountNow).toFixed(2),
  };
}

/**
 * Shapes an already-confirmed booking for a response — used by both
 * confirmOrder's idempotent re-confirm branch and getOrderStatus's
 * confirmed branch. Both used to spread `booking.toObject()` and stop
 * there, which meant neither ever carried `amountPaid`/`balanceAmount` —
 * fine for a `paid` booking (the frontend never needed those fields for
 * that case), but a real bug for a `partial` one: the polling flow for a
 * partially-paid PayNow first payment calls this exact endpoint and reads
 * `booking.balanceAmount` to build its success message, and it was always
 * `undefined` there — throwing inside PaynowQrModal's poll tick, which
 * silently swallowed it and retried forever instead of ever showing
 * success. Also picks `receiptNo` off the OLDEST transaction (the one
 * printed at confirm time), not an arbitrary unsorted `findOne` — the same
 * convention listBookings already uses.
 */
async function buildConfirmedOrderResponse(order, booking) {
  const transactions = await PosTransaction.find(PosTransaction.notDeletedFilter({ bookingId: booking._id }))
    .select("receiptNo amount paymentStatus transactionDate")
    .sort({ transactionDate: 1 });
  const amountPaid = sumPaidAmount(transactions);
  return {
    ...booking.toObject(),
    receiptNo: transactions[0]?.receiptNo ?? null,
    orderNumber: order.orderNumber,
    referenceId: order.referenceId,
    status: "confirmed",
    amountPaid,
    balanceAmount: +(booking.grandTotal - amountPaid).toFixed(2),
  };
}

/**
 * POST /pos/booking/orders/:id/confirm
 * Idempotent re-confirm, same shape as controllers/pos/index.js's
 * confirmOrder.
 */
async function confirmOrder(req, res) {
  try {
    const orderId = req.params.id;
    if (!mongoose.isValidObjectId(orderId)) throw "Invalid order ID.";

    const { error, value } = confirmOrderSchema.validate(req.body ?? {});
    if (error) throw error.details[0].message;
    const { paidAmount } = value;

    const order = await PosOrder.findOne(
      PosOrder.notDeletedFilter({ _id: orderId })
    ).populate("customer", "customerCode name email mobileNumber");

    if (!order) throw "Order not found.";
    if (order.orderStatus === "confirmed") {
      const existing = await PosBooking.findById(order.bookingId)
        .populate("customer", "customerCode name email mobileNumber")
        // Print order, not display order — this response feeds the
        // printed/on-screen receipt (see models/deities' printOrder
        // field). Sorted in JS below — Mongoose can't apply a populate
        // `sort` to a path nested inside a document array like this one.
        .populate({ path: "lines.deities", select: "name printOrder" })
        .populate("bookedBy", "name email");
      if (!existing) throw "Booking record not found for this confirmed order.";
      sortLineDeities(existing, "printOrder");
      return responseHandler({
        res,
        response: await buildConfirmedOrderResponse(order, existing),
        successMessage: "Booking already confirmed.",
      });
    }
    if (order.orderStatus === "cancelled") throw "This order has been cancelled and cannot be confirmed.";

    if (new Date() > order.expiresAt) {
      await cancelReservations(order._id);
      await PosOrder.findByIdAndUpdate(order._id, { orderStatus: "cancelled" });
      throw "Order expired — the 30-minute hold has lapsed. Please create a new order.";
    }

    if (paidAmount != null && paidAmount > order.grandTotal + 0.005) {
      throw `Payment amount cannot exceed the total payable amount of ${order.grandTotal.toFixed(2)}.`;
    }

    const confirmed = await writePosBookingFromOrder(order, paidAmount);
    return responseHandler({
      res,
      response: { ...confirmed, status: "confirmed" },
      successMessage:
        confirmed.paymentStatus === "paid" ? "Booking confirmed successfully." : "Booking confirmed with a partial payment.",
      statusCode: 201,
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * GET /pos/booking/orders/:id/status
 */
async function getOrderStatus(req, res) {
  try {
    const orderId = req.params.id;
    if (!mongoose.isValidObjectId(orderId)) throw "Invalid order ID.";

    const order = await PosOrder.findOne(PosOrder.notDeletedFilter({ _id: orderId })).select(
      "orderStatus orderNumber referenceId expiresAt bookingId"
    );
    if (!order) throw "Order not found.";

    if (order.orderStatus === "confirmed") {
      const booking = await PosBooking.findById(order.bookingId)
        .populate("customer", "customerCode name email mobileNumber")
        // Print order, not display order — see the matching comment in
        // confirmOrder above.
        .populate({ path: "lines.deities", select: "name printOrder" })
        .populate("bookedBy", "name email");
      if (!booking) throw "Booking record not found for this confirmed order.";
      sortLineDeities(booking, "printOrder");
      return responseHandler({ res, response: await buildConfirmedOrderResponse(order, booking) });
    }

    if (order.orderStatus === "cancelled") {
      return responseHandler({ res, response: { status: "cancelled" } });
    }

    const expired = new Date() > order.expiresAt;
    return responseHandler({ res, response: { status: expired ? "expired" : "pending", expiresAt: order.expiresAt } });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

// ─── ledger + partial payment ───────────────────────────────────────────

function deriveLineType(lines) {
  const types = new Set((lines || []).map((l) => l.refType));
  if (types.size === 0) return "—";
  if (types.size === 1) return [...types][0];
  return "Mixed";
}

/**
 * GET /pos/booking/bookings?search=&status=&paymentStatus=
 */
async function listBookings(req, res) {
  try {
    const escapeRegex = require("../../common/utils/escape-regex");
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);

    const filter = PosBooking.notDeletedFilter();
    // The counter's ledger never lists the Admin Panel's bookings (older records have no portal and are POS).
    filter.portal = req.posPortal === "admin" ? "admin" : { $ne: "admin" };
    if (req.query.status && POS_BOOKING_STATUSES.includes(req.query.status)) {
      filter.bookingStatus = req.query.status;
    }
    if (req.query.paymentStatus && ["paid", "partial", "pending"].includes(req.query.paymentStatus)) {
      filter.paymentStatus = req.query.paymentStatus;
    }
    if (req.query.search) {
      const regex = new RegExp(escapeRegex(req.query.search.trim()), "i");
      const [matchingCustomers, matchingTransactions] = await Promise.all([
        Customer.find(Customer.notDeletedFilter({ name: regex })).select("_id"),
        PosTransaction.find(PosTransaction.notDeletedFilter({ receiptNo: regex })).select("bookingId"),
      ]);
      filter.$or = [
        { bookingNumber: regex },
        { customer: { $in: matchingCustomers.map((c) => c._id) } },
        { _id: { $in: matchingTransactions.map((t) => t.bookingId) } },
      ];
    }

    const [bookings, total] = await Promise.all([
      PosBooking.find(filter)
        .populate("customer", "customerCode name email mobileNumber")
        .populate("orderId", "orderNumber referenceId")
        .select(
          "bookingNumber orderId customer customerDetails remarks lines subtotal gstAmount grandTotal paymentModeName paymentStatus bookingStatus portal reprintCount bookedAt"
        )
        .sort({ bookedAt: -1 })
        // listWindow lets the Admin Panel's merged ledger ask for an exact slice.
        .skip(req.listWindow?.skip ?? (page - 1) * pageSize)
        .limit(req.listWindow?.limit ?? pageSize),
      PosBooking.countDocuments(filter),
    ]);

    const bookingIds = bookings.map((b) => b._id);
    const transactions = await PosTransaction.find(PosTransaction.notDeletedFilter({ bookingId: { $in: bookingIds } }))
      .select("bookingId receiptNo amount paymentStatus paymentModeName transactionDate")
      .sort({ transactionDate: 1 });
    const transactionsByBooking = new Map();
    for (const t of transactions) {
      const key = String(t.bookingId);
      if (!transactionsByBooking.has(key)) transactionsByBooking.set(key, []);
      transactionsByBooking.get(key).push(t);
    }

    const items = bookings.map((b) => {
      const bookingTxns = transactionsByBooking.get(String(b._id)) ?? [];
      const amountPaid = sumPaidAmount(bookingTxns);
      // A partial-payment booking can collect its installments on different
      // modes (e.g. Cash first, PayNow for the balance) — the booking's own
      // paymentModeName only ever records the FIRST one. Every mode that
      // actually landed money is what the list should show, oldest first,
      // deduped (two Cash installments still show as just "Cash").
      const paidModeNames = [];
      const seenModeNames = new Set();
      for (const t of bookingTxns) {
        if (t.paymentStatus !== "paid" || seenModeNames.has(t.paymentModeName)) continue;
        seenModeNames.add(t.paymentModeName);
        paidModeNames.push(t.paymentModeName);
      }
      return {
        _id: b._id,
        bookingNumber: b.bookingNumber,
        receiptNo: bookingTxns[0]?.receiptNo ?? null,
        orderNumber: b.orderId?.orderNumber ?? null,
        referenceId: b.orderId?.referenceId ?? null,
        customer: b.customer
          ? { _id: b.customer._id, customerCode: b.customer.customerCode, name: b.customer.name }
          : null,
        // As typed at the desk when it was booked (name / mobile / email) - see the booking's customerDetails.
        customerDetails: b.customerDetails ?? null,
        remarks: b.remarks ?? "",
        // The session day(s) the booking was made for (items/services/events with a session rule).
        sessionDates: [...new Set((b.lines || []).map((l) => l.sessionDate).filter(Boolean))].sort(),
        // Each booked session day with its AM / PM half (session null when the master has no sessions).
        sessionSlots: [...new Map((b.lines || []).filter((l) => l.sessionDate).map((l) => [`${l.sessionDate}|${l.session || ""}`, { date: l.sessionDate, session: l.session || null }])).values()].sort((a, b) => a.date.localeCompare(b.date) || String(a.session).localeCompare(String(b.session))),
        lineType: deriveLineType(b.lines),
        paymentModeName: b.paymentModeName,
        paymentModeNames: paidModeNames.length ? paidModeNames : [b.paymentModeName],
        subtotal: b.subtotal,
        gstAmount: b.gstAmount,
        grandTotal: b.grandTotal,
        paymentStatus: b.paymentStatus,
        amountPaid,
        balanceAmount: +(b.grandTotal - amountPaid).toFixed(2),
        bookingStatus: b.bookingStatus,
        portal: b.portal ?? "pos",
        reprintCount: b.reprintCount ?? 0,
        bookedAt: b.bookedAt,
      };
    });

    return responseHandler({ res, response: { items, total, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * GET /pos/booking/bookings/:id
 */
async function getBookingDetail(req, res) {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) throw "Invalid booking ID.";

    const [booking, transactions] = await Promise.all([
      PosBooking.findOne(PosBooking.notDeletedFilter({ _id: id }))
        .populate("customer", "customerCode name email mobileNumber")
        .populate("orderId", "orderNumber referenceId orderStatus")
        .populate("paymentMode", "name")
        // Print order, not display order — see confirmOrder's comment above.
        .populate({ path: "lines.deities", select: "name printOrder" })
        .populate("bookedBy", "name email"),
      // paymentStatus: "paid" only — this is the receipt's payment history,
      // and a pending/cancelled/failed/expired attempt (e.g. a QR that was
      // scanned but never paid, or superseded by a later retry) isn't a
      // payment that was actually collected. Matches sumPaidAmount below,
      // which already only counts "paid" toward amountPaid.
      PosTransaction.find(PosTransaction.notDeletedFilter({ bookingId: id, paymentStatus: "paid" }))
        .select("receiptNo amount paymentStatus paymentModeName transactionDate processedBy")
        .populate("processedBy", "name email")
        .sort({ transactionDate: 1 }),
    ]);

    if (!booking) throw "Booking not found.";
    sortLineDeities(booking, "printOrder");

    const amountPaid = sumPaidAmount(transactions);

    return responseHandler({
      res,
      response: {
        ...booking.toObject(),
        portal: booking.portal ?? "pos",
        transactions,
        amountPaid,
        balanceAmount: +(booking.grandTotal - amountPaid).toFixed(2),
      },
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 404 : undefined });
  }
}

/**
 * Resolves a confirmed booking's lines into physical print tickets, per the
 * Print Split Setting master (models/print-split-settings) and each
 * line's Item/Service.isDeityMappingRequired -> Deity.printingGroup /
 * Item-or-Service.printingGroup resolution rule. All the actual
 * grouping/resolution logic lives in common/utils/ticket-grouping.js (pure,
 * independently unit-tested) — this function only loads what that logic
 * needs and shapes the result.
 *
 * A plain function, not an HTTP handler, deliberately: it has two callers
 * with two different auth stories. GET /pos/booking/bookings/:id/ticket-groups
 * below is admin-JWT-gated, for a human (e.g. a future reprint screen).
 * controllers/payments/nets/callback (shared-secret-gated, no admin
 * session — it's the local EXE calling in, not a logged-in operator) calls
 * this SAME function directly, in-process, and inlines the result into its
 * own response — so the EXE gets what it needs to print in the one
 * already-authenticated round trip it makes, without needing an admin JWT
 * it has no way to hold.
 *
 * @returns {Promise<{ticketGroups, receipt, temple, customer, splitMode}>}
 */
async function computeBookingTicketGroups(bookingId) {
  if (!mongoose.isValidObjectId(bookingId)) throw "Invalid booking ID.";

  const booking = await PosBooking.findOne(PosBooking.notDeletedFilter({ _id: bookingId })).populate({
    path: "lines.deities",
    select: "name tamilName printingGroup printOrder",
    populate: { path: "printingGroup", select: "name" },
  });
  if (!booking) throw "Booking not found.";
  // Determines the order deity-wise tickets print in for a multi-deity
  // line (see models/deities' printOrder field) — sorted here, in JS, not
  // via the populate above: Mongoose can't apply a populate `sort` to a
  // path nested inside a document array like lines.deities.
  sortLineDeities(booking, "printOrder");

  // Print tickets in Tamil for devotee name + star — resolve nakshatra
  // from the master and transliterate Latin devotee names. Done on the
  // in-memory booking only; never written back.
  await enrichBookingDevoteesForPrint(booking);

  const [setting, paidTxns, entity] = await Promise.all([
    PrintSplitSetting.findOne({}),
    // ALL paid installments, not just the first — a partially-paid booking
    // can be topped up on a different mode than it was opened with (Cash
    // first, NETS for the balance), and the printed ticket must show every
    // mode that actually landed money, not just whichever one happened
    // first. Oldest first so paymentModeNames below comes out in the order
    // each mode was actually collected.
    PosTransaction.find(PosTransaction.notDeletedFilter({ bookingId: booking._id, paymentStatus: "paid" }))
      .sort({ transactionDate: 1 })
      .select("receiptNo paymentModeName"),
    booking.entity ? findActiveEntityById(booking.entity) : Promise.resolve(null),
  ]);
  const splitMode = setting?.mode ?? "PRINT_GROUP_WISE";

  // Deduped, oldest-first — two Cash installments still print as just
  // "CASH", while Cash + NETS prints as "CASH, NETS". Falls back to the
  // booking's own paymentModeName on the (should-never-happen) chance a
  // confirmed booking has no paid transaction row yet.
  const paymentModeNames = [];
  const seenModeNames = new Set();
  for (const t of paidTxns) {
    if (seenModeNames.has(t.paymentModeName)) continue;
    seenModeNames.add(t.paymentModeName);
    paymentModeNames.push(t.paymentModeName);
  }
  if (paymentModeNames.length === 0) paymentModeNames.push(booking.paymentModeName);

  // Batch-load every Item/Service/GeneralItem referenced by this booking's
  // lines in three queries total, not one per line.
  const itemIds = booking.lines.filter((l) => l.refType === "Item").map((l) => l.refId);
  const serviceIds = booking.lines.filter((l) => l.refType === "Service").map((l) => l.refId);
  const generalItemIds = booking.lines.filter((l) => l.refType === "GeneralItem").map((l) => l.refId);
  const [items, services, generalItems] = await Promise.all([
    itemIds.length
      ? Item.find({ _id: { $in: itemIds } }).select("isDeityMappingRequired printingGroup tamilName ticketImage printImage").populate("printingGroup", "name")
      : [],
    serviceIds.length
      ? Service.find({ _id: { $in: serviceIds } }).select("isDeityMappingRequired printingGroup tamilName ticketImage printImage").populate("printingGroup", "name")
      : [],
    // GeneralItem has no isDeityMappingRequired field — resolveLineUnits
    // treats that as falsy and resolves the printing group straight off
    // offeringDoc.printingGroup, which is exactly what we want here.
    generalItemIds.length
      ? GeneralItem.find({ _id: { $in: generalItemIds } }).select("printingGroup tamilName ticketImage printImage").populate("printingGroup", "name")
      : [],
  ]);
  const offeringsById = new Map([...items, ...services, ...generalItems].map((doc) => [String(doc._id), doc]));
  // Event lines print per deity (the picked deities carry the print group), so an event
  // behaves like a deity-mapped offering here.
  const eventIds = booking.lines.filter((l) => l.refType === "Event").map((l) => l.refId);
  if (eventIds.length) {
    const eventDocs = await Event.find({ _id: { $in: eventIds } }).select("tamilName ticketImage printImage deityMapping");
    for (const e of eventDocs) {
      const hasDeities = (e.deityMapping || []).length > 0;
      offeringsById.set(String(e._id), {
        isDeityMappingRequired: hasDeities,
        // An event with no deity has no Print Group of its own either: it prints on its own ticket under a stand-in group.
        ...(hasDeities ? {} : { printingGroup: { _id: `event-${e._id}`, name: null } }),
        tamilName: e.tamilName,
        ticketImage: e.ticketImage,
        printImage: e.printImage,
      });
    }
  }

  
  // Picture to print under each line - only when Print Split Setting's "Print image on ticket" is Yes AND the
  // record's own master says yes and has a picture (otherwise no imageUrl is sent and the ticket is unchanged).
  const printImageOn = setting?.printImage === true;
  for (const doc of offeringsById.values()) doc.ticketImageUrl = ticketImageUrl(doc, printImageOn);

  const units = booking.lines.flatMap((line) => resolveLineUnits(line, offeringsById.get(String(line.refId)), line.deities));
  const ticketGroups = buildTicketGroups(units, splitMode);
  // How many times each ticket has been reprinted so far (the Reprint popup shows it and numbers the next one).
  const reprintCounts = ticketReprintCounts(booking.reprints);
  for (const g of ticketGroups) g.reprintCount = reprintCounts.get(g.key) || 0;

  return {
    ticketGroups,
    receipt: {
      receiptNo: paidTxns[0]?.receiptNo ?? null,
      bookingNumber: booking.bookingNumber,
      printedAt: new Date().toISOString(),
      // Every payment mode that actually landed money on this booking, in
      // the order it was collected — see printTicketForBooking (frontend)
      // and confirmAndPrintNetsPayment (Nets-Service EXE), both of which
      // print "<mode>, <mode>, ..." on the ticket from this instead of a
      // single hardcoded/first-payment-only mode name.
      paymentModeNames,
    },
    temple: entity ? { name: entity.templeName || entity.name, tamilName: entity.templeTamilName || "" } : null,
    customer: booking.customerInfo,
    splitMode,
  };
}

/**
 * GET /pos/booking/bookings/:id/ticket-groups — thin HTTP wrapper, for a
 * logged-in admin (e.g. a reprint screen). See computeBookingTicketGroups
 * above for the other caller.
 */
async function getBookingTicketGroups(req, res) {
  try {
    const result = await computeBookingTicketGroups(req.params.id);
    return responseHandler({ res, response: result });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * Appends one more "paid" PosTransaction row against an already-confirmed
 * PosBooking and recomputes its paymentStatus — the write both
 * recordBookingPayment (HTTP route, cash/manual top-up) and
 * confirmPosPayment (dispatcher, PayNow/NETS top-up) funnel through, so
 * there is exactly one place a balance top-up is ever applied.
 */
async function applyBookingPayment(booking, amount, { paymentMode, paymentModeName, gatewayReference, processedBy } = {}) {
  const existingTxns = await PosTransaction.find(PosTransaction.notDeletedFilter({ bookingId: booking._id })).select(
    "amount paymentStatus"
  );
  const paidSoFar = sumPaidAmount(existingTxns);
  const balance = +(booking.grandTotal - paidSoFar).toFixed(2);
  if (balance <= 0.005) throw "This booking is already fully paid.";
  if (amount > balance + 0.005) throw `Payment amount cannot exceed the outstanding balance of ${balance.toFixed(2)}.`;

  const receiptNo = await generateReceiptNumber();
  const transaction = await PosTransaction.create({
    receiptNo,
    bookingId: booking._id,
    orderId: booking.orderId,
    customer: booking.customer,
    paymentMode: paymentMode ?? booking.paymentMode,
    paymentModeName: paymentModeName ?? booking.paymentModeName,
    amount,
    paymentStatus: "paid",
    gatewayReference: gatewayReference ?? null,
    transactionDate: new Date(),
    processedBy: processedBy ?? null,
    createdBy: processedBy ?? null,
  });

  const newAmountPaid = +(paidSoFar + amount).toFixed(2);
  booking.paymentStatus = derivePaymentStatus(newAmountPaid, booking.grandTotal);
  await booking.save();

  return { transaction, amountPaid: newAmountPaid, balanceAmount: +(booking.grandTotal - newAmountPaid).toFixed(2) };
}

/**
 * POST /pos/booking/bookings/:id/payments
 */
async function recordBookingPayment(req, res) {
  try {
    const bookingId = req.params.id;
    if (!mongoose.isValidObjectId(bookingId)) throw "Invalid booking ID.";

    const { error, value } = recordPaymentSchema.validate(req.body ?? {});
    if (error) throw error.details[0].message;
    const { amount, paymentModeId } = value;

    const booking = await PosBooking.findOne(PosBooking.notDeletedFilter({ _id: bookingId }));
    if (!booking) throw "Booking not found.";
    if (booking.bookingStatus !== "confirmed") throw "Only confirmed bookings can receive payments.";

    let paymentMode = booking.paymentMode;
    let paymentModeName = booking.paymentModeName;
    if (paymentModeId) {
      const mode = await PaymentMode.findOne(PaymentMode.notDeletedFilter({ _id: paymentModeId, status: 1 })).select("name");
      if (!mode) throw "Payment mode not found or inactive.";
      paymentMode = mode._id;
      paymentModeName = mode.name;
    }

    // This route marks a payment "paid" the instant it's called — correct
    // for Cash (the cashier already has the money in hand) but not for
    // NETS/PayNow, which both require an actual terminal charge or a
    // scanned QR first. Without this guard, picking NETS/PayNow here (e.g.
    // the "Pay Again" balance top-up screen) silently confirmed a payment
    // nobody ever made. Those modes have their own initiate routes
    // (POST /pos/booking/nets/initiate, POST /payments/paynow/generate-qr)
    // that must be used instead.
    const normalizedModeName = paymentModeName.trim().toUpperCase();
    if (normalizedModeName === "NETS" || normalizedModeName === "PAYNOW" || normalizedModeName === "CREDIT CARD") {
      throw `${paymentModeName} payments cannot be recorded directly — use its own initiate flow instead of confirming it as already paid.`;
    }

    const { transaction, amountPaid, balanceAmount } = await applyBookingPayment(booking, amount, {
      paymentMode,
      paymentModeName,
      processedBy: req.auth?.userId ?? null,
    });

    return responseHandler({
      res,
      response: {
        receiptNo: transaction.receiptNo,
        amount: transaction.amount,
        paymentModeName,
        transactionDate: transaction.transactionDate,
        paymentStatus: booking.paymentStatus,
        amountPaid,
        balanceAmount,
      },
      successMessage:
        booking.paymentStatus === "paid" ? "Payment recorded — booking is now fully paid." : "Payment recorded successfully.",
      statusCode: 201,
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

// ─── pending payment lifecycle (PayNow/NETS — QR generated, not yet paid) ─

const PAYMENT_ATTEMPT_TTL_MS = 15 * 60 * 1000; // 15 minutes to scan & pay one QR

/**
 * Called by controllers/payments/paynow/generate-qr BEFORE it builds the QR
 * image — this is what fixes the amount a QR is generated for, the same
 * moment Cash's own amount gets fixed (createOrder's `paidAmount`). Nothing
 * confirms this payment — it only ever exists as a PENDING PosTransaction
 * until a real webhook or a manual admin confirm (controllers/pos-order-
 * confirmation) flips this SAME row to paid. Neither of those steps gets to
 * choose a different amount.
 *
 * Worst case #1 this guards against: a customer/cashier generates a second
 * QR (retry, changed their mind) while an earlier one for the same order is
 * still outstanding — the earlier PENDING row is cancelled first, so there
 * is never more than one active pending payment per order at a time and a
 * stray old QR can't later get confirmed against a since-superseded amount.
 *
 * `paymentMode`/`paymentModeName` default to the order's own, but a caller
 * SHOULD pass the mode it's actually generating a QR/terminal prompt for
 * explicitly — an installment doesn't have to match how the order was
 * originally paid (booked on Cash, balance topped up via PayNow is exactly
 * the case recordBookingPayment/applyBookingPayment already support for
 * Cash top-ups; PayNow's own generate-qr must do the same, or a PayNow
 * top-up on a Cash-booked order silently gets tagged "Cash" — which is not
 * just a display bug, it also makes the POS Order Confirmation screen's
 * own Cash-exclusion filter hide it, since Cash never needs manual
 * confirmation).
 *
 * The created transaction gets its OWN fresh `referenceId` (see the
 * model's own comment) — this function's `referenceId` parameter is only
 * ever used to look up WHICH ORDER this new attempt belongs to; it is
 * never reused as the new row's own reference. This matters in practice:
 * a booking that's topped up more than once on PayNow/NETS used to have
 * every one of those QR codes/terminal prompts carry the SAME order-level
 * reference, which a real gateway/terminal can refuse or mis-reconcile on
 * the second live attempt (it's already seen that exact reference settle
 * once) — see confirmPosPayment's own comment for the matching half of
 * this fix.
 *
 * @returns {Promise<{ order: PosOrder, transaction: PosTransaction }>}
 */
async function createPendingPayment({ referenceId, amount: requestedAmount, paymentMode, paymentModeName, processedBy }) {
  const order = await PosOrder.findOne(PosOrder.notDeletedFilter({ referenceId }));
  if (!order) throw "No order found for this reference.";
  if (order.orderStatus === "cancelled") throw "This order has been cancelled and can no longer be paid.";

  const { balance } = await resolveOutstandingBalance(order);
  if (balance <= 0.005) throw "This order is already fully paid.";
  if (requestedAmount != null && requestedAmount > balance + 0.005) {
    throw `Payment amount cannot exceed the outstanding balance of ${balance.toFixed(2)}.`;
  }
  const amount = requestedAmount != null ? requestedAmount : balance;

  // Still worth cancelling a still-open earlier attempt for the same order
  // (avoids a customer later scanning/paying a stale, abandoned QR) — but
  // this is now pure hygiene, not a correctness requirement: each row's own
  // unique referenceId means confirmPosPayment can never confuse one
  // attempt for another even if more than one were somehow left pending.
  await PosTransaction.updateMany(
    { orderId: order._id, paymentStatus: "pending" },
    { $set: { paymentStatus: "cancelled" } }
  );

  const receiptNo = await generateReceiptNumber();
  const transaction = await withUniqueReferenceId(ORIGIN_PREFIXES.POS, (txnReferenceId) =>
    PosTransaction.create({
      referenceId: txnReferenceId,
      receiptNo,
      orderId: order._id,
      bookingId: order.bookingId ?? null,
      customer: order.customer,
      paymentMode: paymentMode ?? order.paymentMode,
      paymentModeName: paymentModeName ?? order.paymentModeName,
      amount,
      paymentStatus: "pending",
      expiresAt: new Date(Date.now() + PAYMENT_ATTEMPT_TTL_MS),
      transactionDate: new Date(),
      processedBy: processedBy ?? null,
      createdBy: processedBy ?? null,
    })
  );

  return { order, transaction };
}

/**
 * POST /pos/booking/orders/:id/cancel
 * Lets go of an order that is still waiting for payment - the cashier changed the payment method, or the customer
 * walked away - so the stock it holds comes back at once instead of after the 30-minute hold. Refused when the order is
 * already confirmed or any payment on it has been received. Its open PayNow / NETS / card requests are cancelled too, so
 * a late settlement of one of them is refused rather than booked against a released order. Safe to repeat.
 */
async function cancelOrder(req, res) {
  try {
    const orderId = req.params.id;
    if (!mongoose.isValidObjectId(orderId)) throw "Invalid order ID.";
    const order = await PosOrder.findOne(PosOrder.notDeletedFilter({ _id: orderId }));
    if (!order) throw "Order not found.";
    if (order.orderStatus === "confirmed") throw "This order is already confirmed, so it cannot be cancelled.";

    if (order.orderStatus === "pending") {
      const paid = await PosTransaction.exists(PosTransaction.notDeletedFilter({ orderId: order._id, paymentStatus: "paid" }));
      if (paid) throw "A payment has already been received for this order, so it cannot be cancelled.";
      await PosTransaction.updateMany({ orderId: order._id, paymentStatus: "pending" }, { $set: { paymentStatus: "cancelled" } });
      await PosOrder.updateOne({ _id: order._id, orderStatus: "pending" }, { $set: { orderStatus: "cancelled" } });
    }
    await cancelReservations(order._id, "cancelled by the cashier");

    return responseHandler({ res, response: { _id: order._id, orderStatus: "cancelled" }, successMessage: "Order cancelled - its stock is free again." });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * Fixes a PayNow pending payment's amount AND renders its QR in one call —
 * used both by createOrder below (embeds the result straight into the
 * order-create response as `paymentDetails`, so a brand new PayNow order
 * never needs a second round trip just to see a QR) and by the standalone
 * POST /payments/paynow/generate-qr route (top-ups against an already-
 * confirmed booking, which has no "order create" response to embed into).
 *
 * Looks up the "PayNow" PaymentMode itself and always tags the pending
 * transaction with it — same reasoning as createPendingPayment's own doc
 * comment: this function only ever generates a PayNow QR, so its pending
 * transaction must always read as PayNow, regardless of what mode the
 * order was originally created/booked under.
 *
 * `referenceId` in, `referenceId` out are DIFFERENT values on purpose: the
 * one passed in identifies the ORDER (to find which one this QR is for);
 * the one returned is the freshly-minted PER-ATTEMPT reference
 * createPendingPayment just gave the new pending transaction — THAT is
 * what actually gets embedded in the QR as its EMVCo Bill Number
 * (build-payload.js) and echoed back in DBS's ICN, so every QR this
 * function ever renders — the order's first payment or its fifth top-up —
 * carries a reference no other QR has ever carried.
 */
async function buildPaynowQrForOrder({ referenceId, amount, processedBy }) {
  assertPaynowConfigured();

  const paynowMode = await PaymentMode.findOne(PaymentMode.notDeletedFilter({ name: "PAYNOW", status: 1 }));
  if (!paynowMode) throw "PayNow is not configured as an available payment mode.";

  const { transaction } = await createPendingPayment({
    referenceId,
    amount,
    paymentMode: paynowMode._id,
    paymentModeName: paynowMode.name,
    processedBy,
  });

  let qrImage, engine;
  try {
    ({ qrImage, engine } = await renderQrImage(transaction.referenceId, transaction.amount));
  } catch (renderError) {
    // The pending payment this QR promised is unconfirmable with no QR ever
    // shown for it — cancel it rather than leaving a ghost entry an admin
    // would otherwise see on the pos-order-confirmation screen for a
    // payment nobody could actually have made.
    await PosTransaction.findByIdAndUpdate(transaction._id, { paymentStatus: "cancelled" }).catch(() => {});
    throw renderError;
  }

  return { referenceId: transaction.referenceId, amount: transaction.amount, qr: qrImage, engine };
}

/**
 * The "Phase 3" NETS initiate step the comment above createOrder's NETS
 * branch already refers to — createOrder leaves a NETS order "pending"
 * with no PosTransaction at all (unlike PayNow, which gets one immediately
 * via buildPaynowQrForOrder above), so nothing exists yet for
 * dispatchPaymentConfirmation/confirmPosPayment to find and confirm. This
 * is the missing piece: fixes the amount and creates the PENDING
 * PosTransaction, exactly the way PayNow's own QR generation does, minus
 * the QR itself (a terminal payment needs no on-screen code — it's driven
 * by the EXE emitting terminal:payment:nets or terminal:payment:credit_card
 * with this same referenceId/amount).
 *
 * Shared by both NETS and Credit Card — both are "send this to the same
 * physical terminal, wait for its result" flows on the Nets-Service EXE
 * side (see its websocket-handler.js: both command types funnel into the
 * same handleTerminalPayment, differing only by a paymentType/isCreditTxn
 * flag), so the only thing that actually differs here is which PaymentMode
 * document the pending transaction gets tagged with.
 *
 * Works for both an order's first payment and a top-up on an
 * already-confirmed booking, same as buildPaynowQrForOrder — see
 * createPendingPayment's own doc comment.
 *
 * `referenceId` in identifies the ORDER; the `referenceId` this returns is
 * the pending transaction's own FRESH per-attempt reference (see
 * createPendingPayment/the model's own comment) — this is what's sent to
 * the terminal as its `orderId`, and what the terminal/EXE echoes back on
 * /payments/nets/callback, so a second top-up on the same booking never
 * sends the terminal a reference it's already seen settle once.
 */
async function initiateTerminalPayment({ referenceId, amount, processedBy, modeName }) {
  const mode = await PaymentMode.findOne(PaymentMode.notDeletedFilter({ name: modeName, status: 1 }));
  if (!mode) throw `${modeName} is not configured as an available payment mode.`;

  const { transaction } = await createPendingPayment({
    referenceId,
    amount,
    paymentMode: mode._id,
    paymentModeName: mode.name,
    processedBy,
  });

  return { referenceId: transaction.referenceId, amount: transaction.amount, currency: "SGD" };
}

async function initiateNetsPayment({ referenceId, amount, processedBy }) {
  return initiateTerminalPayment({ referenceId, amount, processedBy, modeName: "NETS" });
}

async function initiateCreditCardPayment({ referenceId, amount, processedBy }) {
  return initiateTerminalPayment({ referenceId, amount, processedBy, modeName: "CREDIT CARD" });
}

/**
 * POST /pos/booking/orders/:id/nets/initiate and
 * POST /pos/booking/orders/:id/credit-card/initiate
 * HTTP wrapper — see initiateTerminalPayment above for what this actually
 * does. The response is exactly what the Nets-Service EXE's
 * terminal:payment:nets / terminal:payment:credit_card socket call needs
 * (orderId=referenceId, amount, currency).
 */
function makeInitiateTerminalPaymentRoute(initiator, label) {
  return async function initiateTerminalPaymentRoute(req, res) {
    try {
      const orderId = req.params.id;
      if (!mongoose.isValidObjectId(orderId)) throw "Invalid order ID.";

      const order = await PosOrder.findOne(PosOrder.notDeletedFilter({ _id: orderId }));
      if (!order) throw "Order not found.";

      const result = await initiator({
        referenceId: order.referenceId,
        amount: req.body?.amount,
        processedBy: req.auth?.userId ?? null,
      });

      return responseHandler({ res, response: result, successMessage: `${label} payment initiated.` });
    } catch (error) {
      return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
    }
  };
}
const initiateNetsPaymentRoute = makeInitiateTerminalPaymentRoute(initiateNetsPayment, "NETS");
const initiateCreditCardPaymentRoute = makeInitiateTerminalPaymentRoute(initiateCreditCardPayment, "Credit Card");

/**
 * POST /pos/booking/nets/initiate and POST /pos/booking/credit-card/initiate
 * — same as the routes above, but for a balance top-up on an
 * ALREADY-CONFIRMED booking rather than a brand new order. The frontend's
 * "Pay Again" screen only has the original booking's referenceId to work
 * with (no PosOrder _id, since there's no order-create response to have
 * gotten one from) — this is the missing piece that let NETS previously
 * fall through to POST /pos/booking/bookings/:id/payments, the CASH/manual
 * instant-confirm route, silently marking a top-up "paid" with no terminal
 * ever involved. Mirrors POST /payments/paynow/generate-qr's own
 * referenceId-only shape for the exact same reason.
 */
function makeInitiateTerminalPaymentByReferenceRoute(initiator, label) {
  return async function initiateTerminalPaymentByReferenceRoute(req, res) {
    try {
      const { error, value } = initiateNetsByReferenceSchema.validate(req.body ?? {});
      if (error) throw error.details[0].message;

      const result = await initiator({
        referenceId: value.referenceId,
        amount: value.amount,
        processedBy: req.auth?.userId ?? null,
      });

      return responseHandler({ res, response: result, successMessage: `${label} payment initiated.` });
    } catch (error) {
      return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
    }
  };
}
const initiateNetsByReferenceRoute = makeInitiateTerminalPaymentByReferenceRoute(initiateNetsPayment, "NETS");
const initiateCreditCardByReferenceRoute = makeInitiateTerminalPaymentByReferenceRoute(initiateCreditCardPayment, "Credit Card");

/**
 * POST /pos/booking/manual-confirm
 *
 * Fallback for NETS/Credit Card when the terminal's own automatic
 * confirmation (controllers/payments/nets/callback) hasn't landed, or the
 * cashier would rather not wait for it — they read the transaction
 * reference number off the terminal's printed slip and key it in here
 * instead. Goes through the EXACT SAME dispatchPaymentConfirmation() ->
 * confirmPosPayment() path a real terminal callback uses, referenceId
 * lookup and all, so this works unchanged for a brand new order's first
 * payment or a "Pay Again" balance top-up (see confirmPosPayment's own
 * branching) and inherits its idempotency guarantee for free: if the
 * terminal's automatic callback lands first (or a second manual attempt is
 * submitted), confirmPosPayment recognizes the pending transaction is
 * already claimed and reports `alreadyProcessed` instead of double-booking
 * the payment.
 *
 * `manualConfirmationDetails` is what marks the resulting PosTransaction as
 * manually confirmed rather than terminal-confirmed (see
 * models/pos-transactions and confirmPosPayment's own $set) — left
 * undefined, so never written, on the automatic callback path.
 */
async function manualConfirmTerminalPayment(req, res) {
  try {
    const { error, value } = manualTerminalConfirmSchema.validate(req.body ?? {});
    if (error) throw error.details[0].message;

    const result = await dispatchPaymentConfirmation(value.referenceId, {
      gatewayReference: value.transactionRefNo,
      processedBy: req.auth?.userId ?? null,
      manualConfirmationDetails: {
        transactionRefNo: value.transactionRefNo,
        confirmedBy: req.auth?.userId ?? null,
        confirmedAt: new Date(),
      },
    });

    return responseHandler({
      res,
      response: result,
      successMessage: result.alreadyProcessed ? "This payment was already confirmed." : "Payment confirmed manually.",
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * Writes the PosBooking for an order's first payment when that payment's
 * PosTransaction ALREADY exists (created pending by createPendingPayment,
 * now claimed paid by confirmPosPayment below) — unlike
 * writePosBookingFromOrder (Cash's own synchronous path), this never
 * creates a transaction itself, only the booking, then links the two.
 */
async function writePosBookingOnly(order, amountNow, transaction) {
  const bookingNumber = await generateBookingNumber();
  const now = new Date();
  const bookingPaymentStatus = derivePaymentStatus(amountNow, order.grandTotal);

  let booking;
  try {
    booking = await PosBooking.create({
      bookingNumber,
      orderId: order._id,
      customer: order.customer,
      lines: order.lines,
      subtotal: order.subtotal,
      gstAmount: order.gstAmount,
      grandTotal: order.grandTotal,
      paymentMode: transaction.paymentMode,
      paymentModeName: transaction.paymentModeName,
      paymentStatus: bookingPaymentStatus,
      bookingStatus: "confirmed",
      portal: order.portal ?? "pos",
      bookedBy: order.bookedBy,
      entity: order.entity,
      bookedAt: now,
      createdBy: order.bookedBy ?? null,
    });
    await PosTransaction.findByIdAndUpdate(transaction._id, { bookingId: booking._id });
    await PosOrder.findByIdAndUpdate(order._id, { orderStatus: "confirmed", bookingId: booking._id });
  } catch (writeError) {
    // The transaction itself is left "paid" — best-effort cleanup here only
    // removes the half-written booking, so a retry of THIS function (not a
    // new payment) can pick the same already-paid transaction back up
    // rather than losing track of money already confirmed as received.
    if (booking) await PosBooking.deleteOne({ _id: booking._id }).catch(() => {});
    throw writeError;
  }

  const consumed = await consumeReservations(order._id, order.lines, order.bookedBy, bookingNumber);
  const shortfalls = consumed?.shortfalls ?? [];
  if (shortfalls.length > 0) {
    // Paid after the reservation expired and the stock is gone: the booking stands, flagged for a manual follow-up.
    await PosBooking.updateOne({ _id: booking._id }, { $set: { inventoryShortfall: shortfalls } });
    console.warn(`>>> [inventory] booking ${bookingNumber} confirmed with a stock shortfall:`, JSON.stringify(shortfalls));
  }
  return booking;
}

// ─── shared confirmation dispatcher entrypoint ──────────────────────────

/**
 * Registered against the "POS" prefix in controllers/payments/dispatch.js.
 * Called once a PayNow/NETS confirmation actually lands — a real DBS ICN,
 * or an admin's manual confirm (controllers/pos-order-confirmation) —
 * never at QR generation time. Confirms the SAME PENDING PosTransaction
 * createPendingPayment() already created; does not create a new one and
 * does not accept a different amount than what that row already has.
 *
 * `referenceId` identifies ONE SPECIFIC PAYMENT ATTEMPT, not the order —
 * see PosTransaction.referenceId's own comment. This function looks the
 * transaction up directly by it; it does NOT go through PosOrder first
 * (an earlier version did — that meant every QR/terminal prompt for the
 * same order, first payment or fifth top-up, carried one shared order-
 * level reference, which is exactly what let a real gateway/terminal
 * refuse or mis-reconcile a second live attempt against a booking it had
 * already settled a payment for under that identical reference).
 *
 * Idempotent two ways (worst case #2 — duplicate/racing confirmations):
 *   - A duplicate callback for a referenceId whose row is ALREADY "paid"
 *     is recognized and returned as a no-op — referenceId is unique per
 *     attempt, so that row being paid already IS the duplicate signal, no
 *     separate gatewayReference scan needed.
 *   - The actual pending -> paid transition is one atomic
 *     `findOneAndUpdate` guarded on `paymentStatus: "pending"` — if two
 *     confirmations for the same pending row race (e.g. a real webhook and
 *     a manual admin click at nearly the same moment), only the one that
 *     wins the atomic update proceeds to write the booking; the loser sees
 *     its update match nothing and reports alreadyProcessed instead of
 *     double-confirming.
 *
 * @param {string} referenceId  the PosTransaction's own per-attempt reference
 * @param {{ amount?: number, gatewayReference?: string, processedBy?: ObjectId,
 *   manualConfirmationDetails?: object, terminalConfirmationDetails?: object }} details
 *   `amount`, if given (e.g. a real gateway's own reported amount), is only
 *   ever a cross-check against the pending transaction's own fixed amount —
 *   never a value that changes what gets confirmed. The two `*Details`
 *   fields are mutually exclusive in practice (manual admin confirm vs. a
 *   real terminal callback) — see their own field comments on the model.
 */
async function confirmPosPayment(referenceId, details = {}) {
  const pending = await PosTransaction.findOne(PosTransaction.notDeletedFilter({ referenceId }));
  if (!pending) {
    throw `No payment found for reference "${referenceId}" — the QR/terminal request may need to be regenerated.`;
  }

  // Duplicate callback for an attempt that already settled — this exact
  // row already being "paid" is the whole signal now (see the module
  // comment above), so this is checked before anything else.
  if (pending.paymentStatus === "paid") {
    return { alreadyProcessed: true, transactionId: pending._id };
  }
  if (pending.paymentStatus !== "pending") {
    throw `This payment (reference "${referenceId}") is ${pending.paymentStatus} and can no longer be confirmed.`;
  }

  const order = await PosOrder.findOne(PosOrder.notDeletedFilter({ _id: pending.orderId }));
  if (!order) throw `No POS order found for this payment.`;

  if (pending.expiresAt && pending.expiresAt < new Date()) {
    await PosTransaction.findByIdAndUpdate(pending._id, { paymentStatus: "expired" });
    throw `The payment window for reference "${referenceId}" has expired — generate a new QR and try again.`;
  }

  if (details.amount != null && Math.abs(details.amount - pending.amount) > 0.005) {
    throw `Confirmation amount ${details.amount.toFixed(2)} does not match the expected amount of ${pending.amount.toFixed(2)} for this payment.`;
  }

  // Atomic claim — see the module comment above for why this specific write
  // (not a read-then-write) is what makes a race between two confirmations
  // for the same pending row safe.
  const claimed = await PosTransaction.findOneAndUpdate(
    { _id: pending._id, paymentStatus: "pending" },
    {
      $set: {
        paymentStatus: "paid",
        gatewayReference: details.gatewayReference ?? null,
        processedBy: details.processedBy ?? null,
        // Set only by controllers/pos-order-confirmation's manual admin
        // path — undefined (and so left off `$set`) for a real gateway/
        // terminal webhook, so this stays null on that path.
        ...(details.manualConfirmationDetails !== undefined ? { manualConfirmationDetails: details.manualConfirmationDetails } : {}),
        // Set only by controllers/payments/nets/callback (a genuine
        // NETS/Credit Card terminal response) — undefined, so left off
        // `$set`, for PayNow's ICN and for a manual confirm.
        ...(details.terminalConfirmationDetails !== undefined ? { terminalConfirmationDetails: details.terminalConfirmationDetails } : {}),
      },
    },
    { new: true }
  );
  if (!claimed) return { alreadyProcessed: true, transactionId: pending._id };

  // First payment for this order — nothing confirmed yet.
  if (order.orderStatus !== "confirmed") {
    const booking = await writePosBookingOnly(order, claimed.amount, claimed);
    return {
      alreadyProcessed: false,
      _id: booking._id,
      bookingNumber: booking.bookingNumber,
      referenceId: order.referenceId,
      receiptNo: claimed.receiptNo,
      paymentStatus: booking.paymentStatus,
      amountPaid: claimed.amount,
      balanceAmount: +(booking.grandTotal - claimed.amount).toFixed(2),
    };
  }

  // Booking already confirmed — this settlement is a balance top-up.
  const booking = await PosBooking.findById(order.bookingId);
  if (!booking) throw `Booking record not found for confirmed order "${referenceId}".`;
  const paidTransactions = await PosTransaction.find(
    PosTransaction.notDeletedFilter({ bookingId: booking._id })
  ).select("amount paymentStatus");
  const amountPaid = sumPaidAmount(paidTransactions);
  booking.paymentStatus = derivePaymentStatus(amountPaid, booking.grandTotal);
  await booking.save();

  return {
    alreadyProcessed: false,
    _id: booking._id,
    bookingNumber: booking.bookingNumber,
    referenceId: order.referenceId,
    receiptNo: claimed.receiptNo,
    paymentStatus: booking.paymentStatus,
    amountPaid,
    balanceAmount: +(booking.grandTotal - amountPaid).toFixed(2),
  };
}

registerPaymentHandler(ORIGIN_PREFIXES.POS, confirmPosPayment);

// ─── router assembly ──────────────────────────────────────────────────────

/** Order creation and every payment route (Cash / PayNow / NETS / card / manual confirm). Mounted on both the POS and the Admin trees. */
function registerPosOrderWriteRoutes(r) {
  r.post("/orders", requirePermission("admin-booking", "fullAccess"), validateBody(createOrderSchema), createOrder);
  r.post("/orders/:id/confirm", requirePermission("admin-booking", "fullAccess"), confirmOrder);
  r.post("/orders/:id/cancel", requirePermission("admin-booking", "fullAccess"), cancelOrder);
  r.get("/orders/:id/status", requirePermission("admin-booking", "view"), getOrderStatus);
  r.post("/orders/:id/nets/initiate", requirePermission("admin-booking", "fullAccess"), initiateNetsPaymentRoute);
  r.post("/nets/initiate", requirePermission("admin-booking", "fullAccess"), initiateNetsByReferenceRoute);
  r.post("/orders/:id/credit-card/initiate", requirePermission("admin-booking", "fullAccess"), initiateCreditCardPaymentRoute);
  r.post("/credit-card/initiate", requirePermission("admin-booking", "fullAccess"), initiateCreditCardByReferenceRoute);
  r.post("/manual-confirm", requirePermission("admin-booking", "fullAccess"), manualConfirmTerminalPayment);
}

/** The POS counter's own transactions ledger routes. */
function registerPosLedgerRoutes(r) {
  r.post("/bookings/:id/reprint", requirePermission("pos-transactions", "edit"), reprintPosBooking);
  r.post("/bookings/:id/send-email", requirePermission("pos-transactions", "edit"), sendBookingEmail);
  r.get("/bookings", requirePermission("pos-transactions", "view"), listBookings);
  r.get("/bookings/:id", requirePermission("pos-transactions", "view"), getBookingDetail);
  r.get("/bookings/:id/ticket-groups", requirePermission("pos-transactions", "view"), getBookingTicketGroups);

  r.post(
    "/bookings/:id/payments",
    requirePermission("pos-transactions", "fullAccess"),
    validateBody(recordPaymentSchema),
    recordBookingPayment
  );
}

/** Everything the POS tree needs (the Admin tree mounts the two halves separately). */
function registerPosOrderRoutes(r) {
  registerPosOrderWriteRoutes(r);
  registerPosLedgerRoutes(r);
}

module.exports = {
  registerPosOrderRoutes,
  registerPosOrderWriteRoutes,
  getBookingDetail,
  getBookingTicketGroups,
  reprintPosBooking,
  confirmPosPayment,
  // used by controllers/payments/paynow/generate-qr
  createPendingPayment,
  buildPaynowQrForOrder,
  initiateNetsPayment,
  initiateCreditCardPayment,
  resolveOutstandingBalance,
  // used by controllers/payments/nets/callback — see that function's own
  // comment for why it's called in-process instead of over HTTP
  computeBookingTicketGroups,
  // exposed for unit testing, same pattern controllers/pos/index.js uses
  createOrder,
  confirmOrder,
  cancelOrder,
  getOrderStatus,
  recordBookingPayment,
  writePosBookingFromOrder,
  writePosBookingOnly,
  manualConfirmTerminalPayment,
  listBookings,
};
