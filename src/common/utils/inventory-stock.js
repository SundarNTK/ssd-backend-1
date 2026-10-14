/**
 * Atomic stock primitives shared by manual adjustments (controllers/inventory) and the booking lifecycle
 * (controllers/pos/inventory-reservation).
 *
 * The one accounting model, used everywhere:
 *
 *   physical  = currentStock                  units on the shelf - moved ONLY by adjustments and by a confirmed booking
 *   reserved  = reservedStock                 units held by pending bookings (open reservations)
 *   available = physical - reserved           what a manual stock-out may take
 *   bookable  = physical - reserved          what a new booking may reserve (same as available)
 *
 * The master's threshold is only the low-stock ALERT level (see common/utils/stock-alerts): stock stays sellable
 * right down to zero.
 *
 * Every change to those counters is ONE conditional update whose filter carries the rule it enforces (enough
 * available stock, never below zero), so two requests racing for the same stock cannot both win. Multi-step changes
 * (confirm a booking = claim the reservation + deduct stock + log the movement) run in a database transaction when
 * the server supports them (a replica set - Atlas does), and are otherwise ordered so a crash can only leave stock
 * held (safe), never stock sold twice. See runInTransaction.
 */
const mongoose = require("mongoose");
const Item = require("../../models/items");
const Service = require("../../models/services");
const GeneralItem = require("../../models/general-items");

const REF_MODELS = { Item, Service, GeneralItem };
const REF_TYPES = Object.keys(REF_MODELS);

/** The flag that switches inventory on for a master. GeneralItem mirrors Item's inventory fields. */
const inventoryFlag = (refType) => (refType === "Service" ? "isInventoryRequired" : "isInventoryApplicable");
const thresholdField = (refType) => (refType === "Service" ? "thresholdCount" : "threshold");

const toObjectId = (id) => (typeof id === "string" ? mongoose.Types.ObjectId.createFromHexString(id) : id);

// $ifNull keeps masters saved before reservedStock existed working (they have no such field yet).
const physicalExpr = { $ifNull: ["$currentStock", 0] };
const reservedExpr = { $ifNull: ["$reservedStock", 0] };

/** `physical - reserved - (buffer)` as a MongoDB expression. */
function freeExpr(refType, { withThreshold }) {
  const base = { $subtract: [physicalExpr, reservedExpr] };
  return withThreshold ? { $subtract: [base, { $ifNull: [`$${thresholdField(refType)}`, 0] }] } : base;
}

/** Filter for a master that is live and has inventory switched on. */
function trackedFilter(Model, refType, id) {
  return Model.notDeletedFilter({ _id: toObjectId(id), [inventoryFlag(refType)]: true, status: 1 });
}

/**
 * Runs fn(session) in a transaction when the database supports them, retrying transient conflicts. On a
 * standalone server (no replica set) it runs fn(null) once, un-transacted - callers order their writes so that is
 * still safe (see the file header).
 */
async function runInTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    const unsupported =
      err?.code === 20 || /Transaction numbers are only allowed|replica set member or mongos|does not support transactions/i.test(err?.message || "");
    if (unsupported) return fn(null);
    throw err;
  } finally {
    await session.endSession();
  }
}

/**
 * Atomically takes `qty` units into reservedStock if at least that many are bookable. Returns the master as it is
 * now, or null when the rule failed (not enough stock, or no longer tracked/active).
 */
function reserveStock(refType, refId, qty, { session } = {}) {
  const Model = REF_MODELS[refType];
  return Model.findOneAndUpdate(
    { ...trackedFilter(Model, refType, refId), $expr: { $gte: [freeExpr(refType, { withThreshold: false }), qty] } },
    { $inc: { reservedStock: qty } },
    { returnDocument: "after", session }
  );
}

/** Gives `qty` reserved units back. Floors at zero so a repeated call can never push the counter negative. */
function releaseReservedStock(refType, refId, qty, { session } = {}) {
  const Model = REF_MODELS[refType];
  return Model.updateOne(
    { _id: toObjectId(refId) },
    [{ $set: { reservedStock: { $max: [0, { $subtract: [reservedExpr, qty] }] } } }],
    { session, updatePipeline: true }
  );
}

/**
 * A confirmed sale: physical stock goes down by what it can (never below zero) and `releaseReserved` of the hold
 * is released in the same update. Returns { deducted, doc }. `limitToAvailable` is for a LATE confirmation (the hold
 * had already lapsed, so the units are not reserved for it): it may only take what is genuinely free, so it can
 * never oversell - the rest is reported as a shortfall by the caller.
 */
async function deductSold(refType, refId, qty, { releaseReserved = 0, limitToAvailable = false, session } = {}) {
  const Model = REF_MODELS[refType];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const before = await Model.findOne({ _id: toObjectId(refId) }).select("currentStock reservedStock").session(session || null);
    const physical = before?.currentStock ?? 0;
    const reserved = before?.reservedStock ?? 0;
    const free = Math.max(0, physical - reserved + releaseReserved);
    const deducted = Math.max(0, Math.min(qty, limitToAvailable ? free : physical));

    // The guard re-checks the stock at write time, so a concurrent change makes this update miss (and we re-read)
    // instead of going negative or taking units another booking has reserved in the meantime.
    const filter = { _id: toObjectId(refId), currentStock: { $gte: deducted } };
    if (limitToAvailable) filter.$expr = { $gte: [{ $add: [freeExpr(refType, { withThreshold: false }), releaseReserved] }, deducted] };
    const doc = await Model.findOneAndUpdate(
      filter,
      [
        {
          $set: {
            currentStock: { $subtract: [physicalExpr, deducted] },
            reservedStock: { $max: [0, { $subtract: [reservedExpr, releaseReserved] }] },
          },
        },
      ],
      { returnDocument: "after", session, updatePipeline: true }
    );
    if (doc) return { deducted, doc };
  }
  throw new Error("Stock changed while confirming the booking - retry.");
}

/**
 * Applies a manual stock-in / stock-out to ONE master, atomically. Stock-out must fit in available stock
 * (physical - reserved). Returns { doc, previous } or throws a conflict error the caller turns into a message.
 */
async function applyManualDelta(refType, refId, inventoryType, qty, { session } = {}) {
  const Model = REF_MODELS[refType];
  const out = inventoryType === "Stock Out";
  const filter = trackedFilter(Model, refType, refId);
  if (out) filter.$expr = { $gte: [freeExpr(refType, { withThreshold: false }), qty] };
  const doc = await Model.findOneAndUpdate(filter, { $inc: { currentStock: out ? -qty : qty } }, { returnDocument: "after", session });
  if (!doc) return null;
  return { doc, previous: out ? doc.currentStock + qty : doc.currentStock - qty };
}

module.exports = {
  REF_MODELS,
  REF_TYPES,
  inventoryFlag,
  thresholdField,
  toObjectId,
  trackedFilter,
  runInTransaction,
  reserveStock,
  releaseReservedStock,
  deductSold,
  applyManualDelta,
};
