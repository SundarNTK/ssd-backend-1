const mongoose = require("mongoose");
const { auditablePlugin } = require("../../common/plugins/auditable");

/**
 * Append-only log of every manual stock movement — one row per
 * POST /inventory/adjustments call, never edited or soft-deleted after
 * that. Uses the shared auditablePlugin for consistency with every other
 * model in the platform (createdBy/timestamps are genuinely useful here —
 * "who moved this stock, when" — even though status/isDeleted/softDelete
 * are never exercised on a row that's meant to be a permanent record).
 */
const inventoryAdjustmentSchema = new mongoose.Schema({
  refType: { type: String, enum: ["Item", "Service", "GeneralItem"], required: true },
  // Dynamic ref — resolves to Item or Service per-document via refPath,
  // matching this row's own refType.
  refId: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: "refType" },
  inventoryType: { type: String, enum: ["Stock In", "Stock Out"], required: true },
  // Stock units that actually moved (for a booking: booked quantity x reduction factor).
  quantity: { type: Number, required: true, min: 1 },
  // Booking movements only: the quantity booked and the stock units each booked unit uses (Quantity Reduction), so
  // "3 booked x 5 per unit = 15" can be read back from the record.
  bookedQuantity: { type: Number, default: null },
  reductionFactor: { type: Number, default: null },
  // The ref's stock immediately BEFORE this movement (balance is the stock after it), so previous -> balance reads as one step.
  previousStock: { type: Number, default: null },
  // The ref's currentStock immediately after this movement was applied —
  // stored rather than recomputed so history stays accurate even if the
  // ref's stock is later corrected by an out-of-band adjustment.
  balance: { type: Number, required: true, min: 0 },
  remarks: { type: String, default: "" },
  // Where the movement came from: typed directly on the Inventory Adjustment screen, queued on Available Stock and
  // sent with "Add to Adjust", or deducted by a confirmed booking.
  source: { type: String, enum: ["Inventory Adjustment", "Available Stock", "Booking"], default: "Inventory Adjustment" },
  // One-time key of this movement ("<batchId>:<n>" for a manual batch, "consume:<reservationId>" for a booking):
  // the unique index below makes a retried request or a repeated confirmation impossible to apply twice.
  requestId: { type: String, default: undefined },
  // Groups the rows of one "Add to Adjust" submission.
  batchId: { type: String, default: undefined },
});

inventoryAdjustmentSchema.plugin(auditablePlugin);

inventoryAdjustmentSchema.index({ refType: 1, refId: 1, createdAt: -1 });
inventoryAdjustmentSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: "string" } } });
inventoryAdjustmentSchema.index({ batchId: 1 }, { partialFilterExpression: { batchId: { $type: "string" } } });

module.exports = mongoose.model("InventoryAdjustment", inventoryAdjustmentSchema);
