/**
 * Manual stock adjustments - the "Add to Adjust" submission of the Available Stock screen (and the single-row
 * Inventory Adjustment form). Kept apart from the router so the rules can be exercised directly.
 *
 * One submission is one BATCH: every row is checked against the stock as it is NOW (rows cumulatively, so
 * "+10 then -12" is judged in order), then applied in a single transaction - all rows or none. Each row is one
 * conditional update that re-checks the rule at write time, so a concurrent adjustment or booking cannot push stock
 * below what is reserved. The submission carries a client-generated `batchId`; the movement rows carry a unique
 * `<batchId>:<n>` key, so a double click, a retried request or a replayed response applies it exactly once.
 */
const InventoryAdjustment = require("../../models/inventory-adjustments");
const { fulfilDeficits } = require("../../common/utils/stock-reserve");
const {
  REF_MODELS,
  trackedFilter,
  runInTransaction,
  applyManualDelta,
} = require("../../common/utils/inventory-stock");

/** Thrown for "someone else changed this stock" so the controller can answer 409 instead of 400. */
class InventoryConflict extends Error {}

const describe = (ref) => `"${ref.name}"`;

/** Loads each distinct master once and checks it can take stock movements at all. */
async function loadMasters(entries) {
  const masters = new Map();
  for (const e of entries) {
    const key = `${e.refType}:${e.refId}`;
    if (masters.has(key)) continue;
    const Model = REF_MODELS[e.refType];
    const doc = await Model.findOne(trackedFilter(Model, e.refType, e.refId)).select("name code currentStock reservedStock");
    if (!doc) {
      throw `The selected ${e.refType === "GeneralItem" ? "general item" : e.refType.toLowerCase()} doesn't exist, is inactive, or doesn't have inventory switched on.`;
    }
    masters.set(key, { name: doc.name, current: doc.currentStock ?? 0, reserved: doc.reservedStock ?? 0 });
  }
  return masters;
}

/** Judges every row, in order, against the latest balances. Throws a plain message for the first one that cannot apply. */
function validateEntries(entries, masters) {
  const running = new Map([...masters].map(([k, m]) => [k, { ...m }]));
  entries.forEach((e, i) => {
    const m = running.get(`${e.refType}:${e.refId}`);
    if (e.inventoryType === "Stock In") {
      m.current += e.quantity;
      return;
    }
    const available = m.current - m.reserved;
    if (e.quantity > available) {
      if (m.current <= 0 && m.reserved <= 0) {
        throw `Inventory has not been initialized for ${describe(m)}: no stock has been added yet. Add stock (Stock In) before a stock-out (row ${i + 1}).`;
      }
      throw `Cannot stock out ${e.quantity} of ${describe(m)} (row ${i + 1}): only ${Math.max(0, available)} available (${m.current} in stock, ${m.reserved} reserved by pending bookings).`;
    }
    m.current -= e.quantity;
  });
}

async function rowsOfBatch(batchId) {
  return InventoryAdjustment.find({ batchId }).sort({ requestId: 1 });
}

/**
 * @param {{ batchId: string, entries: {refType, refId, inventoryType, quantity, remarks?}[], userId?: any, source?: "Inventory Adjustment" | "Available Stock" }} input
 * @returns {Promise<{ duplicate: boolean, rows: any[] }>}
 */
async function applyAdjustmentBatch({ batchId, entries, userId = null, source = "Inventory Adjustment" }) {
  // A repeat of a submission that already went through: answer with what it did, change nothing.
  const already = await rowsOfBatch(batchId);
  if (already.length > 0) return { duplicate: true, rows: already };

  const masters = await loadMasters(entries);
  validateEntries(entries, masters);

  try {
    const rows = await runInTransaction(async (session) => {
      const created = [];
      const applied = [];
      try {
        for (let i = 0; i < entries.length; i += 1) {
          const e = entries[i];
          const result = await applyManualDelta(e.refType, e.refId, e.inventoryType, e.quantity, { session });
          if (!result) {
            const m = masters.get(`${e.refType}:${e.refId}`);
            throw new InventoryConflict(`Stock for ${describe(m)} was changed by another user while you were adjusting it. Refresh the stock list and try again.`);
          }
          applied.push(e);
          const [row] = await InventoryAdjustment.create(
            [
              {
                refType: e.refType,
                refId: e.refId,
                inventoryType: e.inventoryType,
                quantity: e.quantity,
                previousStock: result.previous,
                balance: result.doc.currentStock,
                remarks: e.remarks ?? "",
                source,
                requestId: `${batchId}:${i}`,
                batchId,
                createdBy: userId,
              },
            ],
            { session }
          );
          created.push(row);
          // New stock settles outstanding Stock Reserve shortages first; only the rest stays as available stock.
          if (e.inventoryType === "Stock In") await fulfilDeficits({ refType: e.refType, refId: e.refId, incoming: e.quantity, session, userId });
        }
        return created;
      } catch (err) {
        // Without transactions (standalone database) undo the rows already applied, best effort, then rethrow.
        if (!session) {
          for (let i = applied.length - 1; i >= 0; i -= 1) {
            const e = applied[i];
            const inverse = e.inventoryType === "Stock In" ? "Stock Out" : "Stock In";
            await applyManualDelta(e.refType, e.refId, inverse, e.quantity).catch(() => {});
          }
          await InventoryAdjustment.deleteMany({ batchId }).catch(() => {});
        }
        throw err;
      }
    });
    return { duplicate: false, rows };
  } catch (err) {
    // Two identical submissions raced: the unique key let exactly one through - report that one's result.
    if (err?.code === 11000) return { duplicate: true, rows: await rowsOfBatch(batchId) };
    throw err;
  }
}

module.exports = { applyAdjustmentBatch, InventoryConflict };
