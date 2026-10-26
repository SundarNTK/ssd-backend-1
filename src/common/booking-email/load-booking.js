/**
 * Loads everything the booking email and its PDF need, from whichever store the booking lives in: the POS / Admin
 * Booking store (pos_bookings + pos_transactions) or the older shared one (bookings + transactions). Both keep the
 * same line shape, so everything after this point treats them alike.
 */
const mongoose = require("mongoose");
const env = require("../../config/env");
const { PosBooking } = require("../../models/pos-bookings");
const { PosTransaction } = require("../../models/pos-transactions");
const { Booking } = require("../../models/bookings");
const { Transaction } = require("../../models/transactions");
const Entity = require("../../models/entities");
// Registered here so the populate() calls below work wherever this module is loaded from.
require("../../models/pos-orders");
require("../../models/orders");
require("../../models/deities");
require("../../models/payment-modes");
require("../../models/customers");
require("../../models/users");
const { isPlaceholderEmail } = require("../utils/customer-email");

const CUSTOMER_FIELDS = "customerCode name email mobileNumber";

/** A real address, or "" - never the placeholder a counter customer without an email carries. */
const realEmail = (value) => {
  const v = String(value || "").trim();
  return v && !isPlaceholderEmail(v) ? v : "";
};

/**
 * The email of the booking's contact person, or "" when there is none. It is the one stored on the booking; the
 * customer profile's email is used only for older bookings that stored none at all. A booking that stored a
 * placeholder (no email was given) has NO email - it must not fall back to the profile, which for a booking made
 * under the signed-in staff member's own profile is the staff member's address.
 */
function contactEmail(booking, customer) {
  const stored = String(booking?.customerDetails?.email || "").trim();
  return stored ? realEmail(stored) : realEmail(customer?.email);
}

async function findStore(id) {
  const query = (Model) =>
    Model.findOne(Model.notDeletedFilter({ _id: id }))
      .populate("customer", CUSTOMER_FIELDS)
      .populate("orderId", "orderNumber")
      .populate("paymentMode", "name")
      .populate({ path: "lines.deities", select: "name printOrder" })
      .populate("bookedBy", "name email");

  const posBooking = await query(PosBooking);
  if (posBooking) return { booking: posBooking, Transactions: PosTransaction, store: "pos" };
  const legacy = await query(Booking);
  if (legacy) return { booking: legacy, Transactions: Transaction, store: "legacy" };
  return null;
}

/**
 * @returns {Promise<{ booking: object, transactions: object[], customer: object|null, order: object|null,
 *   entity: object|null, entityId: any, store: string, recipient: string, model: any }>}
 */
async function loadBooking(id) {
  if (!mongoose.isValidObjectId(id)) throw "Invalid booking ID.";
  const found = await findStore(id);
  if (!found) throw "Booking not found.";

  const transactions = await found.Transactions.find(found.Transactions.notDeletedFilter({ bookingId: id, paymentStatus: "paid" }))
    .select("receiptNo amount paymentStatus paymentModeName transactionDate")
    .sort({ transactionDate: 1 })
    .lean();

  const booking = found.booking.toObject();
  for (const line of booking.lines || []) {
    // Print order, as the receipt shows the deities.
    line.deities = [...(line.deities || [])].sort((a, b) => (a.printOrder ?? 0) - (b.printOrder ?? 0));
  }

  const entity =
    (booking.entity ? await Entity.findById(booking.entity).lean() : null) ||
    (await Entity.findOne(Entity.notDeletedFilter({ code: String(env.DEFAULT_ENTITY_CODE).trim().toUpperCase() })).lean());

  const customer = booking.customer && typeof booking.customer === "object" ? booking.customer : null;
  // Who it goes to by default: the email typed for this booking, else the customer profile's.
  const recipient = contactEmail(booking, customer);

  return {
    booking,
    transactions,
    customer,
    order: booking.orderId && typeof booking.orderId === "object" ? booking.orderId : null,
    entity,
    entityId: entity?._id ?? booking.entity ?? null,
    store: found.store,
    recipient,
    model: found.store === "pos" ? PosBooking : Booking,
  };
}

module.exports = { loadBooking, realEmail, contactEmail };
