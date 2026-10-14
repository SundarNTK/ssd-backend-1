const mongoose = require("mongoose");
const eventSlotSchema = require("../shared/event-slot-schema");
const { auditablePlugin } = require("../../common/plugins/auditable");

/**
 * The POS counter's own order/cart-hold table — dedicated to the Cash /
 * PayNow / NETS payment flow at the physical counter, kept separate from
 * the shared `Order` collection (models/orders) that continues to back the
 * Admin Panel's Booking screen. Same lifecycle shape as that collection
 * (see its own comment for the full rationale — pending cart hold with a
 * 30-minute inventory reservation, confirmed once payment lands), just
 * persisted in its own `pos_orders` collection so the POS counter's
 * payment data never mixes with admin-entered bookings.
 *
 * `referenceId` is the field PayNow/NETS actually see — see
 * common/utils/payment-reference.js.
 */

const posOrderLineSchema = new mongoose.Schema(
  {
    refType: { type: String, enum: ["Item", "Service", "GeneralItem", "Event"], required: true },
    refId: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: "refType" },
    name: { type: String, required: true },
    code: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    // GST snapshot at sale time — unitPrice is the GST-inclusive counter
    // price, so gstAmount is extracted out of lineTotal (never added on
    // top) and glAmount is the remainder posted to generalLedger. Frozen
    // here rather than re-derived, since generalLedger/gstType/gstRate can
    // all change after the sale. See common/utils/gst-rate.js.
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

const POS_ORDER_STATUSES = ["pending", "confirmed", "cancelled"];

const posOrderSchema = new mongoose.Schema({
  // The 13-char PayNow/NETS-facing correlation id — see
  // common/utils/payment-reference.js. Distinct from orderNumber, which is
  // the human-readable receipt-facing id (POS-YYYYMMDD-NNNN).
  referenceId: { type: String, required: true },

  orderNumber: { type: String, required: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },

  lines: { type: [posOrderLineSchema], default: [] },

  subtotal: { type: Number, required: true, min: 0, default: 0 },
  gstAmount: { type: Number, required: true, min: 0, default: 0 },
  grandTotal: { type: Number, required: true, min: 0, default: 0 },

  paymentMode: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentMode", required: true },
  paymentModeName: { type: String, required: true },

  orderStatus: { type: String, enum: POS_ORDER_STATUSES, default: "pending" },

  // Set when this order is confirmed and a PosBooking record is created
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "PosBooking", default: null },

  // When the pending hold expires — used by the cleanup job as a fence post.
  expiresAt: { type: Date, required: true },

  bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  entity: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Which screen took the booking: the POS counter, or the Admin Panel's Booking page (same
  // order / payment flow, so same collections). Records from before this field are POS.
  portal: { type: String, enum: ["pos", "admin"], default: "pos" },

  // Denormalized snapshots — see common/utils/entity-snapshot. Frozen at
  // write time, same as the line items; not retroactively updated.
  customerInfo: { type: mongoose.Schema.Types.Mixed, default: null },
  bookedByInfo: { type: mongoose.Schema.Types.Mixed, default: null },
});

posOrderSchema.pre("save", async function populatePosOrderSnapshots() {
  const { buildUserSnapshot, buildCustomerSnapshot } = require("../../common/utils/entity-snapshot");
  if (this.isModified("customer") && this.customer) {
    this.customerInfo = await buildCustomerSnapshot(this.customer);
  }
  if (this.isModified("bookedBy") && this.bookedBy) {
    this.bookedByInfo = await buildUserSnapshot(this.bookedBy);
  }
});

posOrderSchema.plugin(auditablePlugin);

posOrderSchema.index({ referenceId: 1 }, { unique: true });
posOrderSchema.index({ orderNumber: 1 }, { unique: true });
posOrderSchema.index({ customer: 1, createdAt: -1 });
posOrderSchema.index({ orderStatus: 1, createdAt: -1 });
// Allows the cleanup job to find and process expired pending orders efficiently
posOrderSchema.index({ orderStatus: 1, expiresAt: 1 });

module.exports = {
  PosOrder: mongoose.model("PosOrder", posOrderSchema, "pos_orders"),
  POS_ORDER_STATUSES,
};
