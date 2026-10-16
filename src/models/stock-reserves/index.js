const mongoose = require("mongoose");

/**
 * Stock Reserve - stock set aside for a FUTURE session date.
 *
 * A booking whose session date is still ahead does not touch physical stock when it is confirmed. Its pending-payment
 * Stock Hold (models/inventory-reservations) is released and one row here records "N units for <session date>"
 * instead. When that date arrives (Singapore time) the scheduled job deducts the units (common/utils/stock-reserve).
 * If there is not enough stock then, the missing units stay on this row as the shortage; the next stock-in settles
 * outstanding shortages first and only the rest raises the available stock.
 *
 * Hold = waiting for payment (30 minutes). Reserve = paid, waiting for its session date. They never overlap: the
 * hold is released at the moment the reserve is written, in one transaction.
 */
const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    // created | processed | shortage | fulfilled | failed | retry | cancelled
    event: { type: String, required: true },
    quantity: { type: Number, default: 0 },
    message: { type: String, default: "" },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // "scheduler" | "manual" | "stock-in"
    source: { type: String, default: "" },
  },
  { _id: false }
);

const stockReserveSchema = new mongoose.Schema(
  {
    refType: { type: String, enum: ["Item", "Service", "GeneralItem"], required: true },
    refId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // As they were when reserved, so the list still reads right if the master is renamed.
    name: { type: String, default: "" },
    code: { type: String, default: "" },

    // The booked day, "YYYY-MM-DD" (Singapore). The scheduler goes by THIS, never by when the order was made.
    sessionDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    // Booking units, and the stock units to take out (booked x Quantity Reduction).
    bookedQuantity: { type: Number, required: true, min: 1 },
    stockQuantity: { type: Number, required: true, min: 1 },
    reductionFactor: { type: Number, default: 1 },

    orderId: { type: mongoose.Schema.Types.ObjectId, default: null },
    bookingNumber: { type: String, default: null },
    // Makes writing the same reserve twice impossible (a retried confirmation): "hold:<id>" or "late:<order>:<line>".
    reserveKey: { type: String, required: true },
    // Paid after the pending-payment hold had already expired.
    lateConfirmation: { type: Boolean, default: false },

    // upcoming -> processing -> processed | partial | shortage | failed ; cancelled. (Screen status is derived: see
    // controllers/inventory/stock-reserve-api.)
    status: { type: String, enum: ["upcoming", "processing", "processed", "partial", "shortage", "failed", "cancelled"], default: "upcoming" },

    // Stock free when the date was processed (physical minus units held for pending payments).
    availableBefore: { type: Number, default: null },
    deductedQuantity: { type: Number, default: 0 },
    // Still owed after processing; shrinks as incoming stock settles it.
    shortageQuantity: { type: Number, default: 0 },
    // Part of deductedQuantity that came from later stock-ins.
    fulfilledQuantity: { type: Number, default: 0 },

    processedAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
    history: { type: [historySchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, versionKey: false }
);

stockReserveSchema.index({ reserveKey: 1 }, { unique: true });
stockReserveSchema.index({ status: 1, sessionDate: 1 });
stockReserveSchema.index({ refType: 1, refId: 1, status: 1 });
stockReserveSchema.index({ orderId: 1 });
stockReserveSchema.index({ bookingNumber: 1 });

module.exports = mongoose.model("StockReserve", stockReserveSchema);
