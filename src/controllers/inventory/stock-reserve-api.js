/**
 * Stock Reserve screen API (mounted under /inventory by controllers/inventory/index.js):
 *   GET  /stock-reserves/summary         the cards
 *   GET  /stock-reserves                 date-wise list with filters
 *   GET  /stock-reserves/:id             one reservation in full
 *   POST /stock-reserves/process-due     run the scheduler's pass now
 *   POST /stock-reserves/:id/retry       process one reservation (failed, or due) again
 *   POST /stock-reserves/:id/cancel      drop a reservation that has not taken stock
 *   GET  /stock-holds                    Stock Hold list (orders waiting for payment) - separate from Reserve
 */
const mongoose = require("mongoose");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");
const escapeRegex = require("../../common/utils/escape-regex");
const StockReserve = require("../../models/stock-reserves");
const InventoryReservation = require("../../models/inventory-reservations");
const InventoryAdjustment = require("../../models/inventory-adjustments");
const { PosOrder } = require("../../models/pos-orders");
const { Order } = require("../../models/orders");
const { PosBooking } = require("../../models/pos-bookings");
const { Booking } = require("../../models/bookings");
const { REF_MODELS } = require("../../common/utils/inventory-stock");
const { templeToday } = require("../../common/utils/session-rule");
const { processReserve, processDueReserves, cancelReserve } = require("../../common/utils/stock-reserve");

const STATUS_LABELS = {
  upcoming: "Upcoming",
  due: "Due for Processing",
  processing: "Processing",
  processed: "Processed",
  partial: "Partially Fulfilled",
  shortage: "Stock Shortage",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** The status shown on screen, worked out from what actually happened (not stored). */
function displayStatus(doc, today) {
  if (doc.status === "upcoming") return doc.sessionDate <= today ? "due" : "upcoming";
  return doc.status;
}

/** Mongo clause for one screen status. */
function statusClause(key, today) {
  switch (key) {
    case "upcoming":
      return { status: "upcoming", sessionDate: { $gt: today } };
    case "due":
      return { status: "upcoming", sessionDate: { $lte: today } };
    case "processing":
    case "processed":
    case "partial":
    case "shortage":
    case "failed":
    case "cancelled":
      return { status: key };
    default:
      return null;
  }
}

const toRow = (d, today) => ({
  _id: d._id,
  sessionDate: d.sessionDate,
  refType: d.refType,
  refId: d.refId,
  name: d.name,
  code: d.code,
  bookedQuantity: d.bookedQuantity,
  reductionFactor: d.reductionFactor,
  // "Total Reserved Quantity" and "Required Stock Deduction" are the same number: the stock units to take out.
  reservedQuantity: d.stockQuantity,
  availableBefore: d.availableBefore,
  requiredDeduction: d.stockQuantity,
  deductedQuantity: d.deductedQuantity,
  shortageQuantity: d.shortageQuantity,
  fulfilledQuantity: d.fulfilledQuantity,
  status: displayStatus(d, today),
  statusLabel: STATUS_LABELS[displayStatus(d, today)],
  processedAt: d.processedAt,
  bookingNumber: d.bookingNumber,
  orderId: d.orderId,
  lateConfirmation: d.lateConfirmation,
  attempts: d.attempts,
  lastError: d.lastError,
  createdAt: d.createdAt,
});

const fail = (res, error) => exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });

async function summary(req, res) {
  try {
    const today = templeToday();
    const open = { $in: ["upcoming", "processing", "failed"] };
    const [reserved, upcoming, dueToday, dueTodayOpen, processed, deficits, failed] = await Promise.all([
      StockReserve.aggregate([{ $match: { status: open } }, { $group: { _id: null, qty: { $sum: "$stockQuantity" }, count: { $sum: 1 } } }]),
      StockReserve.countDocuments({ status: "upcoming", sessionDate: { $gt: today } }),
      StockReserve.countDocuments({ sessionDate: today, status: { $ne: "cancelled" } }),
      StockReserve.countDocuments({ sessionDate: today, status: { $in: ["upcoming", "processing", "failed"] } }),
      StockReserve.countDocuments({ status: "processed" }),
      StockReserve.aggregate([{ $match: { status: { $in: ["partial", "shortage"] }, shortageQuantity: { $gt: 0 } } }, { $group: { _id: null, qty: { $sum: "$shortageQuantity" }, count: { $sum: 1 } } }]),
      StockReserve.countDocuments({ status: "failed" }),
    ]);
    return responseHandler({
      res,
      response: {
        today,
        totalReservedQuantity: reserved[0]?.qty ?? 0,
        totalReservedCount: reserved[0]?.count ?? 0,
        upcomingReservations: upcoming,
        dueToday,
        dueTodayStillToProcess: dueTodayOpen,
        processedReservations: processed,
        pendingDeficitQuantity: deficits[0]?.qty ?? 0,
        pendingDeficitCount: deficits[0]?.count ?? 0,
        failedReservations: failed,
      },
    });
  } catch (error) {
    return fail(res, error);
  }
}

async function list(req, res) {
  try {
    const today = templeToday();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    const filter = {};

    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "")) filter.sessionDate = req.query.date;
    else {
      const range = {};
      if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "")) range.$gte = req.query.from;
      if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "")) range.$lte = req.query.to;
      if (Object.keys(range).length) filter.sessionDate = range;
    }
    if (mongoose.isValidObjectId(req.query.refId)) filter.refId = req.query.refId;
    if (["Item", "Service", "GeneralItem"].includes(req.query.refType)) filter.refType = req.query.refType;
    const and = [];
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(String(req.query.search).trim()), "i");
      and.push({ $or: [{ name: rx }, { code: rx }] });
    }
    if (req.query.order) {
      const rx = new RegExp(escapeRegex(String(req.query.order).trim()), "i");
      const or = [{ bookingNumber: rx }];
      if (mongoose.isValidObjectId(req.query.order)) or.push({ orderId: req.query.order });
      and.push({ $or: or });
    }
    const sc = statusClause(req.query.status, today);
    if (sc) and.push(sc);
    if (and.length) filter.$and = and;

    const [rows, total] = await Promise.all([
      StockReserve.find(filter)
        .sort({ sessionDate: -1, createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      StockReserve.countDocuments(filter),
    ]);
    return responseHandler({ res, response: { items: rows.map((d) => toRow(d, today)), total, page, pageSize, today } });
  } catch (error) {
    return fail(res, error);
  }
}

async function detail(req, res) {
  try {
    const today = templeToday();
    if (!mongoose.isValidObjectId(req.params.id)) throw "Invalid reservation id.";
    const d = await StockReserve.findById(req.params.id).populate("history.by", "name").lean();
    if (!d) throw "Reservation not found.";

    const Model = REF_MODELS[d.refType];
    const [master, order, booking, movements] = await Promise.all([
      Model.findById(d.refId).select("name code currentStock reservedStock isDeleted status").lean(),
      d.orderId ? Promise.all([PosOrder.findById(d.orderId).lean(), Order.findById(d.orderId).lean()]).then(([a, b]) => a || b) : null,
      d.bookingNumber ? Promise.all([PosBooking.findOne({ bookingNumber: d.bookingNumber }).lean(), Booking.findOne({ bookingNumber: d.bookingNumber }).lean()]).then(([a, b]) => a || b) : null,
      InventoryAdjustment.find({ requestId: { $regex: `^reserve:${d._id}:` } }).sort({ createdAt: 1 }).lean(),
    ]);

    return responseHandler({
      res,
      response: {
        ...toRow(d, today),
        history: (d.history || []).map((h) => ({ at: h.at, event: h.event, quantity: h.quantity, message: h.message, source: h.source, by: h.by?.name ?? null })),
        stock: master
          ? { physical: master.currentStock ?? 0, reserved: master.reservedStock ?? 0, available: Math.max(0, (master.currentStock ?? 0) - (master.reservedStock ?? 0)), active: master.status === 1 && !master.isDeleted }
          : null,
        order: order
          ? { orderNumber: order.orderNumber, referenceId: order.referenceId ?? null, orderStatus: order.orderStatus, paymentModeName: order.paymentModeName, grandTotal: order.grandTotal, portal: order.portal, createdAt: order.createdAt }
          : null,
        booking: booking
          ? { bookingNumber: booking.bookingNumber, bookingStatus: booking.bookingStatus, paymentStatus: booking.paymentStatus, grandTotal: booking.grandTotal, portal: booking.portal, bookedAt: booking.bookedAt, customer: booking.customerDetails ?? null }
          : null,
        movements: movements.map((m) => ({ at: m.createdAt, type: m.inventoryType, quantity: m.quantity, previousStock: m.previousStock, balance: m.balance, remarks: m.remarks })),
      },
    });
  } catch (error) {
    return fail(res, error);
  }
}

async function retry(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw "Invalid reservation id.";
    const result = await processReserve(req.params.id, { userId: req.auth?.userId || null, source: "manual" });
    if (result.skipped) throw "This reservation can't be processed now - its session date has not arrived, or it is already processed or being processed.";
    if (result.failed) throw `Processing failed again: ${result.error}`;
    return responseHandler({
      res,
      response: result,
      successMessage: result.shortage > 0 ? `Processed with a shortage of ${result.shortage}.` : "Reservation processed.",
    });
  } catch (error) {
    return fail(res, error);
  }
}

async function processDue(req, res) {
  try {
    const result = await processDueReserves();
    return responseHandler({ res, response: result, successMessage: result.due === 0 ? "Nothing is due for processing." : `${result.processed} of ${result.due} reservation(s) processed.` });
  } catch (error) {
    return fail(res, error);
  }
}

async function cancel(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw "Invalid reservation id.";
    const done = await cancelReserve(req.params.id, { reason: String(req.body?.reason || "Cancelled by an administrator").slice(0, 200), userId: req.auth?.userId || null });
    if (!done) throw "Only a reservation that has not taken any stock yet can be cancelled.";
    return responseHandler({ res, response: { _id: done._id, status: done.status }, successMessage: "Reservation cancelled." });
  } catch (error) {
    return fail(res, error);
  }
}

/** The Stock Hold list: orders still waiting for payment (their 30-minute holds). Reserve rows are NOT in here. */
async function holds(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    const filter = { status: "active" };
    // Search by item / service name or code: find the matching masters first, then the holds on them.
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(String(req.query.search).trim()), "i");
      const ids = [];
      for (const type of ["Item", "Service", "GeneralItem"]) {
        for (const m of await REF_MODELS[type].find({ $or: [{ name: rx }, { code: rx }] }).select("_id").lean()) ids.push(m._id);
      }
      filter.refId = { $in: ids };
    }
    const [rows, total] = await Promise.all([
      InventoryReservation.find(filter)
        .sort({ expiresAt: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      InventoryReservation.countDocuments(filter),
    ]);
    const names = new Map();
    for (const type of ["Item", "Service", "GeneralItem"]) {
      const ids = rows.filter((r) => r.refType === type).map((r) => r.refId);
      if (!ids.length) continue;
      for (const m of await REF_MODELS[type].find({ _id: { $in: ids } }).select("name code").lean()) names.set(`${type}:${m._id}`, m);
    }
    // The order each hold belongs to, by its readable number (POS... / admin order number) rather than the internal id.
    const orderIds = [...new Set(rows.map((r) => String(r.orderId)))];
    const orders = new Map();
    for (const Model of [PosOrder, Order]) {
      for (const o of await Model.find({ _id: { $in: orderIds } }).select("orderNumber portal").lean()) orders.set(String(o._id), o);
    }
    const now = Date.now();
    const items = rows.map((r) => ({
      _id: r._id,
      refType: r.refType,
      name: names.get(`${r.refType}:${r.refId}`)?.name ?? "—",
      code: names.get(`${r.refType}:${r.refId}`)?.code ?? "—",
      orderId: r.orderId,
      orderNumber: orders.get(String(r.orderId))?.orderNumber ?? null,
      portal: orders.get(String(r.orderId))?.portal ?? null,
      bookedQuantity: r.quantity,
      heldQuantity: r.stockQuantity ?? r.quantity,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      minutesLeft: Math.max(0, Math.ceil((new Date(r.expiresAt).getTime() - now) / 60000)),
    }));
    return responseHandler({ res, response: { items, total, page, pageSize } });
  } catch (error) {
    return fail(res, error);
  }
}

module.exports = { summary, list, detail, retry, processDue, cancel, holds, displayStatus, STATUS_LABELS };
