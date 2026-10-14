/**
 * The stock-alert rules, in one place (the Low Stock / Out of Stock report and the dashboard use the same ones).
 *
 *   available = physical - reserved           (the "Available" figure of the Available Stock screen)
 *   Low Stock     the master has a threshold (> 0) and 0 < available <= threshold   (reaching the threshold counts)
 *   Out of Stock  available <= 0                                                    (sold out, or fully reserved)
 *
 * Only active masters with inventory switched on are considered. An item without a threshold (0) is never "low" -
 * it has no limit to reach - but does show as out of stock at 0.
 */
const Item = require("../../models/items");
const Service = require("../../models/services");
const GeneralItem = require("../../models/general-items");

const SPECS = [
  { refType: "Item", Model: Item, flag: "isInventoryApplicable", thresholdKey: "threshold" },
  { refType: "Service", Model: Service, flag: "isInventoryRequired", thresholdKey: "thresholdCount" },
  { refType: "GeneralItem", Model: GeneralItem, flag: "isInventoryApplicable", thresholdKey: "threshold" },
];

const availableExpr = { $subtract: [{ $ifNull: ["$currentStock", 0] }, { $ifNull: ["$reservedStock", 0] }] };
const thresholdExpr = (spec) => ({ $ifNull: [`$${spec.thresholdKey}`, 0] });

/** Mongo filter for the masters of `spec` in the given alert state ("low" | "out"). */
function alertFilter(spec, kind) {
  const base = spec.Model.notDeletedFilter({ [spec.flag]: true, status: 1 });
  const threshold = thresholdExpr(spec);
  base.$expr =
    kind === "low"
      ? { $and: [{ $gt: [threshold, 0] }, { $gt: [availableExpr, 0] }, { $lte: [availableExpr, threshold] }] }
      : { $lte: [availableExpr, 0] };
  return base;
}

const toRow = (spec, r) => {
  const physical = r.currentStock ?? 0;
  const reserved = r.reservedStock ?? 0;
  return {
    _id: r._id,
    refType: spec.refType,
    name: r.name,
    code: r.code,
    currentStock: physical,
    reservedStock: reserved,
    availableStock: physical - reserved,
    threshold: r[spec.thresholdKey] ?? 0,
    unitOfMeasure: r.unitOfMeasure ?? null,
  };
};

/**
 * Every master in the alert state, merged across Items, Services and General Items (separate collections, so merged
 * in application code like the other stock lists). `search` is an optional RegExp on name/code; `type` limits to one.
 */
async function loadAlertRows(kind, { search = null, type = null } = {}) {
  const lists = await Promise.all(
    SPECS.filter((s) => !type || s.refType === type).map(async (spec) => {
      const filter = alertFilter(spec, kind);
      if (search) filter.$and = [...(filter.$and || []), { $or: [{ name: search }, { code: search }] }];
      const rows = await spec.Model.find(filter).select(`name code currentStock reservedStock ${spec.thresholdKey} unitOfMeasure`).lean();
      return rows.map((r) => toRow(spec, r));
    })
  );
  return lists.flat();
}

/** Counts only (dashboard badge). */
async function countAlerts(kind) {
  const counts = await Promise.all(SPECS.map((spec) => spec.Model.countDocuments(alertFilter(spec, kind))));
  return counts.reduce((a, b) => a + b, 0);
}

module.exports = { loadAlertRows, countAlerts, SPECS };
