const mongoose = require("mongoose");
const { auditablePlugin } = require("../../common/plugins/auditable");

/**
 * Append-only history of everything done on the Available Stock screen: each quantity queued (stock in / stock
 * out), each "Add to Adjust" that applied the queue to real stock, and each queue that was cleared. Who, when, and
 * the counts before and after. Written in the same transaction as the change it describes. (The movements that
 * actually changed physical stock are ALSO in Inventory Adjustment - this is the fuller trail around them.)
 */
const availableStockHistorySchema = new mongoose.Schema({
  refType: { type: String, enum: ["Item", "Service", "GeneralItem"], required: true },
  refId: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: "refType" },
  // Name and code as they were at the time, so the history still reads right if the master is renamed.
  name: { type: String, default: "" },
  code: { type: String, default: "" },
  action: { type: String, enum: ["Queued Stock In", "Queued Stock Out", "Added to Adjust", "Cleared Queue"], required: true },
  // Units involved (always positive; the action says the direction). For "Added to Adjust": the net applied.
  quantity: { type: Number, required: true, min: 0 },
  // For "Added to Adjust" / queue rows: the direction of the net applied or queued.
  inventoryType: { type: String, enum: ["Stock In", "Stock Out", null], default: null },
  // The entered (queued) count before and after this action.
  pendingBefore: { type: Number, default: 0 },
  pendingAfter: { type: Number, default: 0 },
  // Physical stock before and after - changes only on "Added to Adjust"; the current figure otherwise.
  stockBefore: { type: Number, default: null },
  stockAfter: { type: Number, default: null },
  // The Inventory Adjustment row an "Added to Adjust" created.
  adjustmentId: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryAdjustment", default: null },
  remarks: { type: String, default: "" },
  // Makes a retried request recognisable (unique), so one action is never recorded - or applied - twice.
  requestId: { type: String, default: undefined },
});

availableStockHistorySchema.plugin(auditablePlugin);

availableStockHistorySchema.index({ refType: 1, refId: 1, createdAt: -1 });
availableStockHistorySchema.index({ createdAt: -1 });
availableStockHistorySchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: "string" } } });

module.exports = mongoose.model("AvailableStockHistory", availableStockHistorySchema);
