const { getReportSource } = require("./report-sources");
const { dayBounds, templeToday } = require("../utils/stock-ledger");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Cash first, then the electronic modes in the order a counter lists them; anything else follows alphabetically.
const MODE_ORDER = ["CASH", "PAYNOW", "NETS", "CREDIT CARD"];
const modeRank = (m) => {
  const i = MODE_ORDER.indexOf(m);
  return i === -1 ? MODE_ORDER.length : i;
};
const byModeOrder = (a, b) => modeRank(a.mode) - modeRank(b.mode) || a.mode.localeCompare(b.mode);

/**
 * Collection summary for one day or an inclusive range of days (the temple's own Singapore days): how much was
 * collected, and how many payments, per payment mode, per source (POS Counter / Admin Booking / Hall Booking) and per
 * cashier, with the manually confirmed share shown separately. Built from the same payment rows as the Payment Report
 * (paid payments only, a balance top-up counts on the day the money was received), so the two always agree.
 * @param {{ from?: string, to?: string }} range "YYYY-MM-DD"; both default to today
 */
async function buildDailyCollection({ from, to } = {}) {
  const fromDay = from || templeToday();
  const toDay = to || fromDay;
  const { start } = dayBounds(fromDay);
  const { end } = dayBounds(toDay);
  if (end <= start) throw "The end date cannot be before the start date.";

  const source = getReportSource("payments");
  const groups = await source.model.aggregate([
    ...source.basePipeline,
    { $match: { _paymentDate: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: {
          mode: { $toUpper: { $ifNull: ["$_paymentModeName", "UNKNOWN"] } },
          source: { $ifNull: ["$_source", ""] },
          cashier: { $ifNull: ["$_processedByName", ""] },
          manual: { $ifNull: ["$_isManuallyConfirmed", false] },
        },
        count: { $sum: 1 },
        total: { $sum: "$_amount" },
      },
    },
  ]).allowDiskUse(true);

  const add = (map, key, g, extra = {}) => {
    const row = map.get(key) ?? { ...extra, count: 0, total: 0, manualCount: 0, manualTotal: 0 };
    row.count += g.count;
    row.total += g.total;
    if (g._id.manual) {
      row.manualCount += g.count;
      row.manualTotal += g.total;
    }
    map.set(key, row);
  };

  const modes = new Map();
  const sources = new Map();
  const cashiers = new Map();
  const grand = { count: 0, total: 0, manualCount: 0, manualTotal: 0 };
  for (const g of groups) {
    add(modes, g._id.mode, g, { mode: g._id.mode });
    add(sources, g._id.source || "Other", g, { source: g._id.source || "Other" });
    add(cashiers, g._id.cashier || "Automatic (no cashier)", g, { cashier: g._id.cashier || "Automatic (no cashier)" });
    grand.count += g.count;
    grand.total += g.total;
    if (g._id.manual) {
      grand.manualCount += g.count;
      grand.manualTotal += g.total;
    }
  }

  const clean = (row) => ({ ...row, total: round2(row.total), manualTotal: round2(row.manualTotal) });
  // Each mode's total per source, so the screen and the Excel can show the cash / PayNow / NETS split of every source.
  const matrix = new Map();
  for (const g of groups) {
    const key = g._id.source || "Other";
    const row = matrix.get(key) ?? { source: key, modes: {} };
    row.modes[g._id.mode] = round2((row.modes[g._id.mode] ?? 0) + g.total);
    matrix.set(key, row);
  }

  return {
    from: fromDay,
    to: toDay,
    grand: clean(grand),
    byMode: [...modes.values()].map(clean).sort(byModeOrder),
    bySource: [...sources.values()].map(clean).sort((a, b) => b.total - a.total),
    byCashier: [...cashiers.values()].map(clean).sort((a, b) => b.total - a.total),
    sourceModeMatrix: [...matrix.values()],
  };
}

module.exports = { buildDailyCollection };
