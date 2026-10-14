const { loadAlertRows, countAlerts } = require("../../common/utils/stock-alerts");
const express = require("express");
const authGuard = require("../../common/middleware/auth-guard");
const adminOnly = require("../../common/middleware/admin-only");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");

const { Transaction } = require("../../models/transactions");
const { PosTransaction } = require("../../models/pos-transactions");
const { Booking } = require("../../models/bookings");
const { PosBooking } = require("../../models/pos-bookings");
const { HallBooking } = require("../../models/hall-bookings");
const { Customer } = require("../../models/customers");
const Item = require("../../models/items");
const Service = require("../../models/services");

/**
 * Admin Panel dashboard overview — one round-trip for every KPI, chart
 * series, and activity feed the Dashboard page needs. Parallel aggregations
 * keep first paint fast instead of chaining a dozen list endpoints.
 */

function dayBounds(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function lastNDayStarts(n) {
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d);
  }
  return days;
}

function modeBucket(name) {
  const n = String(name || "")
    .trim()
    .toLowerCase();
  if (n === "cash") return "cash";
  if (n.includes("credit card")) return "creditCard";
  if (n === "nets") return "nets";
  if (n === "paynow") return "paynow";
  return "other";
}

async function sumPaidByMode(Model, dateField, start, end) {
  const rows = await Model.aggregate([
    {
      $match: {
        isDeleted: false,
        paymentStatus: "paid",
        [dateField]: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: { $toLower: { $trim: { input: { $ifNull: ["$paymentModeName", ""] } } } },
        total: { $sum: "$amount" },
        count: { $sum: 1 },
      },
    },
  ]);

  const out = { cash: 0, nets: 0, creditCard: 0, paynow: 0, other: 0, total: 0 };
  for (const row of rows) {
    const bucket = modeBucket(row._id);
    out[bucket] += row.total;
    out.total += row.total;
  }
  return out;
}

async function sumGstToday(BookingModel, dateField, start, end) {
  const [row] = await BookingModel.aggregate([
    {
      $match: {
        isDeleted: false,
        bookingStatus: { $ne: "cancelled" },
        [dateField]: { $gte: start, $lt: end },
      },
    },
    { $group: { _id: null, gst: { $sum: "$gstAmount" }, sales: { $sum: "$grandTotal" } } },
  ]);
  return { gst: row?.gst ?? 0, sales: row?.sales ?? 0 };
}

async function dailyCollectionSeries(days) {
  const start = days[0];
  const end = new Date(days[days.length - 1]);
  end.setDate(end.getDate() + 1);

  const [adminRows, posRows] = await Promise.all([
    Transaction.aggregate([
      {
        $match: {
          isDeleted: false,
          paymentStatus: "paid",
          transactionDate: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$transactionDate",
              timezone: "Asia/Singapore",
            },
          },
          total: { $sum: "$amount" },
        },
      },
    ]),
    PosTransaction.aggregate([
      {
        $match: {
          isDeleted: false,
          paymentStatus: "paid",
          transactionDate: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$transactionDate",
              timezone: "Asia/Singapore",
            },
          },
          total: { $sum: "$amount" },
        },
      },
    ]),
  ]);

  const map = new Map();
  for (const r of [...adminRows, ...posRows]) {
    map.set(r._id, (map.get(r._id) || 0) + r.total);
  }

  const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days.map((d) => {
    const key = localDateKey(d);
    return {
      date: key,
      label: DAY_LABELS[d.getDay()],
      amount: +(map.get(key) || 0).toFixed(2),
    };
  });
}

function mapBookingFeed(b, source) {
  const firstService =
    (b.lines || []).find((l) => l.refType === "Service")?.name ||
    (b.lines || [])[0]?.name ||
    "—";
  return {
    id: String(b._id),
    number: b.bookingNumber,
    customerName: b.customerInfo?.name || "Walk-in",
    serviceName: firstService,
    amount: b.grandTotal,
    paymentStatus: b.paymentStatus,
    bookingStatus: b.bookingStatus,
    portal: b.portal || source,
    bookedAt: b.bookedAt,
  };
}

async function overview(_req, res) {
  try {
    const { start: todayStart, end: todayEnd } = dayBounds();
    const weekDays = lastNDayStarts(7);
    const weekStart = weekDays[0];

    const [
      adminModesToday,
      posModesToday,
      adminGst,
      posGst,
      onlineSales,
      dailySeries,
      activeCustomers,
      activeServices,
      activeItems,
      lowStockItems,
      recentPos,
      recentPortal,
      pendingCancellations,
      pendingRefunds,
      pendingCancelList,
      lowStockCount,
    ] = await Promise.all([
      sumPaidByMode(Transaction, "transactionDate", todayStart, todayEnd),
      sumPaidByMode(PosTransaction, "transactionDate", todayStart, todayEnd),
      sumGstToday(Booking, "bookedAt", todayStart, todayEnd),
      sumGstToday(PosBooking, "bookedAt", todayStart, todayEnd),
      Booking.aggregate([
        {
          $match: {
            isDeleted: false,
            bookingStatus: { $ne: "cancelled" },
            portal: { $in: ["admin", "customer"] },
            bookedAt: { $gte: todayStart, $lt: todayEnd },
          },
        },
        { $group: { _id: null, total: { $sum: "$grandTotal" } } },
      ]),
      dailyCollectionSeries(weekDays),
      Customer.countDocuments(Customer.notDeletedFilter({ status: 1 })),
      Service.countDocuments(Service.notDeletedFilter({ status: 1 })),
      Item.countDocuments(Item.notDeletedFilter({ status: 1 })),
      loadAlertRows("low").then((rows) => rows.sort((a, b) => a.availableStock - b.availableStock).slice(0, 5)),
      PosBooking.find(PosBooking.notDeletedFilter({ bookingStatus: "confirmed" }))
        .select("bookingNumber customerInfo lines grandTotal paymentStatus bookingStatus bookedAt")
        .sort({ bookedAt: -1 })
        .limit(5)
        .lean(),
      Booking.find(
        Booking.notDeletedFilter({
          portal: { $in: ["admin", "customer"] },
        })
      )
        .select(
          "bookingNumber customerInfo lines grandTotal paymentStatus bookingStatus portal bookedAt"
        )
        .sort({ bookedAt: -1 })
        .limit(5)
        .lean(),
      HallBooking.countDocuments(
        HallBooking.notDeletedFilter({
          bookingStatus: "cancelled",
          "refund.status": { $ne: "processed" },
        })
      ),
      HallBooking.countDocuments(
        HallBooking.notDeletedFilter({
          "refund.status": "pending",
        })
      ),
      HallBooking.find(
        HallBooking.notDeletedFilter({
          bookingStatus: "cancelled",
          "refund.status": { $ne: "processed" },
        })
      )
        .select("bookingNumber customerInfo finalAmount cancellation refund bookedAt")
        .sort({ "cancellation.cancelledAt": -1, bookedAt: -1 })
        .limit(5)
        .lean(),
      countAlerts("low"),
    ]);

    const cashCollection = +(adminModesToday.cash + posModesToday.cash).toFixed(2);
    const netsCollection = +(adminModesToday.nets + posModesToday.nets).toFixed(2);
    const creditCardCollection = +(adminModesToday.creditCard + posModesToday.creditCard).toFixed(2);
    const otherCollection = +(adminModesToday.other + posModesToday.other).toFixed(2);
    const paynowCollection = +(adminModesToday.paynow + posModesToday.paynow).toFixed(2);
    const todayPosSales = +posModesToday.total.toFixed(2);
    const todayCollections = +(adminModesToday.total + posModesToday.total).toFixed(2);
    const todayOnlineBookings = +(onlineSales[0]?.total || 0).toFixed(2);
    const totalGstCollected = +(adminGst.gst + posGst.gst).toFixed(2);

    // Every paid mode gets a slice (incl. "Other") so the donut total always
    // equals Today's Collections.
    const paymentBreakdownTotal =
      cashCollection + netsCollection + creditCardCollection + paynowCollection + otherCollection;
    const pct = (amount) =>
      paymentBreakdownTotal ? +((amount / paymentBreakdownTotal) * 100).toFixed(1) : 0;
    const paymentBreakdown = [
      { mode: "Cash", amount: cashCollection, percent: pct(cashCollection), color: "#7c1527" },
      { mode: "NETS", amount: netsCollection, percent: pct(netsCollection), color: "#e67e22" },
      { mode: "Credit Card", amount: creditCardCollection, percent: pct(creditCardCollection), color: "#2f6f9f" },
      { mode: "PayNow", amount: paynowCollection, percent: pct(paynowCollection), color: "#6b8e23" },
      { mode: "Other", amount: otherCollection, percent: pct(otherCollection), color: "#8a7a6a" },
    ];

    return responseHandler({
      res,
      response: {
        kpis: {
          todayCollections,
          todayPosSales,
          todayOnlineBookings,
          cashCollection,
          netsCollection,
          creditCardCollection,
          paynowCollection,
          totalGstCollected,
          pendingCancellations,
          pendingRefunds,
          lowStockItems: lowStockCount,
          activeCustomers,
          activeServices,
          activeItems,
        },
        charts: {
          dailyCollection: dailySeries,
          paymentBreakdown,
        },
        feeds: {
          recentPosTransactions: recentPos.map((b) => mapBookingFeed(b, "pos")),
          recentPortalBookings: recentPortal.map((b) => mapBookingFeed(b, b.portal || "admin")),
          lowStockAlerts: lowStockItems.map((i) => ({
            id: String(i._id),
            name: i.name,
            code: i.code,
            currentStock: i.availableStock,
            threshold: i.threshold,
          })),
          pendingCancellations: pendingCancelList.map((b) => ({
            id: String(b._id),
            number: b.bookingNumber,
            customerName: b.customerInfo?.name || "—",
            reason: b.cancellation?.reason || "Cancellation requested",
            amount: b.finalAmount,
            status: b.refund?.status === "pending" ? "Requested" : "Cancelled",
          })),
        },
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

const router = express.Router();
router.use(authGuard, adminOnly);
router.get("/overview", overview);

module.exports = router;
