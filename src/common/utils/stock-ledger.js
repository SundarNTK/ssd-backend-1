/**
 * The stock ledger behind the Available Stock screen, for one day or a from - to range of days:
 *
 *   Opening      = the previous day's Stock in Hand
 *   + Adj In     stock added by hand (Inventory Adjustment or Available Stock)
 *   - Adj Out    stock removed by hand
 *   - Sales      taken out by bookings (and by Stock Reserve on a session date)
 *   +/- E/S Adj  excess / short found by a physical count
 *   = Stock in Hand (closing)
 *
 * Reserved is shown for the day the stock is needed (a booking made on the 26th for the 27th is Reserved on the 27th,
 * not the 26th) and only while it has not been taken out yet - once taken out it is already in Sales. Available =
 * Stock in Hand - Reserved. Everything is read back from the movement log (every movement stores the stock before
 * and after it), so any past date can be rebuilt without keeping daily snapshots.
 *
 * For a range the opening is the first day's opening, the movements are totals over the range, and Stock in Hand is the
 * last day's closing. Days are the temple's own Singapore calendar days.
 */
const mongoose = require("mongoose");
const InventoryAdjustment = require("../../models/inventory-adjustments");
const StockReserve = require("../../models/stock-reserves");
const PhysicalStockCount = require("../../models/physical-stock-counts");

const DAY_MS = 24 * 60 * 60 * 1000;
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const SALE_SOURCES = ["Booking", "Stock Reserve"];

/** Today in Singapore, "YYYY-MM-DD". */
function templeToday(now = Date.now()) {
  return new Date(now + SGT_OFFSET_MS).toISOString().slice(0, 10);
}

/** [start, end) of a Singapore day as UTC instants. Throws a plain message for a malformed date. */
function dayBounds(day) {
  if (!DAY.test(String(day || "")) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw "Enter a valid date (YYYY-MM-DD).";
  const start = new Date(`${day}T00:00:00+08:00`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

const key = (type, id) => `${type}:${id}`;

/**
 * Ledger figures of every given master for a day (`from` only) or an inclusive range of days (`from` - `to`).
 * @param {{refType: string, _id: any, currentStock?: number}[]} masters
 * @returns {Promise<Map<string, object>>} keyed "Type:id"
 */
async function buildLedger(masters, from, to = from) {
  const { start } = dayBounds(from);
  const { end } = dayBounds(to);
  if (end <= start) throw "The end date cannot be before the start date.";
  const ids = masters.map((m) => new mongoose.Types.ObjectId(String(m._id)));
  const refMatch = { refId: { $in: ids } };
  // Rows stored before previousStock existed: derive it from the balance and the direction.
  const prevExpr = {
    $ifNull: ["$previousStock", { $cond: [{ $eq: ["$inventoryType", "Stock In"] }, { $subtract: ["$balance", "$quantity"] }, { $add: ["$balance", "$quantity"] }] }],
  };
  const order = { createdAt: 1, _id: 1 };

  const [lastBefore, firstEver, movements, reserved, counts] = await Promise.all([
    InventoryAdjustment.aggregate([
      { $match: { ...refMatch, createdAt: { $lt: start } } },
      { $sort: order },
      { $group: { _id: { t: "$refType", i: "$refId" }, balance: { $last: "$balance" } } },
    ]),
    InventoryAdjustment.aggregate([
      { $match: refMatch },
      { $sort: order },
      { $group: { _id: { t: "$refType", i: "$refId" }, previous: { $first: prevExpr } } },
    ]),
    InventoryAdjustment.aggregate([
      { $match: { ...refMatch, createdAt: { $gte: start, $lt: end } } },
      { $group: { _id: { t: "$refType", i: "$refId", type: "$inventoryType", source: "$source" }, qty: { $sum: "$quantity" } } },
    ]),
    // Needed on this day and not taken out by the end of it.
    StockReserve.aggregate([
      {
        $match: {
          ...refMatch,
          sessionDate: { $gte: from, $lte: to },
          status: { $ne: "cancelled" },
          $or: [{ processedAt: null }, { processedAt: { $gte: end } }],
        },
      },
      { $group: { _id: { t: "$refType", i: "$refId" }, qty: { $sum: "$stockQuantity" } } },
    ]),
    PhysicalStockCount.aggregate([
      { $match: { ...refMatch, countDate: { $gte: from, $lte: to } } },
      { $sort: { createdAt: 1, _id: 1 } },
      { $group: { _id: { t: "$refType", i: "$refId" }, physical: { $last: "$physicalQuantity" }, at: { $last: "$createdAt" } } },
    ]),
  ]);

  const lastBeforeBy = new Map(lastBefore.map((g) => [key(g._id.t, g._id.i), g.balance]));
  const firstEverBy = new Map(firstEver.map((g) => [key(g._id.t, g._id.i), g.previous]));
  const reservedBy = new Map(reserved.map((g) => [key(g._id.t, g._id.i), g.qty]));
  const countBy = new Map(counts.map((g) => [key(g._id.t, g._id.i), g]));
  const moveBy = new Map();
  for (const g of movements) {
    const k = key(g._id.t, g._id.i);
    const m = moveBy.get(k) ?? { adjIn: 0, adjOut: 0, sales: 0, excessShort: 0 };
    const isIn = g._id.type === "Stock In";
    if (g._id.source === "Physical Count") m.excessShort += isIn ? g.qty : -g.qty;
    else if (SALE_SOURCES.includes(g._id.source)) m.sales += isIn ? -g.qty : g.qty;
    else if (isIn) m.adjIn += g.qty;
    else m.adjOut += g.qty;
    moveBy.set(k, m);
  }

  const out = new Map();
  for (const m of masters) {
    const k = key(m.refType, m._id);
    const mv = moveBy.get(k) ?? { adjIn: 0, adjOut: 0, sales: 0, excessShort: 0 };
    // Closed day before it: its last balance. Never moved before: the stock before its first movement ever, or - with
    // no movements at all - what it holds now.
    const opening = lastBeforeBy.get(k) ?? firstEverBy.get(k) ?? m.currentStock ?? 0;
    const stockInHand = opening + mv.adjIn - mv.adjOut - mv.sales + mv.excessShort;
    const reservedQty = reservedBy.get(k) ?? 0;
    const count = countBy.get(k);
    out.set(k, {
      openingQuantity: opening,
      adjInQuantity: mv.adjIn,
      adjOutQuantity: mv.adjOut,
      salesQuantity: mv.sales,
      excessShortQuantity: mv.excessShort,
      stockInHandQuantity: stockInHand,
      reservedForDayQuantity: reservedQty,
      availableForDayQuantity: stockInHand - reservedQty,
      physicalCountQuantity: count ? count.physical : null,
      physicalCountAt: count ? count.at : null,
    });
  }
  return out;
}

module.exports = { buildLedger, dayBounds, templeToday, DAY };
