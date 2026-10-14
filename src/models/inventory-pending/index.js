const mongoose = require("mongoose");

/**
 * The "entered count" of the Available Stock screen: the NET stock change someone has queued for one item/service
 * but not applied yet (+10 queued, then -2 queued = +8). One row per item; kept in the database - not in the
 * browser - so it survives a reload, another device or another user. "Add to Adjust" applies it as one Stock In /
 * Stock Out and resets it to 0. Nothing here touches physical stock; only applying does.
 */
const inventoryPendingSchema = new mongoose.Schema(
  {
    refType: { type: String, enum: ["Item", "Service", "GeneralItem"], required: true },
    refId: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: "refType" },
    // Signed whole number: positive = stock in waiting, negative = stock out waiting.
    pendingQuantity: { type: Number, default: 0 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lastActivityAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

inventoryPendingSchema.index({ refType: 1, refId: 1 }, { unique: true });

module.exports = mongoose.model("InventoryPending", inventoryPendingSchema);
