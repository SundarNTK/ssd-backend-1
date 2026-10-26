const express = require("express");
const authGuard = require("../../common/middleware/auth-guard");
const adminOnly = require("../../common/middleware/admin-only");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");
const escapeRegex = require("../../common/utils/escape-regex");
const { loadAlertRows } = require("../../common/utils/stock-alerts");

const Item = require("../../models/items");
const Service = require("../../models/services");
const GeneralItem = require("../../models/general-items");
const InventoryAdjustment = require("../../models/inventory-adjustments");
const { physicalCountSchema, createAdjustmentSchema, batchAdjustmentSchema, queuePendingSchema, applyPendingSchema, clearPendingSchema } = require("./request-objects");
const { queuePending, applyPending, clearPending } = require("./pending");
const InventoryPending = require("../../models/inventory-pending");
const AvailableStockHistory = require("../../models/available-stock-history");
const { applyAdjustmentBatch, InventoryConflict } = require("./adjust");
const mongoose = require("mongoose");
const stockReserveApi = require("./stock-reserve-api");
const StockReserve = require("../../models/stock-reserves");
const PhysicalStockCount = require("../../models/physical-stock-counts");
const { applyPhysicalCount } = require("./physical-count");
const { buildLedger, dayBounds, templeToday, DAY } = require("../../common/utils/stock-ledger");

// Not nested under the /masters group router (see routes/index.js), so
// authGuard/adminOnly are applied here directly — same as roles/users.
const REF_MODELS = { Item, Service, GeneralItem };
// GeneralItem mirrors Item's inventory field names (isInventoryApplicable/
// threshold), so it reuses Item's branch wherever this ternary is used.
function applicableFieldFor(refType) {
  return refType === "Service" ? "isInventoryRequired" : "isInventoryApplicable";
}

function searchRegex(term) {
  return new RegExp(escapeRegex(term.trim()), "i");
}

/**
 * GET /inventory/options?refType=Item|Service
 * Feeds the "Select Item"/"Select Service" dropdown in the Add Inventory
 * Adjustment modal — only inventory-applicable, active records, gated on
 * the `inventory` module alone rather than also requiring items/services
 * view access.
 */
async function options(req, res) {
  try {
    const refType = req.query.refType;
    if (!["Item", "Service", "GeneralItem"].includes(refType)) throw "A valid refType (Item, Service or GeneralItem) is required.";

    const Model = REF_MODELS[refType];
    const applicableField = applicableFieldFor(refType);
    const rows = await Model.find(Model.notDeletedFilter({ [applicableField]: true, status: 1 }))
      .select("name code currentStock")
      .sort({ name: 1 })
      .limit(200);

    return responseHandler({ res, response: { items: rows } });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * One row of the Available Stock list. physical = what is on the shelf, reserved = held by pending bookings,
 * available = physical - reserved (what a stock-out may take). `availableQuantity` is the available figure.
 */
function stockRow(r, refType, threshold, unit, pendingByKey = new Map(), usedByKey = new Map(), futureByKey = new Map(), deficitByKey = new Map()) {
  // Stock units one booked unit uses (Quantity Reduction); Services have no such field and always use 1.
  const reduction = refType === "Service" ? 1 : Math.max(1, Math.floor(Number(r.quantityReduction) || 1));
  const physical = r.currentStock ?? 0;
  const reserved = r.reservedStock ?? 0;
  return {
    _id: r._id,
    refType,
    name: r.name,
    code: r.code,
    unit: unit ?? null,
    threshold: threshold ?? 0,
    physicalQuantity: physical,
    reservedQuantity: reserved,
    availableQuantity: Math.max(0, physical - reserved),
    quantityReduction: reduction,
    // Set aside for future session dates (not yet taken out of stock), and shortages still owed from past ones.
    futureReservedQuantity: futureByKey.get(`${refType}:${r._id}`) ?? 0,
    deficitQuantity: deficitByKey.get(`${refType}:${r._id}`) ?? 0,
    // Everything ever taken out (manual stock-outs and bookings), and so everything ever added: on hand + taken out.
    usedQuantity: usedByKey.get(`${refType}:${r._id}`) ?? 0,
    totalStockQuantity: physical + (usedByKey.get(`${refType}:${r._id}`) ?? 0),
    // How many booked units the available stock covers (available / reduction, rounded down).
    bookableQuantity: Math.floor(Math.max(0, physical - reserved) / reduction),
    // The queued ("entered") count not applied yet: +10 then -2 reads +8. Kept in the database.
    pendingQuantity: pendingByKey.get(`${refType}:${r._id}`) ?? 0,
  };
}

/**
 * GET /inventory/available-stock
 * Items and Services live in different collections, so this merges both
 * into one list in application code instead of trying to paginate across
 * two collections in the database — realistic for a temple's item/service
 * catalogue (tens to low hundreds of rows), not a warehouse-scale count.
 */
async function availableStock(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    const search = req.query.search ? searchRegex(req.query.search) : null;
    const type = req.query.type; // "Item" | "Service" | undefined
    // The days shown, "YYYY-MM-DD" (Singapore, inclusive); today when not given. Past days are rebuilt from the movement log.
    const today = templeToday();
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : today;
    const dateTo = req.query.dateTo ? String(req.query.dateTo) : dateFrom;
    dayBounds(dateFrom);
    dayBounds(dateTo);

    // Every queued count in one read, keyed "Type:id" (the rows on a page are looked up against it).
    const pendingByKey = new Map((await InventoryPending.find({ pendingQuantity: { $ne: 0 } }).select("refType refId pendingQuantity")).map((p) => [`${p.refType}:${p.refId}`, p.pendingQuantity]));

    // Total ever taken out per item, from the movement log - on hand + this is the overall total ever added.
    const usedByKey = new Map(
      (await InventoryAdjustment.aggregate([{ $match: { inventoryType: "Stock Out" } }, { $group: { _id: { t: "$refType", i: "$refId" }, qty: { $sum: "$quantity" } } }])).map(
        (g) => [`${g._id.t}:${g._id.i}`, g.qty]
      )
    );

    // Stock set aside for future session dates, and shortages still owed (see models/stock-reserves).
    const futureByKey = new Map();
    const deficitByKey = new Map();
    for (const g of await StockReserve.aggregate([
      { $match: { status: { $in: ["upcoming", "processing", "failed", "partial", "shortage"] } } },
      { $group: { _id: { t: "$refType", i: "$refId", s: "$status" }, units: { $sum: "$stockQuantity" }, short: { $sum: "$shortageQuantity" } } },
    ])) {
      const key = `${g._id.t}:${g._id.i}`;
      if (["upcoming", "processing", "failed"].includes(g._id.s)) futureByKey.set(key, (futureByKey.get(key) ?? 0) + g.units);
      else deficitByKey.set(key, (deficitByKey.get(key) ?? 0) + g.short);
    }

    async function loadItems() {
      if (type && type !== "Item") return [];
      const filter = Item.notDeletedFilter({ isInventoryApplicable: true, status: 1 });
      if (search) filter.$or = [{ name: search }, { code: search }];
      const rows = await Item.find(filter).select("name code currentStock reservedStock threshold unitOfMeasure quantityReduction").sort({ name: 1 });
      return rows.map((r) => stockRow(r, "Item", r.threshold, r.unitOfMeasure, pendingByKey, usedByKey, futureByKey, deficitByKey));
    }

    async function loadServices() {
      if (type && type !== "Service") return [];
      const filter = Service.notDeletedFilter({ isInventoryRequired: true, status: 1 });
      if (search) filter.$or = [{ name: search }, { code: search }];
      const rows = await Service.find(filter).select("name code currentStock reservedStock thresholdCount").sort({ name: 1 });
      return rows.map((r) => stockRow(r, "Service", r.thresholdCount, null, pendingByKey, usedByKey, futureByKey, deficitByKey));
    }

    async function loadGeneralItems() {
      if (type && type !== "GeneralItem") return [];
      const filter = GeneralItem.notDeletedFilter({ isInventoryApplicable: true, status: 1 });
      if (search) filter.$or = [{ name: search }, { code: search }];
      const rows = await GeneralItem.find(filter).select("name code currentStock reservedStock threshold quantityReduction").sort({ name: 1 });
      return rows.map((r) => stockRow(r, "GeneralItem", r.threshold, null, pendingByKey, usedByKey, futureByKey, deficitByKey));
    }

    const [items, services, generalItems] = await Promise.all([loadItems(), loadServices(), loadGeneralItems()]);
    const merged = [...items, ...services, ...generalItems].sort((a, b) => a.name.localeCompare(b.name));

    const total = merged.length;
    const start = (page - 1) * pageSize;
    const pageRows = merged.slice(start, start + pageSize);

    // The day-by-day figures (opening, in, out, sales, excess/short, in hand, reserved, available) for this page only.
    const ledger = await buildLedger(pageRows.map((r) => ({ refType: r.refType, _id: r._id, currentStock: r.physicalQuantity })), dateFrom, dateTo);
    const pageItems = pageRows.map((r) => ({ ...r, ...ledger.get(`${r.refType}:${r._id}`) }));

    return responseHandler({ res, response: { items: pageItems, total, page, pageSize, dateFrom, dateTo, today } });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * GET /inventory/low-stock
 * Items, Services and General Items that have a threshold and whose AVAILABLE stock (in stock minus reserved) has
 * reached it or dropped below it, but is not yet zero (zero belongs on /inventory/out-of-stock, so the two lists
 * never overlap). See common/utils/stock-alerts.
 */
async function lowStock(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    const search = req.query.search ? searchRegex(req.query.search) : null;
    const type = ["Item", "Service", "GeneralItem"].includes(req.query.type) ? req.query.type : null;

    // Closest to empty first, so the most urgent rows lead.
    const merged = (await loadAlertRows("low", { search, type })).sort((a, b) => a.availableStock - b.availableStock || a.name.localeCompare(b.name));
    const start = (page - 1) * pageSize;
    return responseHandler({ res, response: { items: merged.slice(start, start + pageSize), total: merged.length, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * GET /inventory/out-of-stock
 * Every inventory-tracked Item, Service and General Item whose available stock is 0 (sold out - or all of it held
 * by pending bookings, or never stocked). Merged in application code for the same reason as availableStock above.
 */
async function outOfStock(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    const search = req.query.search ? searchRegex(req.query.search) : null;
    const type = ["Item", "Service", "GeneralItem"].includes(req.query.type) ? req.query.type : null;

    const merged = (await loadAlertRows("out", { search, type })).sort((a, b) => a.name.localeCompare(b.name));
    const start = (page - 1) * pageSize;
    return responseHandler({ res, response: { items: merged.slice(start, start + pageSize), total: merged.length, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * GET /inventory/history
 * When a search term is given, resolve it against Item/Service name/code
 * first (across both collections), then filter movements by those ids —
 * correct and index-backed, versus filtering the populated result set in
 * memory.
 */
async function history(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    const filter = {};

    const refType = req.query.refType; // "Item" | "Service" | "GeneralItem" | undefined
    if (["Item", "Service", "GeneralItem"].includes(refType)) filter.refType = refType;
    if (["Inventory Adjustment", "Available Stock", "Booking", "Stock Reserve", "Physical Count"].includes(req.query.source)) filter.source = req.query.source;
    // Day filter (Singapore days, inclusive): one day, or from - to. Defaults are decided by the screen, not here.
    const dateRange = createdAtRange(req.query.dateFrom, req.query.dateTo);
    if (dateRange) filter.createdAt = dateRange;

    if (req.query.search) {
      const regex = searchRegex(req.query.search);
      const [matchingItems, matchingServices, matchingGeneralItems] = await Promise.all([
        refType && refType !== "Item" ? [] : Item.find({ isDeleted: false, $or: [{ name: regex }, { code: regex }] }).select("_id"),
        refType && refType !== "Service" ? [] : Service.find({ isDeleted: false, $or: [{ name: regex }, { code: regex }] }).select("_id"),
        refType && refType !== "GeneralItem" ? [] : GeneralItem.find({ isDeleted: false, $or: [{ name: regex }, { code: regex }] }).select("_id"),
      ]);
      filter.refId = { $in: [...matchingItems, ...matchingServices, ...matchingGeneralItems].map((r) => r._id) };
    }

    const [rows, total] = await Promise.all([
      InventoryAdjustment.find(filter)
        .populate("refId", "name code")
        .populate("createdBy", "name")
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      InventoryAdjustment.countDocuments(filter),
    ]);

    const items = rows.map((r) => ({
      _id: r._id,
      createdAt: r.createdAt,
      refType: r.refType,
      name: r.refId?.name ?? "—",
      code: r.refId?.code ?? "—",
      inventoryType: r.inventoryType,
      quantity: r.quantity,
      bookedQuantity: r.bookedQuantity ?? null,
      reductionFactor: r.reductionFactor ?? null,
      source: r.source ?? "Inventory Adjustment",
      previousStock: r.previousStock ?? null,
      balance: r.balance,
      remarks: r.remarks,
      user: r.createdBy?.name ?? "—",
    }));

    return responseHandler({ res, response: { items, total, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/** createdAt range for dateFrom / dateTo ("YYYY-MM-DD", Singapore days, inclusive); null when neither is given. */
function createdAtRange(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return null;
  const range = {};
  if (dateFrom) range.$gte = dayBounds(String(dateFrom)).start;
  if (dateTo) range.$lt = dayBounds(String(dateTo)).end;
  return range;
}

/** Maps a failed adjustment to a status: business rule -> 400, "changed by another user" -> 409, anything else -> 500. */
function adjustmentFailure(res, error) {
  if (error instanceof InventoryConflict) return exceptionHandler({ res, error: error.message, statusCode: 409 });
  return exceptionHandler({
    res,
    error: typeof error === "string" ? error : "The inventory adjustment could not be completed. Nothing was changed - please try again.",
    statusCode: typeof error === "string" ? 400 : 500,
  });
}

/**
 * POST /inventory/adjustments/batch  { batchId, adjustments: [{ refType, refId, inventoryType, quantity, remarks }] }
 * "Add to Adjust": validates every queued row against the latest stock and applies them all in one transaction. A
 * repeat of the same batchId (double click, retry) changes nothing and returns the original result.
 */
async function createAdjustmentBatch(req, res) {
  try {
    const { batchId, adjustments } = req.body;
    const { duplicate, rows } = await applyAdjustmentBatch({ batchId, entries: adjustments, userId: req.auth?.userId || null, source: "Available Stock" });
    return responseHandler({
      res,
      response: { duplicate, adjustments: rows },
      successMessage: duplicate ? "These adjustments were already applied." : `${rows.length} stock adjustment${rows.length === 1 ? "" : "s"} applied.`,
      statusCode: duplicate ? 200 : 201,
    });
  } catch (error) {
    return adjustmentFailure(res, error);
  }
}

/** POST /inventory/adjustments - a single row; same rules and same atomic path as the batch. */
async function createAdjustment(req, res) {
  try {
    const { requestId, ...entry } = req.body;
    const batchId = requestId || `single-${new mongoose.Types.ObjectId().toHexString()}`;
    const { duplicate, rows } = await applyAdjustmentBatch({ batchId, entries: [entry], userId: req.auth?.userId || null, source: "Inventory Adjustment" });
    return responseHandler({
      res,
      response: rows[0],
      successMessage: duplicate ? "This adjustment was already applied." : "Inventory adjusted successfully.",
      statusCode: duplicate ? 200 : 201,
    });
  } catch (error) {
    return adjustmentFailure(res, error);
  }
}

/** Same mapping as adjustmentFailure, for the queue endpoints. */
const queueFailure = adjustmentFailure;

/** POST /inventory/pending { refType, refId, mode: "in"|"out", quantity, requestId } - queue a stock in / stock out. */
async function queueEntry(req, res) {
  try {
    const result = await queuePending({ ...req.body, userId: req.auth?.userId || null });
    return responseHandler({
      res,
      response: result,
      successMessage: result.duplicate ? "This entry was already added." : "Added to the entered count.",
      statusCode: result.duplicate ? 200 : 201,
    });
  } catch (error) {
    return queueFailure(res, error);
  }
}

/** POST /inventory/pending/apply { refType, refId, requestId } - "Add to Adjust". */
async function applyQueue(req, res) {
  try {
    const result = await applyPending({ ...req.body, userId: req.auth?.userId || null });
    return responseHandler({
      res,
      response: result,
      successMessage: result.duplicate ? "This adjustment was already applied." : "Stock adjusted successfully.",
      statusCode: result.duplicate ? 200 : 201,
    });
  } catch (error) {
    return queueFailure(res, error);
  }
}

/** POST /inventory/pending/clear { refType, refId } */
async function clearQueue(req, res) {
  try {
    const result = await clearPending({ ...req.body, userId: req.auth?.userId || null });
    return responseHandler({ res, response: result, successMessage: "Entered count cleared." });
  } catch (error) {
    return queueFailure(res, error);
  }
}

/**
 * GET /inventory/stock-summary?refType=&refId=
 * One item's totals for the Add Inventory Adjustment form: everything ever stocked in, everything taken out
 * (manual stock-outs and booking deductions), what is on the shelf, what bookings hold, and what is available.
 */
async function stockSummary(req, res) {
  try {
    const { refType, refId } = req.query;
    if (!["Item", "Service", "GeneralItem"].includes(refType) || !mongoose.isValidObjectId(refId)) throw "A valid refType and refId are required.";
    const Model = REF_MODELS[refType];
    const ref = await Model.findOne(Model.notDeletedFilter({ _id: refId })).select(`name code currentStock reservedStock ${applicableFieldFor(refType)}`);
    if (!ref) throw "Item or service not found.";

    const totals = await InventoryAdjustment.aggregate([
      { $match: { refType, refId: new mongoose.Types.ObjectId(refId) } },
      { $group: { _id: "$inventoryType", quantity: { $sum: "$quantity" } } },
    ]);
    const sum = (type) => totals.find((t) => t._id === type)?.quantity ?? 0;
    const physical = ref.currentStock ?? 0;
    const reserved = ref.reservedStock ?? 0;

    return responseHandler({
      res,
      response: {
        inventoryEnabled: Boolean(ref[applicableFieldFor(refType)]),
        totalStockIn: sum("Stock In"),
        totalStockOut: sum("Stock Out"),
        currentStock: physical,
        reservedStock: reserved,
        availableStock: Math.max(0, physical - reserved),
      },
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * GET /inventory/available-stock-history?search=&refType=&action=&page=&pageSize=
 * Everything done on the Available Stock screen: each queued stock in / stock out, each "Add to Adjust", each clear -
 * who, when, and the entered count / stock before and after.
 */
async function availableStockHistory(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    const filter = {};
    if (["Item", "Service", "GeneralItem"].includes(req.query.refType)) filter.refType = req.query.refType;
    if (["Queued Stock In", "Queued Stock Out", "Added to Adjust", "Cleared Queue"].includes(req.query.action)) filter.action = req.query.action;
    const dateRange = createdAtRange(req.query.dateFrom, req.query.dateTo);
    if (dateRange) filter.createdAt = dateRange;
    if (req.query.search) {
      const regex = searchRegex(req.query.search);
      filter.$or = [{ name: regex }, { code: regex }];
    }

    const [rows, total] = await Promise.all([
      AvailableStockHistory.find(filter)
        .populate("createdBy", "name email")
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      AvailableStockHistory.countDocuments(filter),
    ]);

    const items = rows.map((r) => ({
      _id: r._id,
      createdAt: r.createdAt,
      refType: r.refType,
      name: r.name,
      code: r.code,
      action: r.action,
      inventoryType: r.inventoryType,
      quantity: r.quantity,
      pendingBefore: r.pendingBefore,
      pendingAfter: r.pendingAfter,
      stockBefore: r.stockBefore,
      stockAfter: r.stockAfter,
      adjustmentId: r.adjustmentId,
      remarks: r.remarks,
      user: r.createdBy?.name ?? "—",
      userEmail: r.createdBy?.email ?? "",
    }));
    return responseHandler({ res, response: { items, total, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * POST /inventory/physical-count { refType, refId, physicalQuantity, remarks?, requestId }
 * Records the counted quantity against the system's Stock in Hand; a difference becomes an excess / short movement.
 */
async function createPhysicalCount(req, res) {
  try {
    const { duplicate, count } = await applyPhysicalCount({ ...req.body, userId: req.auth?.userId || null });
    const message = duplicate
      ? "This physical count was already recorded."
      : count.difference === 0
        ? "Physical stock matches - no adjustment needed."
        : `Physical stock recorded: ${count.difference > 0 ? "excess" : "short"} of ${Math.abs(count.difference)} adjusted.`;
    return responseHandler({ res, response: count, successMessage: message, statusCode: duplicate ? 200 : 201 });
  } catch (error) {
    return adjustmentFailure(res, error);
  }
}

/**
 * GET /inventory/physical-counts?search=&refType=&dateFrom=&dateTo=&page=&pageSize=
 * The Physical Stock History: every count taken, newest first.
 */
async function physicalCountHistory(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    const filter = {};
    if (["Item", "Service", "GeneralItem"].includes(req.query.refType)) filter.refType = req.query.refType;
    const from = req.query.dateFrom ? String(req.query.dateFrom) : "";
    const to = req.query.dateTo ? String(req.query.dateTo) : "";
    if ((from && !DAY.test(from)) || (to && !DAY.test(to))) throw "Enter a valid date (YYYY-MM-DD).";
    if (from || to) filter.countDate = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    if (req.query.search) {
      const regex = searchRegex(req.query.search);
      filter.$or = [{ name: regex }, { code: regex }];
    }

    const [rows, total] = await Promise.all([
      PhysicalStockCount.find(filter)
        .populate("createdBy", "name email")
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      PhysicalStockCount.countDocuments(filter),
    ]);

    const items = rows.map((r) => ({
      _id: r._id,
      createdAt: r.createdAt,
      countDate: r.countDate,
      refType: r.refType,
      name: r.name,
      code: r.code,
      systemQuantity: r.systemQuantity,
      physicalQuantity: r.physicalQuantity,
      difference: r.difference,
      adjustmentId: r.adjustmentId,
      remarks: r.remarks,
      user: r.createdBy?.name ?? "—",
      userEmail: r.createdBy?.email ?? "",
    }));
    return responseHandler({ res, response: { items, total, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

const router = express.Router();
router.use(authGuard, adminOnly);

router.get("/options", requirePermission("inventory", "view"), options);
router.get("/available-stock", requirePermission("inventory", "view"), availableStock);
router.get("/low-stock", requirePermission("inventory", "view"), lowStock);
router.get("/out-of-stock", requirePermission("inventory", "view"), outOfStock);
router.get("/history", requirePermission("inventory", "view"), history);
router.post("/adjustments", requirePermission("inventory", "fullAccess"), validateBody(createAdjustmentSchema), createAdjustment);
router.get("/stock-summary", requirePermission("inventory", "view"), stockSummary);
// Stock Reserve (date-wise reservations for future sessions) and the Stock Hold list - see ./stock-reserve-api.
router.get("/stock-reserves/summary", requirePermission("inventory", "view"), stockReserveApi.summary);
router.post("/stock-reserves/process-due", requirePermission("inventory", "fullAccess"), stockReserveApi.processDue);
router.get("/stock-reserves", requirePermission("inventory", "view"), stockReserveApi.list);
router.get("/stock-reserves/:id", requirePermission("inventory", "view"), stockReserveApi.detail);
router.post("/stock-reserves/:id/retry", requirePermission("inventory", "fullAccess"), stockReserveApi.retry);
router.get("/stock-holds", requirePermission("inventory", "view"), stockReserveApi.holds);
router.get("/available-stock-history", requirePermission("inventory", "view"), availableStockHistory);
router.post("/physical-count", requirePermission("inventory", "fullAccess"), validateBody(physicalCountSchema), createPhysicalCount);
router.get("/physical-counts", requirePermission("inventory", "view"), physicalCountHistory);
router.post("/pending", requirePermission("inventory", "fullAccess"), validateBody(queuePendingSchema), queueEntry);
router.post("/pending/apply", requirePermission("inventory", "fullAccess"), validateBody(applyPendingSchema), applyQueue);
router.post("/pending/clear", requirePermission("inventory", "fullAccess"), validateBody(clearPendingSchema), clearQueue);
router.post("/adjustments/batch", requirePermission("inventory", "fullAccess"), validateBody(batchAdjustmentSchema), createAdjustmentBatch);

module.exports = router;
