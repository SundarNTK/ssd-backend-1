/**
 * The Available Stock "entered count": quantities queued per item (kept in the database, net of ins and outs) and
 * the "Add to Adjust" that applies the queue to real stock.
 *
 *   queuePending   +10 then -2 leaves a queued +8. Nothing touches physical stock. Each press is one history row.
 *   applyPending   claims the queued net (conditional on it being unchanged), applies it as ONE Stock In / Stock Out
 *                  with the same atomic stock rules as every adjustment, writes the Inventory Adjustment movement
 *                  and the history row - all in one transaction. The request carries a unique id, so a double click
 *                  or retry applies it once.
 *   clearPending   drops the queue (history row), stock untouched.
 *
 * Every write is one conditional update, so two people queueing or applying for the same item cannot corrupt the
 * count, and a stock-out can never be queued/applied beyond what is available.
 */
const mongoose = require("mongoose");
const InventoryAdjustment = require("../../models/inventory-adjustments");
const InventoryPending = require("../../models/inventory-pending");
const AvailableStockHistory = require("../../models/available-stock-history");
const { REF_MODELS, trackedFilter, runInTransaction, applyManualDelta } = require("../../common/utils/inventory-stock");
const { InventoryConflict } = require("./adjust");

const MAX_QUEUED = 1000000;

async function loadMaster(refType, refId) {
  const Model = REF_MODELS[refType];
  const doc = await Model.findOne(trackedFilter(Model, refType, refId)).select("name code currentStock reservedStock");
  if (!doc) {
    throw `The selected ${refType === "GeneralItem" ? "general item" : refType.toLowerCase()} doesn't exist, is inactive, or doesn't have inventory switched on.`;
  }
  return doc;
}

const availableOf = (m) => (m.currentStock ?? 0) - (m.reservedStock ?? 0);

/** Makes sure the item's queue row exists (idempotent; a concurrent creator is fine). */
async function ensureQueueRow(refType, refId) {
  try {
    await InventoryPending.updateOne({ refType, refId }, { $setOnInsert: { pendingQuantity: 0 } }, { upsert: true });
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
}

const queueFilter = (refType, refId) => ({ refType, refId: new mongoose.Types.ObjectId(String(refId)) });

/** The history of a retried request, if it already went through. */
const findByRequestId = (requestId) => (requestId ? AvailableStockHistory.findOne({ requestId }) : null);

/**
 * Adds a stock in / stock out to the item's queue.
 * @returns {Promise<{ duplicate: boolean, pendingQuantity: number }>}
 */
async function queuePending({ refType, refId, mode, quantity, requestId, userId = null }) {
  const earlier = await findByRequestId(requestId);
  if (earlier) return { duplicate: true, pendingQuantity: earlier.pendingAfter };

  const master = await loadMaster(refType, refId);
  const available = availableOf(master);
  const out = mode === "out";
  const delta = out ? -quantity : quantity;
  await ensureQueueRow(refType, refId);

  try {
    return await runInTransaction(async (session) => {
      // The rule is in the filter: a stock-out may only take the queue down to -(available stock); the queue is
      // also capped so it can never grow without bound.
      const guard = out ? { $gte: quantity - available } : { $lte: MAX_QUEUED - quantity };
      const updated = await InventoryPending.findOneAndUpdate(
        { ...queueFilter(refType, refId), pendingQuantity: guard },
        { $inc: { pendingQuantity: delta }, $set: { updatedBy: userId, lastActivityAt: new Date() } },
        { returnDocument: "after", session }
      );
      if (!updated) {
        const row = await InventoryPending.findOne(queueFilter(refType, refId)).session(session || null);
        const queued = row?.pendingQuantity ?? 0;
        if (!out) throw `The queued count for "${master.name}" is too large.`;
        throw available <= 0 && queued <= 0 && (master.currentStock ?? 0) <= 0 && (master.reservedStock ?? 0) <= 0
          ? `Inventory has not been initialized for "${master.name}": no stock has been added yet. Queue a Stock In first.`
          : `Cannot queue a stock out of ${quantity} for "${master.name}": ${Math.max(0, available)} available and ${queued >= 0 ? "+" : ""}${queued} already queued.`;
      }
      await AvailableStockHistory.create(
        [
          {
            refType,
            refId,
            name: master.name,
            code: master.code,
            action: out ? "Queued Stock Out" : "Queued Stock In",
            quantity,
            inventoryType: out ? "Stock Out" : "Stock In",
            pendingBefore: updated.pendingQuantity - delta,
            pendingAfter: updated.pendingQuantity,
            stockBefore: master.currentStock ?? 0,
            stockAfter: master.currentStock ?? 0,
            requestId,
            createdBy: userId,
          },
        ],
        { session }
      );
      return { duplicate: false, pendingQuantity: updated.pendingQuantity };
    });
  } catch (err) {
    if (err?.code === 11000 && requestId) return { duplicate: true, pendingQuantity: (await findByRequestId(requestId))?.pendingAfter ?? 0 };
    throw err;
  }
}

/**
 * "Add to Adjust": applies the item's queued net to real stock.
 * @returns {Promise<{ duplicate: boolean, adjustment: any, pendingQuantity: number }>}
 */
async function applyPending({ refType, refId, requestId, userId = null }) {
  const adjustmentKey = `apply:${requestId}`;
  const earlier = await InventoryAdjustment.findOne({ requestId: adjustmentKey });
  if (earlier) return { duplicate: true, adjustment: earlier, pendingQuantity: 0 };

  const master = await loadMaster(refType, refId);

  try {
    return await runInTransaction(async (session) => {
      const row = await InventoryPending.findOne(queueFilter(refType, refId)).session(session || null);
      const net = row?.pendingQuantity ?? 0;
      if (!net) throw `Nothing is queued for "${master.name}". Add a stock in or stock out first.`;

      // Claim the queue exactly as it was read: if somebody changed it in between, this misses and we stop.
      const claimed = await InventoryPending.findOneAndUpdate(
        { ...queueFilter(refType, refId), pendingQuantity: net },
        { $set: { pendingQuantity: 0, updatedBy: userId, lastActivityAt: new Date() } },
        { returnDocument: "after", session }
      );
      if (!claimed) throw new InventoryConflict(`The queued count for "${master.name}" was changed by someone else. Refresh and try again.`);

      const inventoryType = net > 0 ? "Stock In" : "Stock Out";
      const quantity = Math.abs(net);
      let result;
      try {
        result = await applyManualDelta(refType, refId, inventoryType, quantity, { session });
      } catch (err) {
        if (!session) await InventoryPending.updateOne({ _id: claimed._id }, { $inc: { pendingQuantity: net } }).catch(() => {});
        throw err;
      }
      if (!result) {
        if (!session) await InventoryPending.updateOne({ _id: claimed._id }, { $inc: { pendingQuantity: net } }).catch(() => {});
        const fresh = await loadMaster(refType, refId).catch(() => master);
        throw new InventoryConflict(
          inventoryType === "Stock Out"
            ? `Cannot apply the queued stock out of ${quantity} for "${master.name}": only ${Math.max(0, availableOf(fresh))} available now (stock changed or was reserved by bookings). The queue is unchanged - reduce it and try again.`
            : `Stock for "${master.name}" could not be updated. Try again.`
        );
      }

      const [adjustment] = await InventoryAdjustment.create(
        [
          {
            refType,
            refId,
            inventoryType,
            quantity,
            previousStock: result.previous,
            balance: result.doc.currentStock,
            remarks: "Applied from Available Stock (Add to Adjust)",
            source: "Available Stock",
            requestId: adjustmentKey,
            createdBy: userId,
          },
        ],
        { session }
      );
      await AvailableStockHistory.create(
        [
          {
            refType,
            refId,
            name: master.name,
            code: master.code,
            action: "Added to Adjust",
            quantity,
            inventoryType,
            pendingBefore: net,
            pendingAfter: 0,
            stockBefore: result.previous,
            stockAfter: result.doc.currentStock,
            adjustmentId: adjustment._id,
            remarks: `Applied ${net > 0 ? "+" : "−"}${quantity} as ${inventoryType}`,
            requestId: `history:${adjustmentKey}`,
            createdBy: userId,
          },
        ],
        { session }
      );
      return { duplicate: false, adjustment, pendingQuantity: 0 };
    });
  } catch (err) {
    if (err?.code === 11000) {
      const again = await InventoryAdjustment.findOne({ requestId: adjustmentKey });
      if (again) return { duplicate: true, adjustment: again, pendingQuantity: 0 };
    }
    throw err;
  }
}

/** Drops the item's queue (no stock change). */
async function clearPending({ refType, refId, userId = null }) {
  const master = await loadMaster(refType, refId);
  return runInTransaction(async (session) => {
    const row = await InventoryPending.findOne(queueFilter(refType, refId)).session(session || null);
    const net = row?.pendingQuantity ?? 0;
    if (!net) return { pendingQuantity: 0 };
    const claimed = await InventoryPending.findOneAndUpdate(
      { ...queueFilter(refType, refId), pendingQuantity: net },
      { $set: { pendingQuantity: 0, updatedBy: userId, lastActivityAt: new Date() } },
      { returnDocument: "after", session }
    );
    if (!claimed) throw new InventoryConflict(`The queued count for "${master.name}" was changed by someone else. Refresh and try again.`);
    await AvailableStockHistory.create(
      [
        {
          refType,
          refId,
          name: master.name,
          code: master.code,
          action: "Cleared Queue",
          quantity: Math.abs(net),
          inventoryType: net > 0 ? "Stock In" : "Stock Out",
          pendingBefore: net,
          pendingAfter: 0,
          stockBefore: master.currentStock ?? 0,
          stockAfter: master.currentStock ?? 0,
          createdBy: userId,
        },
      ],
      { session }
    );
    return { pendingQuantity: 0 };
  });
}

module.exports = { queuePending, applyPending, clearPending };
