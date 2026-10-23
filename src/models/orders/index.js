const mongoose = require("mongoose");
const eventSlotSchema = require("../shared/event-slot-schema");
const { auditablePlugin } = require("../../common/plugins/auditable");

/**
 * An order is the in-progress shopping-cart record created when the admin
 * clicks "Create Order" on the Admin Booking screen. It captures all chosen
 * items/services, their quantities, devotee details, and the chosen payment
 * mode, but does NOT yet write to the bookings table or decrement permanent
 * inventory.
 *
 * Lifecycle:
 *   pending  → created via POST /pos/orders
 *   confirmed → moved to Booking record via POST /pos/orders/:id/confirm
 *   cancelled → released when the 30-minute hold expires (TTL) or by manual
 *               abandon
 *
 * Inventory is held via InventoryReservation documents (a separate
 * collection) so that the hold can be released atomically by expiry without
 * touching this record.
 */

const orderLineSchema = new mongoose.Schema(
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
    // For services: each line can map to one or more deities
    deities: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Deity" }],
      default: [],
    },
    // Devotee entries for this line (name + nakshatra)
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

const ORDER_STATUSES = ["pending", "confirmed", "cancelled"];

// Which surface created this order.
// "admin"    — Admin Booking screen inside the Admin Panel
// "pos"      — POS Portal counter terminal (/pos)
// "customer" — Customer Portal self-service (future)
const PORTAL_TYPES = ["admin", "pos", "customer"];

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
  // Who the booking was made for, exactly as entered at the desk when it was booked (name / Singapore mobile /
  // optional email). Kept on the booking so it still reads the same if the customer profile changes later.
  customerDetails: {
    type: new mongoose.Schema(
      { name: { type: String, default: "" }, mobileNumber: { type: String, default: "" }, email: { type: String, default: "" } },
      { _id: false }
    ),
    default: null,
  },

  // Admin Booking only: the optional note typed by staff when booking. "" when none was entered.
  remarks: { type: String, default: "", trim: true, maxlength: 500 },

  lines: { type: [orderLineSchema], default: [] },

  subtotal: { type: Number, required: true, min: 0, default: 0 },
  gstAmount: { type: Number, required: true, min: 0, default: 0 },
  grandTotal: { type: Number, required: true, min: 0, default: 0 },

  paymentMode: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentMode", required: true },
  paymentModeName: { type: String, required: true },

  orderStatus: { type: String, enum: ORDER_STATUSES, default: "pending" },

  // Which surface created this order — stamped server-side from the route
  // segment, never trusted from the client body.
  //   "admin"    → Admin Booking screen (Admin Panel)
  //   "pos"      → POS Portal counter terminal
  //   "customer" → Customer Portal self-service (future)
  portal: { type: String, enum: PORTAL_TYPES, default: "admin" },

  // Set when this order is confirmed and a Booking record is created
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },

  // When the pending hold expires — used by the cleanup job as a fence post.
  // Orders placed by admin never expire (set far in the future), but the
  // field must exist for the TTL-reservation logic to read.
  expiresAt: { type: Date, required: true },

  // Booked by which admin
  bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  // Entity context at the time of booking
  entity: { type: mongoose.Schema.Types.ObjectId, default: null },

  // Denormalized snapshots — see common/utils/entity-snapshot. Frozen at
  // write time, same as the line items; not retroactively updated.
  customerInfo: { type: mongoose.Schema.Types.Mixed, default: null },
  bookedByInfo: { type: mongoose.Schema.Types.Mixed, default: null },
});

orderSchema.pre("save", async function populateOrderSnapshots() {
  const { buildUserSnapshot, buildCustomerSnapshot } = require("../../common/utils/entity-snapshot");
  if (this.isModified("customer") && this.customer) {
    this.customerInfo = await buildCustomerSnapshot(this.customer);
  }
  if (this.isModified("bookedBy") && this.bookedBy) {
    this.bookedByInfo = await buildUserSnapshot(this.bookedBy);
  }
});

orderSchema.plugin(auditablePlugin);

orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index({ customer: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1, createdAt: -1 });
// Allows the cleanup job to find and process expired pending orders efficiently
orderSchema.index({ orderStatus: 1, expiresAt: 1 });

module.exports = { Order: mongoose.model("Order", orderSchema), ORDER_STATUSES, PORTAL_TYPES };
