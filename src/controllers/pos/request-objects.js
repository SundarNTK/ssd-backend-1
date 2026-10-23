const Joi = require("joi");
const familyMemberSchema = require("../../utilities/constants/schemas/family-member");

/**
 * Validation schemas for all POS / Admin Booking request bodies.
 * Follows the same Joi pattern as the inventory controller's request-objects.js.
 */

const devoteeSchema = Joi.object({
  name: Joi.string().trim().min(1).max(150).required(),
  nakshatra: Joi.string().trim().allow("", null).default(""),
});

/**
 * PATCH /customers/:id/family-members — the Customer's own profile shape
 * (reuses the shared schema the admin Customer master validates against),
 * not `devoteeSchema` above: that one is the per-booking, free-text devotee
 * row; this one is what actually gets appended to `Customer.familyMembers`.
 */
const addFamilyMembersSchema = Joi.object({
  familyMembers: Joi.array().items(familyMemberSchema).min(1).required(),
});

const cartLineSchema = Joi.object({
  refType: Joi.string().valid("Item", "Service", "GeneralItem", "Event").required(),
  // Event lines only: which slot (see common/utils/event-line.js slotKeyOf).
  slotKey: Joi.string().trim().max(300).allow("", null).default(null),
  // Event lines only: the seat hold the cart took for this line.
  holdId: Joi.string().hex().length(24).allow("", null).default(null),
  // Item/Service/Event with a session rule: the chosen day, "YYYY-MM-DD" (default today).
  sessionDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow("", null).default(null),
  // AM / PM, for masters that offer sessions.
  session: Joi.string().valid("AM", "PM").allow("", null).default(null),
  refId: Joi.string().hex().length(24).required(),
  quantity: Joi.number().integer().min(1).required(),
  // For services: which deity ids this line is for
  deities: Joi.array().items(Joi.string().hex().length(24)).default([]),
  // Devotee names + nakshatras
  devotees: Joi.array().items(devoteeSchema).default([]),
  // General Items carry no master salePrice — the cashier types the amount
  // in at the point of sale, and the server trusts it ONLY for this
  // refType. Item/Service pricing stays fully server-resolved from the
  // master record — .forbidden() here rejects any client-sent price for
  // those two outright, rather than silently ignoring it.
  manualUnitPrice: Joi.number().min(0.01).when("refType", {
    is: "GeneralItem",
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
}).required();

/**
 * POST /pos/booking/summary
 * Accepts the current cart lines and returns per-line pricing + totals
 * including live available-quantity information.
 */
const summarySchema = Joi.object({
  customerId: Joi.string().hex().length(24).required(),
  lines: Joi.array().items(cartLineSchema).min(1).required(),
});

/**
 * How much of the order/booking's grandTotal is being collected right now.
 * Omitted entirely (undefined) means "pay in full" — every existing caller
 * that never sends this field keeps behaving exactly as before. Sending it
 * opens the partial-payment flow: any amount from 0 (confirm now, collect
 * later) up to the not-yet-known grandTotal is accepted here — the upper
 * bound is only checkable once the server has priced the cart, so the real
 * "can't exceed grandTotal" guard lives in the controller, not this schema.
 */
const paidAmountSchema = Joi.number().min(0).precision(2).optional();

/**
 * POST /pos/booking/orders
 * Creates an order record and places inventory reservations.
 */
const createOrderSchema = Joi.object({
  customerId: Joi.string().hex().length(24).required(),
  lines: Joi.array().items(cartLineSchema).min(1).required(),
  paymentModeId: Joi.string().hex().length(24).required(),
  paidAmount: paidAmountSchema,
  // The customer details typed at the desk, stored on the booking (see models' customerDetails).
  customerDetails: Joi.object({
    name: Joi.string().trim().max(150).allow("").default(""),
    mobileNumber: Joi.string().trim().max(20).allow("").default(""),
    email: Joi.string().trim().max(200).allow("").default(""),
  }).allow(null),
  // Admin Booking only: optional staff note stored on the booking ("" when empty).
  remarks: Joi.string().trim().max(500).allow("", null).default(""),
});

/**
 * POST /pos/booking/orders/:id/confirm
 * Confirms a pending order → creates a Booking, releases reservations
 * (marking them consumed), and writes permanent inventory Stock-Out rows.
 * No extra body for cash — this endpoint is the confirmation itself.
 */
const confirmOrderSchema = Joi.object({
  // Reserved for future online-payment receipt data (PayNow ref, etc.)
  // For cash the body may be empty or omitted entirely.
  paymentReference: Joi.string().trim().allow("", null).default(null),
  paidAmount: paidAmountSchema,
});

/**
 * POST /pos/booking/bookings/:id/payments
 * Records one more payment against an already-confirmed booking that isn't
 * fully paid yet — the "collect the rest of the balance" step of the
 * partial-payment flow. `paymentModeId` is optional: omit it to collect the
 * installment via the booking's original payment mode, or pass a different
 * mode's id (e.g. booked against Cash, topping up via PayNow).
 */
const recordPaymentSchema = Joi.object({
  amount: Joi.number().greater(0).precision(2).required(),
  paymentModeId: Joi.string().hex().length(24).allow(null).default(null),
});

/**
 * POST /pos/booking/recheck-lines
 * Re-validates a set of lines (from a past booking) against the live
 * catalogue — see recheckLines() for why this doesn't throw per-line.
 */
const recheckLinesSchema = Joi.object({
  lines: Joi.array().items(cartLineSchema).min(1).required(),
});

/**
 * GET /pos/booking/customers/search
 * Quick customer lookup for the "Personal Details" section.
 * Accepts ?query=<mobile|email|name>
 */
const customerSearchSchema = Joi.object({
  query: Joi.string().trim().min(1).max(100).required(),
}).required();

/**
 * POST /pos/booking/customers
 * Creates a walk-in devotee profile at the counter — mirrors Customer's own
 * required-field shape (name + email required, mobile optional), so a
 * walk-in profile isn't a lesser record than one created any other way.
 */
/**
 * Admin Booking's first step: just a name and a Singapore mobile number (8 digits, starting with 8 or 9).
 */
const quickCustomerSchema = Joi.object({
  name: Joi.string().trim().min(1).max(150).required(),
  mobileNumber: Joi.string().trim().pattern(/^[89]\d{7}$/).required().messages({
    "string.pattern.base": "Enter a valid 8-digit Singapore mobile number starting with 8 or 9.",
  }),
  // Optional - a placeholder is stored when left empty.
  email: Joi.string().trim().email({ tlds: false }).allow("", null).default(null),
});

const createCustomerSchema = Joi.object({
  name: Joi.string().trim().min(1).max(150).required(),
  email: Joi.string().trim().email({ tlds: false }).required(),
  mobileNumber: Joi.string().trim().allow("", null).default(null),
});


/**
 * Event seat holds - taken when an event goes into the cart, released when it
 * leaves it. See common/utils/event-seats.js.
 */
const holdSeatsSchema = Joi.object({
  eventId: Joi.string().hex().length(24).required(),
  slotKey: Joi.string().trim().max(300).required(),
  seats: Joi.number().integer().min(1).max(100).required(),
  // Editing a cart line: the hold being replaced (kept if the new one cannot be taken).
  replaceHoldId: Joi.string().hex().length(24).allow(null).default(null),
  // The browser tab taking the hold - lets a refreshed page release what its old cart held.
  clientId: Joi.string().trim().max(64).allow("", null).default(null),
});

/** A page that has just loaded has an empty cart: let go of whatever its tab's earlier cart still held. */
const releaseOrphanHoldsSchema = Joi.object({
  clientId: Joi.string().trim().min(8).max(64).required(),
});

const refreshHoldsSchema = Joi.object({
  clientId: Joi.string().trim().max(64).allow("", null).default(null),
  holds: Joi.array()
    .items(
      Joi.object({
        holdId: Joi.string().hex().length(24).allow(null).default(null),
        eventId: Joi.string().hex().length(24).required(),
        slotKey: Joi.string().trim().max(300).required(),
        seats: Joi.number().integer().min(1).max(100).required(),
      })
    )
    .min(1)
    .max(50)
    .required(),
});

module.exports = {
  summarySchema,
  createOrderSchema,
  confirmOrderSchema,
  customerSearchSchema,
  createCustomerSchema,
  quickCustomerSchema,
  addFamilyMembersSchema,
  recheckLinesSchema,
  recordPaymentSchema,
  holdSeatsSchema,
  refreshHoldsSchema,
  releaseOrphanHoldsSchema,
};
