const mongoose = require("mongoose");
const eventSlotSchema = require("../shared/event-slot-schema");
const { auditablePlugin } = require("../../common/plugins/auditable");

/**
 * The POS counter's own permanent confirmed-record table — the `pos_`
 * counterpart to models/bookings, created exclusively by the POS
 * order/payment flow (controllers/pos-orders) and kept in its own
 * `pos_bookings` collection, separate from the Admin Panel's `bookings`.
 * Same snapshot-on-confirm semantics as that collection (see its own
 * comment): a frozen copy of the order's lines/prices, never retroactively
 * altered by a later catalogue change.
 */

const posBookingLineSchema = new mongoose.Schema(
  {
    refType: { type: String, enum: ["Item", "Service", "GeneralItem", "Event"], required: true },
    refId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    code: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    // Frozen GST/GL snapshot carried straight over from PosOrderLine at
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
    // The half of that day ("AM" / "PM") the booking was made for, when the master offers sessions. Null otherwise.
    session: { type: String, enum: ["AM", "PM"], default: null },
    seats: { type: Number, default: 1, min: 1 },
  },
  { _id: false }
);

const POS_BOOKING_STATUSES = ["confirmed", "cancelled"];
const POS_BOOKING_PAYMENT_STATUSES = ["paid", "partial", "pending"];

const posBookingSchema = new mongoose.Schema({
  bookingNumber: { type: String, required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "PosOrder", required: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
  // Who the booking was made for, exactly as entered at the desk when it was booked (name / Singapore mobile /
  // optional email). Kept on the booking so it still reads the same if the customer profile changes later.
  // Stock a late payment could not deduct (the hold had expired and the stock was gone): needs a manual follow-up
  // (restock, or refund). Empty for every normal booking.
  inventoryShortfall: {
    type: [{ refType: String, refId: mongoose.Schema.Types.ObjectId, name: String, quantity: Number, _id: false }],
    default: [],
  },
  customerDetails: {
    type: new mongoose.Schema(
      { name: { type: String, default: "" }, mobileNumber: { type: String, default: "" }, email: { type: String, default: "" } },
      { _id: false }
    ),
    default: null,
  },

  // Admin Booking only: the optional note typed by staff when booking. "" when none was entered.
  remarks: { type: String, default: "", trim: true, maxlength: 500 },

  lines: { type: [posBookingLineSchema], default: [] },

  subtotal: { type: Number, required: true, min: 0, default: 0 },
  gstAmount: { type: Number, required: true, min: 0, default: 0 },
  grandTotal: { type: Number, required: true, min: 0, default: 0 },

  paymentMode: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentMode", required: true },
  paymentModeName: { type: String, required: true },
  // "paid"    -> amountPaid (summed across this booking's PosTransaction
  //              rows, see models/pos-transactions) has reached grandTotal
  // "partial" -> some but not all of grandTotal has been collected; more
  //              PosTransaction rows can still be appended via
  //              POST /pos/booking/bookings/:id/payments
  // "pending" -> confirmed with nothing collected yet
  paymentStatus: { type: String, enum: POS_BOOKING_PAYMENT_STATUSES, default: "paid" },

  bookingStatus: { type: String, enum: POS_BOOKING_STATUSES, default: "confirmed" },

  bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  entity: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Which screen took the booking: the POS counter, or the Admin Panel's Booking page (same
  // order / payment flow, so same collections). Records from before this field are POS.
  portal: { type: String, enum: ["pos", "admin"], default: "pos" },
  ...require("../../common/utils/booking-reprint").reprintFields,
  ...require("../../common/booking-email/email-log").emailLogFields,
  // True when any payment on this booking was confirmed by hand (see PosTransaction.isManuallyConfirmed), so the
  // Transactions list can show and filter them without reading every payment.
  hasManualConfirmation: { type: Boolean, default: false },
  bookedAt: { type: Date, required: true },

  // Denormalized snapshots — see common/utils/entity-snapshot.
  customerInfo: { type: mongoose.Schema.Types.Mixed, default: null },
  bookedByInfo: { type: mongoose.Schema.Types.Mixed, default: null },
});

posBookingSchema.pre("save", async function populatePosBookingSnapshots() {
  const { buildUserSnapshot, buildCustomerSnapshot } = require("../../common/utils/entity-snapshot");
  if (this.isModified("customer") && this.customer) {
    this.customerInfo = await buildCustomerSnapshot(this.customer);
  }
  if (this.isModified("bookedBy") && this.bookedBy) {
    this.bookedByInfo = await buildUserSnapshot(this.bookedBy);
  }
});

posBookingSchema.plugin(auditablePlugin);

posBookingSchema.index({ bookingNumber: 1 }, { unique: true });
posBookingSchema.index({ hasManualConfirmation: 1, bookedAt: -1 });
posBookingSchema.index({ customer: 1, createdAt: -1 });
posBookingSchema.index({ bookingStatus: 1, createdAt: -1 });
posBookingSchema.index({ paymentStatus: 1, createdAt: -1 });
posBookingSchema.index({ orderId: 1 });

module.exports = {
  PosBooking: mongoose.model("PosBooking", posBookingSchema, "pos_bookings"),
  POS_BOOKING_STATUSES,
  POS_BOOKING_PAYMENT_STATUSES,
};
