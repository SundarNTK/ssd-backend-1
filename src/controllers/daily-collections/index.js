const express = require("express");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const escapeRegex = require("../../common/utils/escape-regex");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");
const { templeToday, dayBounds } = require("../../common/utils/stock-ledger");

const DailyCollectionEntry = require("../../models/daily-collection-entries");
const PaymentMode = require("../../models/payment-modes");
const { createSchema, updateSchema } = require("./request-objects");

/**
 * Daily Collection Entry - the amount the temple actually collected per payment mode at the end of a day.
 * Mounted at /masters (see routes/index.js, where authGuard/adminOnly apply to the whole group).
 *
 *   GET    /daily-collections            list (date range, payment mode)
 *   GET    /daily-collections/day?date=  every active payment mode for that day, with its entry if one exists
 *   POST   /daily-collections            enter a day's amounts (one per payment mode; each mode once per day)
 *   PUT    /daily-collections/:id        change the amount / remarks of an entry
 *   DELETE /daily-collections/:id        remove an entry (so it can be entered again)
 *
 * Rules: no future dates; one entry per day per payment mode (also a unique index); only active payment modes;
 * amount 0 - 9,999,999.99. The system's own total for the day is deliberately NOT returned here, so the figure
 * entered is the real count and not a copy of what the system says.
 */
const router = express.Router();

const MODULE = "daily-collections";
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

function assertEnterableDay(day) {
  dayBounds(day); // throws "Enter a valid date (YYYY-MM-DD)." for a malformed or impossible date
  if (day > templeToday()) throw "A collection cannot be entered for a future date.";
}

const dto = (e) => ({
  _id: e._id,
  date: e.date,
  paymentMode: e.paymentMode,
  paymentModeName: e.paymentModeName,
  amount: e.amount,
  remarks: e.remarks,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
  createdByName: e.createdByInfo?.name ?? "",
  updatedByName: e.updatedByInfo?.name ?? "",
});

async function list(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    const filter = DailyCollectionEntry.notDeletedFilter();

    const { dateFrom, dateTo, paymentMode, search } = req.query;
    if (dateFrom || dateTo) {
      filter.date = {};
      if (dateFrom) filter.date.$gte = dateFrom;
      if (dateTo || dateFrom) filter.date.$lte = dateTo || dateFrom;
    }
    if (paymentMode) filter.paymentModeName = String(paymentMode).toUpperCase();
    if (search) filter.remarks = new RegExp(escapeRegex(String(search).trim()), "i");

    const [items, total] = await Promise.all([
      DailyCollectionEntry.find(filter)
        .sort({ date: -1, paymentModeName: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      DailyCollectionEntry.countDocuments(filter),
    ]);
    return responseHandler({ res, response: { items: items.map(dto), total, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

async function dayView(req, res) {
  try {
    const date = req.query.date || templeToday();
    assertEnterableDay(date);
    const [modes, entries] = await Promise.all([
      PaymentMode.find(PaymentMode.notDeletedFilter({ status: 1 })).sort({ name: 1 }).select("name"),
      DailyCollectionEntry.find(DailyCollectionEntry.notDeletedFilter({ date })),
    ]);
    const byMode = new Map(entries.map((e) => [String(e.paymentMode), e]));
    return responseHandler({
      res,
      response: {
        date,
        modes: modes.map((m) => ({
          paymentModeId: m._id,
          name: String(m.name).toUpperCase(),
          entry: byMode.has(String(m._id)) ? dto(byMode.get(String(m._id))) : null,
        })),
      },
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 422 : undefined });
  }
}

async function create(req, res) {
  try {
    const { date, entries } = req.body;
    assertEnterableDay(date);

    const ids = entries.map((e) => e.paymentModeId);
    if (new Set(ids).size !== ids.length) throw "Each payment mode can appear only once for a day.";

    const modes = await PaymentMode.find(PaymentMode.notDeletedFilter({ _id: { $in: ids }, status: 1 })).select("name");
    const modeById = new Map(modes.map((m) => [String(m._id), m]));
    if (ids.some((id) => !modeById.has(id))) throw "One of the payment modes does not exist or is inactive.";

    const existing = await DailyCollectionEntry.find(DailyCollectionEntry.notDeletedFilter({ date, paymentMode: { $in: ids } })).select("paymentModeName");
    if (existing.length > 0) {
      throw `A collection is already entered for ${date} for: ${existing.map((e) => e.paymentModeName).join(", ")}. Edit or delete the existing entry instead.`;
    }

    const created = [];
    try {
      for (const e of entries) {
        const mode = modeById.get(e.paymentModeId);
        created.push(
          await DailyCollectionEntry.create({
            date,
            paymentMode: mode._id,
            paymentModeName: mode.name,
            amount: money(e.amount),
            remarks: e.remarks || "",
            createdBy: req.auth?.userId || null,
          })
        );
      }
    } catch (error) {
      // Nothing is left half entered: remove what this request already wrote, then report the problem.
      await Promise.all(created.map((c) => DailyCollectionEntry.deleteOne({ _id: c._id })));
      if (error?.code === 11000) throw "A collection was entered for one of these payment modes a moment ago. Refresh and check the day again.";
      throw error;
    }
    return responseHandler({ res, response: { items: created.map(dto) }, successMessage: "Collection entered successfully.", statusCode: 201 });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 422 : undefined });
  }
}

async function update(req, res) {
  try {
    const entry = await DailyCollectionEntry.findOne(DailyCollectionEntry.notDeletedFilter({ _id: req.params.id }));
    if (!entry) throw "Record not found.";
    if (req.body.amount !== undefined) entry.amount = money(req.body.amount);
    if (req.body.remarks !== undefined) entry.remarks = req.body.remarks;
    entry.updatedBy = req.auth?.userId || null;
    await entry.save();
    return responseHandler({ res, response: dto(entry), successMessage: "Collection updated successfully." });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 404 : undefined });
  }
}

async function remove(req, res) {
  try {
    const entry = await DailyCollectionEntry.findOne(DailyCollectionEntry.notDeletedFilter({ _id: req.params.id }));
    if (!entry) throw "Record not found.";
    await entry.softDelete(req.auth?.userId);
    return responseHandler({ res, successMessage: "Collection deleted successfully." });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 404 : undefined });
  }
}

router.get("/daily-collections", requirePermission(MODULE, "view"), list);
router.get("/daily-collections/day", requirePermission(MODULE, "view"), dayView);
router.post("/daily-collections", requirePermission(MODULE, "edit"), validateBody(createSchema), create);
router.put("/daily-collections/:id", requirePermission(MODULE, "edit"), validateBody(updateSchema), update);
router.delete("/daily-collections/:id", requirePermission(MODULE, "fullAccess"), remove);

module.exports = router;
