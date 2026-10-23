const Joi = require("joi");

/**
 * Validation schemas for the POS counter's own order/payment write routes.
 * Mirrors controllers/pos/request-objects.js's cart-line/paidAmount shapes
 * exactly (the cart itself hasn't changed) — only the order/booking/payment
 * write endpoints move to this module; catalogue/customer lookups stay on
 * controllers/pos, shared by both the POS and Admin booking trees.
 */

const devoteeSchema = Joi.object({
  name: Joi.string().trim().min(1).max(150).required(),
  nakshatra: Joi.string().trim().allow("", null).default(""),
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
  deities: Joi.array().items(Joi.string().hex().length(24)).default([]),
  devotees: Joi.array().items(devoteeSchema).default([]),
  // See controllers/pos/request-objects.js's matching field for the full
  // rationale — General Items carry no master price, so the cashier's typed
  // amount is trusted ONLY for that refType; Item/Service stay server-priced.
  manualUnitPrice: Joi.number().min(0.01).when("refType", {
    is: "GeneralItem",
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
}).required();

/**
 * How much of the order/booking's grandTotal is being collected right now.
 * Omitted entirely means "pay in full". See controllers/pos's own comment
 * on paidAmountSchema for the full rationale — unchanged here.
 */
const paidAmountSchema = Joi.number().min(0).precision(2).optional();

/**
 * POST /pos/booking/orders
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
 */
const confirmOrderSchema = Joi.object({
  paymentReference: Joi.string().trim().allow("", null).default(null),
  paidAmount: paidAmountSchema,
});

/**
 * POST /pos/booking/bookings/:id/payments
 */
const recordPaymentSchema = Joi.object({
  amount: Joi.number().greater(0).precision(2).required(),
  paymentModeId: Joi.string().hex().length(24).allow(null).default(null),
});

/**
 * POST /pos/booking/nets/initiate — the balance-top-up counterpart to
 * POST /pos/booking/orders/:id/nets/initiate (keyed by referenceId rather
 * than an order _id, since a top-up on an already-confirmed booking has no
 * order-create response to hang a URL param off — same reasoning as
 * PayNow's own standalone POST /payments/paynow/generate-qr).
 */
const initiateNetsByReferenceSchema = Joi.object({
  referenceId: Joi.string().trim().required(),
  amount: Joi.number().greater(0).precision(2).required(),
});

/**
 * POST /pos/booking/manual-confirm — a cashier keys in the transaction
 * reference number printed on the NETS/Credit Card terminal's slip instead
 * of waiting for the terminal's own automatic callback. `transactionRefNo`
 * becomes the confirmed PosTransaction's `gatewayReference`, exactly like a
 * real terminal callback would set it — see confirmPosPayment.
 */
const manualTerminalConfirmSchema = Joi.object({
  referenceId: Joi.string().trim().required(),
  transactionRefNo: Joi.string().trim().min(1).max(100).required(),
});

module.exports = {
  cartLineSchema,
  createOrderSchema,
  confirmOrderSchema,
  recordPaymentSchema,
  initiateNetsByReferenceSchema,
  manualTerminalConfirmSchema,
};
