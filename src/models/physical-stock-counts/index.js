const mongoose = require("mongoose");
const { auditablePlugin } = require("../../common/plugins/auditable");

/**
 * Append-only history of every physical stock count taken on the Available Stock screen: what the system said was
 * in hand, what was actually counted, and the difference. A difference is booked as one stock movement (source
 * "Physical Count") on Inventory Adjustment - excess = Stock In, short = Stock Out - and linked here.
 */
const physicalStockCountSchema = new mongoose.Schema({
  refType: { type: String, enum: ["Item", "Service", "GeneralItem"], required: true },
  refId: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: "refType" },
  // Name and code as they were at the time, so the history still reads right if the master is renamed.
  name: { type: String, default: "" },
  code: { type: String, default: "" },
  // The temple (Singapore) day the count was taken, "YYYY-MM-DD".
  countDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  // Stock in hand according to the system when the count was entered, and what was counted.
  systemQuantity: { type: Number, required: true },
  physicalQuantity: { type: Number, required: true, min: 0 },
  // physical - system: negative = short, positive = excess, 0 = matched.
  difference: { type: Number, required: true },
  remarks: { type: String, default: "" },
  // The Inventory Adjustment row created for a non-zero difference.
  adjustmentId: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryAdjustment", default: null },
  // Makes a retried request recognisable (unique), so one count is never recorded - or applied - twice.
  requestId: { type: String, default: undefined },
});

physicalStockCountSchema.plugin(auditablePlugin);

physicalStockCountSchema.index({ refType: 1, refId: 1, createdAt: -1 });
physicalStockCountSchema.index({ countDate: 1, createdAt: -1 });
physicalStockCountSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: "string" } } });

module.exports = mongoose.model("PhysicalStockCount", physicalStockCountSchema);
