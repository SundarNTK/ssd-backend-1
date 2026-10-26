/**
 * Physical stock count - the shelf is counted and the number typed on the Available Stock screen. The difference
 * from the system's Stock in Hand is booked as ONE stock movement (source "Physical Count": excess = Stock In, short =
 * Stock Out) and the count itself is kept in the Physical Stock History. A count that matches changes no stock.
 *
 * The write is one conditional update that also checks the stock is still what the count was compared with, so a
 * booking or adjustment landing in between makes the count fail ("changed by another user") instead of overwriting it.
 * The request carries a client-generated id, so a double click or retry is applied exactly once.
 */
const mongoose = require("mongoose");
const InventoryAdjustment = require("../../models/inventory-adjustments");
const PhysicalStockCount = require("../../models/physical-stock-counts");
const { fulfilDeficits } = require("../../common/utils/stock-reserve");
const { templeToday } = require("../../common/utils/stock-ledger");
const { REF_MODELS, trackedFilter, runInTransaction } = require("../../common/utils/inventory-stock");
const { InventoryConflict } = require("./adjust");

/**
 * @param {{ refType: string, refId: string, physicalQuantity: number, remarks?: string, requestId: string, userId?: any }} input
 * @returns {Promise<{ duplicate: boolean, count: any }>}
 */
async function applyPhysicalCount({ refType, refId, physicalQuantity, remarks = "", requestId, userId = null }) {
  const existing = await PhysicalStockCount.findOne({ requestId });
  if (existing) return { duplicate: true, count: existing };

  const Model = REF_MODELS[refType];
  const master = await Model.findOne(trackedFilter(Model, refType, refId)).select("name code currentStock reservedStock");
  if (!master) throw "This item doesn't exist, is inactive, or doesn't have inventory switched on.";

  const system = master.currentStock ?? 0;
  const difference = physicalQuantity - system;

  try {
    const count = await runInTransaction(async (session) => {
      let adjustment = null;
      if (difference !== 0) {
        // Set the stock to the counted figure only if it is still what the count was compared with.
        const updated = await Model.findOneAndUpdate(
          { ...trackedFilter(Model, refType, refId), currentStock: system },
          { $set: { currentStock: physicalQuantity } },
          { returnDocument: "after", session }
        );
        if (!updated) {
          throw new InventoryConflict(`Stock for "${master.name}" was changed by another user while you were counting it. Refresh the stock list and count again.`);
        }
        [adjustment] = await InventoryAdjustment.create(
          [
            {
              refType,
              refId,
              inventoryType: difference > 0 ? "Stock In" : "Stock Out",
              quantity: Math.abs(difference),
              previousStock: system,
              balance: physicalQuantity,
              remarks: remarks ? `Physical count: ${remarks}` : `Physical count: counted ${physicalQuantity}, system ${system}`,
              source: "Physical Count",
              requestId: `count:${requestId}`,
              createdBy: userId,
            },
          ],
          { session }
        );
        // Excess stock settles outstanding Stock Reserve shortages first, like any other stock coming in.
        if (difference > 0) await fulfilDeficits({ refType, refId, incoming: difference, session, userId });
      }
      const [row] = await PhysicalStockCount.create(
        [
          {
            refType,
            refId,
            name: master.name,
            code: master.code,
            countDate: templeToday(),
            systemQuantity: system,
            physicalQuantity,
            difference,
            remarks,
            adjustmentId: adjustment?._id ?? null,
            requestId,
            createdBy: userId,
          },
        ],
        { session }
      );
      return row;
    });
    return { duplicate: false, count: count };
  } catch (err) {
    // Two identical submissions raced: the unique key let exactly one through - report that one's result.
    if (err?.code === 11000) return { duplicate: true, count: await PhysicalStockCount.findOne({ requestId }) };
    throw err;
  }
}

module.exports = { applyPhysicalCount };
