const mongoose = require("mongoose");
const eventSlotSchema = require("../shared/event-slot-schema");
const { auditablePlugin } = require("../../common/plugins/auditable");

/**
 * A Booking is the permanent, confirmed record of a transaction. It is
 * created exclusively by POST /pos/orders/:id/confirm and represents the
 * single source of truth for "this purchase happened".
 *
 * It mirrors the Order's line items but is intentionally a snapshot —
 * changes to the Item/Service master after booking must NOT retroactively
 * alter a receipt. Prices, names and codes are denormalised here.
 *
 * Inventory stock is permanently decremented (via an InventoryAdjustment
 * "Stock Out") at the moment this record is inserted.
 */

const bookingLineSchema = new mongoose.Schema(
  {
    refType: { type: String, enum: ["Item", "Service", "GeneralItem", "Event"], required: true },
    refId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    code: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    // Frozen GST/GL snapshot carried straight over from OrderLine at
    // confirm time — see that schema's comment for why it's a snapshot
    // rather than a re-derived value.
    generalLedger: { type: mongoose.Schema.Types.ObjectId, ref: "GeneralLedger", default: null },
    gstType: { type: String, default: "" },
    gstRate: { type: Number, required: true, min: 0, default: 0 },
    gstAmount: { type: Number, required: true, min: 0, default: 0 },
    glAmount: { type: Number, required: true, min: 0, default: 0 },
    deities: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Deity" }],
      default: [],
    },
    devotees: {
      type: [
        {
          name: { type: String, required: true },
          nakshatra: { type: String, default: "" },
        },
      ],
      default: [],
    },
    lineTotal: { type: Number, required: true, min: 0 },
    // Event lines only: the slot the booking was made for, and how many of
    // its seats this line takes (see common/utils/event-line.js). Null / 1
    // for Item, Service and General Item lines.
    eventSlot: { type: eventSlotSchema, default: null },
    // Item/Service/Event with a session rule: the day ("YYYY-MM-DD") it was booked for. Null otherwise.
    sessionDate: { type: String, default: null },
    seats: { type: Number, default: 1, min: 1 },
  },
  { _id: false }
);

const BOOKING_STATUSES = ["confirmed", "cancelled"];

// Re-import from orders so both collections share the same constant and
// stay in sync when a new portal surface is added.
const { PORTAL_TYPES } = require("../orders");

const bookingSchema = new mongoose.Schema({
  bookingNumber: { type: String, required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },

  lines: { type: [bookingLineSchema], default: [] },

  subtotal: { type: Number, required: true, min: 0, default: 0 },
  gstAmount: { type: Number, required: true, min: 0, default: 0 },
  grandTotal: { type: Number, required: true, min: 0, default: 0 },

  paymentMode: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentMode", required: true },
  paymentModeName: { type: String, required: true },
  // "paid"    → amountPaid (summed across this booking's Transaction rows,
  //             see models/transactions) has reached grandTotal
  // "partial" → some but not all of grandTotal has been collected; more
  //             Transaction rows can still be appended via
  //             POST /pos/booking/bookings/:id/payments
  // "pending" → confirmed with nothing collected yet (a "pay later" booking)
  paymentStatus: { type: String, enum: ["paid", "partial", "pending"], default: "paid" },

  bookingStatus: { type: String, enum: BOOKING_STATUSES, default: "confirmed" },

  // Copied from the originating Order at confirm time — which surface
  // (Admin Panel, POS counter, or future Customer Portal) created this booking.
  portal: { type: String, enum: PORTAL_TYPES, default: "admin" },
  ...require("../../common/utils/booking-reprint").reprintFields,

  bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  entity: { type: mongoose.Schema.Types.ObjectId, default: null },
  bookedAt: { type: Date, required: true },

  // Denormalized snapshots — see common/utils/entity-snapshot. Frozen at
  // write time, the same way the line items already are; not retroactively
  // updated by a later name/role change.
  customerInfo: { type: mongoose.Schema.Types.Mixed, default: null },
  bookedByInfo: { type: mongoose.Schema.Types.Mixed, default: null },
});

bookingSchema.pre("save", async function populateBookingSnapshots() {
  const { buildUserSnapshot, buildCustomerSnapshot } = require("../../common/utils/entity-snapshot");
  if (this.isModified("customer") && this.customer) {
    this.customerInfo = await buildCustomerSnapshot(this.customer);
  }
  if (this.isModified("bookedBy") && this.bookedBy) {
    this.bookedByInfo = await buildUserSnapshot(this.bookedBy);
  }
});

bookingSchema.plugin(auditablePlugin);

bookingSchema.index({ bookingNumber: 1 }, { unique: true });
bookingSchema.index({ customer: 1, createdAt: -1 });
bookingSchema.index({ bookingStatus: 1, createdAt: -1 });
bookingSchema.index({ paymentStatus: 1, createdAt: -1 });
bookingSchema.index({ portal: 1, createdAt: -1 });
bookingSchema.index({ orderId: 1 });

module.exports = { Booking: mongoose.model("Booking", bookingSchema), BOOKING_STATUSES };
