const mongoose = require("mongoose");

/**
 * Inventory Reservation — a temporary hold placed when a cart/order is
 * created, released either when:
 *  (a) the order is confirmed   → reservation is marked "consumed"
 *  (b) 30 minutes elapse        → reservation is marked "expired" by the
 *                                  cleanup job and the held quantity is
 *                                  returned to the pool
 *  (c) the order is cancelled   → same as (b), but immediate
 *
 * The hold is a SOFT lock on Item/Service.currentStock. The real stock is
 * NOT decremented at order creation — only at confirmation. What IS
 * decremented at order creation is the "available for new reservations"
 * calculation:
 *
 *   available = currentStock
 *             - SUM(active reservation quantities for this ref)
 *
 * This is computed at booking time by the summary endpoint and re-checked
 * atomically inside createOrder. The 30-minute TTL ensures a crashed or
 * abandoned session never permanently consumes stock.
 *
 * NOTE: this model intentionally does NOT use auditablePlugin — these are
 * transient operational records, not master data. They carry their own
 * minimal index set and no soft-delete.
 */
const inventoryReservationSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    // Position of the line in the order, so confirming an order finds exactly this line's hold.
    lineKey: { type: Number, default: null },
    // The payment correlation id / booking this hold ended up on, once known.
    referenceId: { type: String, default: null },
    bookingNumber: { type: String, default: null },
    refType: { type: String, enum: ["Item", "Service", "GeneralItem"], required: true },
    refId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // Booking units on the line (what the customer asked for).
    quantity: { type: Number, required: true, min: 1 },
    // Stock units held for it = quantity x the master's Quantity Reduction (null on rows made before that: = quantity).
    stockQuantity: { type: Number, default: null, min: 1 },
    // "active" → holds quantity from the pool
    // "consumed" → order confirmed; permanent stock-out via InventoryAdjustment
    // "expired" → 30-min window passed; quantity returned
    // "cancelled" → order explicitly abandoned
    status: {
      type: String,
      enum: ["active", "consumed", "expired", "cancelled"],
      default: "active",
    },
    expiresAt: { type: Date, required: true },
    releasedAt: { type: Date, default: null },
    // Why a hold ended without being consumed ("reservation expired after 30 minutes", "payment cancelled", ...).
    releaseReason: { type: String, default: null },
    // When payment confirmed it (status "consumed"), and whether that happened AFTER the hold had already lapsed.
    confirmedAt: { type: Date, default: null },
    lateConfirmation: { type: Boolean, default: false },
    // Units a late confirmation could not deduct because the stock was gone (see consumeReservations).
    shortfallQty: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

// Primary query: "how much is currently reserved for this ref?"
inventoryReservationSchema.index({ refType: 1, refId: 1, status: 1 });
// Cleanup job: find all active reservations that have expired
inventoryReservationSchema.index({ status: 1, expiresAt: 1 });
// Order cancellation: find all reservations for a given order
inventoryReservationSchema.index({ orderId: 1, status: 1 });
// One hold per order line - a retried order write can never double-hold the same line.
inventoryReservationSchema.index({ orderId: 1, lineKey: 1 }, { unique: true, partialFilterExpression: { lineKey: { $type: "number" } } });

module.exports = mongoose.model("InventoryReservation", inventoryReservationSchema);
