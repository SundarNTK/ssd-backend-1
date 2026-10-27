const { getReportSource } = require("./report-sources");
const { dayBounds, templeToday } = require("../utils/stock-ledger");
const DailyCollectionEntry = require("../../models/daily-collection-entries");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Cash first, then the electronic modes in the order a counter lists them; anything else follows alphabetically.
const MODE_ORDER = ["CASH", "PAYNOW", "NETS", "CREDIT CARD"];
const modeRank = (m) => {
  const i = MODE_ORDER.indexOf(m);
  return i === -1 ? MODE_ORDER.length : i;
};
const byModeOrder = (a, b) => modeRank(a.mode) - modeRank(b.mode) || a.mode.localeCompare(b.mode);

const MATCH_TOLERANCE = 0.005;
const statusOf = (difference) => (Math.abs(difference) < MATCH_TOLERANCE ? "matched" : difference > 0 ? "excess" : "shortage");

/**
 * Sets what the temple says it collected (Daily Collection Entry) beside what the bookings say, per day and payment
 * mode. difference = entered - system: positive is an EXCESS (more money counted than the bookings explain), negative
 * a SHORTAGE. A day and mode the system has takings for but nobody entered is "not-entered"; a mode with neither
 * takings nor an entry is left out. `byMode` only compares the days that were actually entered, so a day nobody has
 * entered yet shows up as "Not entered", never as a shortage.
 * @param {{ _id: { mode: string, day: string }, total: number }[]} groups system takings
 * @param {{ date: string, paymentModeName: string, amount: number, remarks?: string }[]} entries
 */
function buildReconciliation(groups, entries) {
  const system = new Map(); // "day|MODE" -> amount
  for (const g of groups) {
    const key = `${g._id.day}|${g._id.mode}`;
    system.set(key, (system.get(key) ?? 0) + g.total);
  }
  const entered = new Map();
  for (const e of entries) entered.set(`${e.date}|${String(e.paymentModeName).toUpperCase()}`, e);

  const keys = [...new Set([...system.keys(), ...entered.keys()])];
  const rows = keys
    .map((key) => {
      const [date, mode] = key.split("|");
      const sys = round2(system.get(key) ?? 0);
      const entry = entered.get(key);
      if (!entry) return sys > 0 ? { date, mode, system: sys, entered: null, difference: null, status: "not-entered", remarks: "" } : null;
      const difference = round2(entry.amount - sys);
      return { date, mode, system: sys, entered: round2(entry.amount), difference, status: statusOf(difference), remarks: entry.remarks || "" };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : modeRank(a.mode) - modeRank(b.mode) || a.mode.localeCompare(b.mode)));

  const perMode = new Map();
  for (const r of rows) {
    const m = perMode.get(r.mode) ?? { mode: r.mode, systemTotal: 0, enteredTotal: 0, comparedSystem: 0, notEnteredSystem: 0, daysEntered: 0, daysNotEntered: 0 };
    m.systemTotal += r.system;
    if (r.entered === null) {
      m.notEnteredSystem += r.system;
      m.daysNotEntered += 1;
    } else {
      m.enteredTotal += r.entered;
      m.comparedSystem += r.system;
      m.daysEntered += 1;
    }
    perMode.set(r.mode, m);
  }
  const byMode = [...perMode.values()]
    .map((m) => {
      const difference = round2(m.enteredTotal - m.comparedSystem);
      return {
        ...m,
        systemTotal: round2(m.systemTotal),
        enteredTotal: round2(m.enteredTotal),
        comparedSystem: round2(m.comparedSystem),
        notEnteredSystem: round2(m.notEnteredSystem),
        difference,
        status: m.daysEntered === 0 ? "not-entered" : statusOf(difference),
      };
    })
    .sort(byModeOrder);

  const totals = byMode.reduce(
    (t, m) => ({
      systemTotal: t.systemTotal + m.systemTotal,
      enteredTotal: t.enteredTotal + m.enteredTotal,
      comparedSystem: t.comparedSystem + m.comparedSystem,
      notEnteredSystem: t.notEnteredSystem + m.notEnteredSystem,
    }),
    { systemTotal: 0, enteredTotal: 0, comparedSystem: 0, notEnteredSystem: 0 }
  );
  const difference = round2(totals.enteredTotal - totals.comparedSystem);
  const anyEntered = byMode.some((m) => m.daysEntered > 0);
  return {
    rows,
    byMode,
    totals: {
      systemTotal: round2(totals.systemTotal),
      enteredTotal: round2(totals.enteredTotal),
      comparedSystem: round2(totals.comparedSystem),
      notEnteredSystem: round2(totals.notEnteredSystem),
      difference,
      status: anyEntered ? statusOf(difference) : "not-entered",
    },
  };
}

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
          day: { $dateToString: { format: "%Y-%m-%d", date: "$_paymentDate", timezone: "Asia/Singapore" } },
        },
        count: { $sum: 1 },
        total: { $sum: "$_amount" },
      },
    },
  ]).allowDiskUse(true);

  const entries = await DailyCollectionEntry.find(DailyCollectionEntry.notDeletedFilter({ date: { $gte: fromDay, $lte: toDay } })).lean();

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
    reconciliation: buildReconciliation(groups, entries),
  };
}

module.exports = { buildDailyCollection, buildReconciliation };
