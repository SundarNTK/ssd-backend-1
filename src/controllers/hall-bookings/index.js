const express = require("express");
const { to12Hour } = require("../../common/utils/format-time");
const requirePermission = require("../../common/middleware/require-permission");
const mongoose = require("mongoose");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");
const escapeRegex = require("../../common/utils/escape-regex");
const { nextSequence } = require("../../common/utils/sequence");
const { resolveGstRate } = require("../../common/utils/gst-rate");
const { checkHallAvailability } = require("../../common/utils/hall-availability");
const createCustomerProfile = require("../../utilities/helpers/create-customer-profile");

const { Customer } = require("../../models/customers");
const Entity = require("../../models/entities");
const Hall = require("../../models/halls");
const HallPurpose = require("../../models/hall-purposes");
const HallPackage = require("../../models/hall-packages");
const FoodPackage = require("../../models/food-packages");
const FoodMenuItem = require("../../models/food-menu-items");
const AdditionalService = require("../../models/additional-services");
const PaymentMode = require("../../models/payment-modes");
const { HallBooking } = require("../../models/hall-bookings");
const { HallBookingPayment } = require("../../models/hall-booking-payments");
const env = require("../../config/env");

const {
  customerSearchSchema,
  createCustomerSchema,
  createBookingSchema,
  previewBookingSchema,
} = require("./request-objects");

const router = express.Router();

function searchRegex(term) {
  return new RegExp(escapeRegex(term.trim()), "i");
}

async function generateHallBookingNumber() {
  const n = await nextSequence("hall-booking");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `HBK${today}${String(n).padStart(4, "0")}`;
}

async function generateHallReceiptNumber() {
  const n = await nextSequence("hall-booking-receipt");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `HRC${today}${String(n).padStart(4, "0")}`;
}

/** Sum of this booking's payment rows — never stored on the booking itself, see models/hall-booking-payments' own comment. */
async function sumPaidAmount(bookingId) {
  const rows = await HallBookingPayment.find(HallBookingPayment.notDeletedFilter({ booking: bookingId })).select("amount");
  return +rows.reduce((sum, r) => sum + r.amount, 0).toFixed(2);
}

function derivePaymentStatus(amountPaid, finalAmount) {
  if (amountPaid >= finalAmount - 0.005) return "paid";
  if (amountPaid > 0) return "partial";
  return "unpaid";
}

/** exceptionHandler only ever renders a plain message string — fold the conflict detail into it rather than a separate structured field. */
function describeConflicts(conflicts) {
  if (!conflicts?.length) return "";
  const parts = conflicts.map((c) => `${c.hallOrPackage || "Hall"} is booked ${to12Hour(c.startTime)}–${to12Hour(c.endTime)} (${c.bookingNumber})`);
  return ` Conflict: ${parts.join("; ")}.`;
}

/**
 * The one place a Hall Booking's amounts get computed — used by booking
 * creation and by Manage Booking's edit-preview/edit, so a change to
 * pricing logic never has to be kept in sync across two implementations.
 * Loads and validates every referenced master itself; throws a plain
 * string (caught by the caller) on any invalid/inactive reference.
 */
async function computeBookingAmounts(input) {
  const {
    bookingType,
    hallId,
    hallPackageId,
    hallPurposeId,
    eventDate,
    startTime,
    endTime,
    foodRequired,
    foodPackageId,
    paxCount,
    removedMenuItemIds = [],
    additionalMenuItems = [],
    additionalServiceIds = [],
    discountPercentage = 0,
  } = input;

  const hallPurpose = await HallPurpose.findOne(HallPurpose.notDeletedFilter({ _id: hallPurposeId, status: 1 })).select("name");
  if (!hallPurpose) throw "Hall Purpose not found or inactive.";

  let hall = null;
  let hallPackage = null;
  let halls = [];
  let hallAmount = 0;
  let additionalHourAmount = 0;
  let depositAmount = 0;
  let hallGstApplicable = false;

  const requestedMinutes = toMinutesDiff(startTime, endTime);

  if (bookingType === "individual") {
    hall = await Hall.findOne(Hall.notDeletedFilter({ _id: hallId, status: 1 })).populate("category", "name");
    if (!hall) throw "Hall not found or inactive.";
    if (hall.minimumBookingDuration && requestedMinutes < hall.minimumBookingDuration * 60) {
      throw `This Hall requires a minimum booking duration of ${hall.minimumBookingDuration} hour(s).`;
    }
    halls = [hall._id];
    hallAmount = hall.individualBookingRate ?? 0;
    depositAmount = hall.depositAmount ?? 0;
    hallGstApplicable = false; // Hall Master carries no GST field — only Hall Package does.
  } else {
    hallPackage = await HallPackage.findOne(HallPackage.notDeletedFilter({ _id: hallPackageId, status: 1 })).populate("halls", "name status");
    if (!hallPackage) throw "Hall Package not found or inactive.";
    if (!hallPackage.halls.length) throw "This Hall Package has no Halls mapped to it.";
    halls = hallPackage.halls.map((h) => h._id);
    hallAmount = hallPackage.packagePrice;
    depositAmount = hallPackage.depositAmount ?? 0;
    hallGstApplicable = Boolean(hallPackage.gstApplicable);

    const standardMinutes = hallPackage.standardSessionDuration * 60;
    if (requestedMinutes > standardMinutes) {
      const extraHours = Math.ceil((requestedMinutes - standardMinutes) / 60);
      additionalHourAmount = +(extraHours * (hallPackage.additionalHourRate ?? 0)).toFixed(2);
    }
  }

  let foodAmount = 0;
  let foodAdjustmentAmount = 0;
  let foodPackage = null;
  let foodMenuSnapshot = [];
  let additionalFoodItems = [];
  let foodGstApplicable = false;

  if (foodRequired) {
    foodPackage = await FoodPackage.findOne(FoodPackage.notDeletedFilter({ _id: foodPackageId, status: 1 })).populate(
      "menuItems.menuItem",
      "name pricingBasis cost status"
    );
    if (!foodPackage) throw "Food Package not found or inactive.";
    if (paxCount < foodPackage.minimumBookingCount) {
      throw `This Food Package requires a minimum of ${foodPackage.minimumBookingCount} pax.`;
    }
    foodAmount = +(foodPackage.packagePricePerPax * paxCount).toFixed(2);
    foodGstApplicable = Boolean(foodPackage.gstApplicable);

    foodMenuSnapshot = foodPackage.menuItems.map((row) => ({
      menuItem: row.menuItem._id,
      name: row.menuItem.name,
      pricingBasis: row.menuItem.pricingBasis,
      cost: row.menuItem.cost,
      removed: removedMenuItemIds.some((id) => String(id) === String(row.menuItem._id)),
    }));

    for (const extra of additionalMenuItems) {
      const menuItem = await FoodMenuItem.findOne(FoodMenuItem.notDeletedFilter({ _id: extra.menuItemId, status: 1 }));
      if (!menuItem) throw "One of the additional Menu Items was not found or is inactive.";
      const amount = +(menuItem.cost * extra.quantity).toFixed(2);
      additionalFoodItems.push({
        menuItem: menuItem._id,
        name: menuItem.name,
        pricingBasis: menuItem.pricingBasis,
        cost: menuItem.cost,
        quantity: extra.quantity,
        amount,
      });
      foodAdjustmentAmount += amount;
    }
    foodAdjustmentAmount = +foodAdjustmentAmount.toFixed(2);
  }

  const additionalServicesSnapshot = [];
  for (const serviceId of additionalServiceIds) {
    const service = await AdditionalService.findOne(AdditionalService.notDeletedFilter({ _id: serviceId, status: 1 })).select("name");
    if (!service) throw "One of the Additional Services was not found or is inactive.";
    additionalServicesSnapshot.push({ service: service._id, name: service.name });
  }

  const subtotalAmount = +(hallAmount + additionalHourAmount + foodAmount + foodAdjustmentAmount).toFixed(2);
  const discountAmount = +((subtotalAmount * discountPercentage) / 100).toFixed(2);

  let gstPercentage = 0;
  let gstAmount = 0;
  if (hallGstApplicable || foodGstApplicable) {
    gstPercentage = await resolveGstRate("Standard Rated", eventDate);
    const hallTaxable = hallGstApplicable ? hallAmount + additionalHourAmount : 0;
    const foodTaxable = foodGstApplicable ? foodAmount + foodAdjustmentAmount : 0;
    gstAmount = +(((hallTaxable + foodTaxable) * gstPercentage) / 100).toFixed(2);
  }

  const finalAmount = +(subtotalAmount - discountAmount + gstAmount).toFixed(2);

  return {
    hallPurposeName: hallPurpose.name,
    hall,
    hallPackage,
    halls,
    hallAmount,
    additionalHourAmount,
    depositAmount,
    foodPackage,
    foodAmount,
    foodAdjustmentAmount,
    foodMenuSnapshot,
    additionalFoodItems,
    additionalServicesSnapshot,
    subtotalAmount,
    discountAmount,
    gstPercentage,
    gstAmount,
    finalAmount,
  };
}

function toMinutesDiff(startTime, endTime) {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

// ─── customers ──────────────────────────────────────────────────────────────

async function searchCustomers(req, res) {
  try {
    const { error, value } = customerSearchSchema.validate(req.query);
    if (error) throw error.details[0].message;

    const regex = searchRegex(value.query);
    const customers = await Customer.find(
      Customer.notDeletedFilter({ status: 1, $or: [{ name: regex }, { email: regex }, { mobileNumber: regex }] })
    )
      .select("customerCode name email mobileNumber")
      .sort({ name: 1 })
      .limit(10);

    return responseHandler({ res, response: { items: customers } });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

async function createWalkInCustomer(req, res) {
  try {
    const { error, value } = createCustomerSchema.validate(req.body);
    if (error) throw error.details[0].message;
    const { name, email, mobileNumber } = value;

    if (await Customer.exists(Customer.notDeletedFilter({ email }))) throw "A devotee profile already uses this email.";
    if (mobileNumber && (await Customer.exists(Customer.notDeletedFilter({ mobileNumber })))) {
      throw "A devotee profile already uses this mobile number.";
    }

    const entityId = req.auth?.entityId || (await Entity.findOne(Entity.notDeletedFilter({ code: env.DEFAULT_ENTITY_CODE })))?._id;
    if (!entityId) throw "No temple entity is configured.";

    const customer = await createCustomerProfile({ entityId, name, email, mobileNumber, isRegistered: false });
    return responseHandler({ res, response: customer, successMessage: "Customer created successfully.", statusCode: 201 });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 409 : undefined });
  }
}

// ─── pricing preview (no write, no customer/payment required) ────────────────

async function previewBooking(req, res) {
  try {
    const { error, value } = previewBookingSchema.validate(req.body);
    if (error) throw error.details[0].message;

    const amounts = await computeBookingAmounts(value);
    return responseHandler({
      res,
      response: {
        hallAmount: amounts.hallAmount,
        additionalHourAmount: amounts.additionalHourAmount,
        foodAmount: amounts.foodAmount,
        foodAdjustmentAmount: amounts.foodAdjustmentAmount,
        subtotalAmount: amounts.subtotalAmount,
        discountAmount: amounts.discountAmount,
        gstPercentage: amounts.gstPercentage,
        gstAmount: amounts.gstAmount,
        finalAmount: amounts.finalAmount,
        depositAmount: amounts.depositAmount,
      },
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 422 : undefined });
  }
}

// ─── list / detail ────────────────────────────────────────────────────────────

async function listHallBookings(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    const filter = HallBooking.notDeletedFilter();

    if (req.query.bookingStatus) filter.bookingStatus = req.query.bookingStatus;
    if (req.query.paymentStatus) filter.paymentStatus = req.query.paymentStatus;
    if (req.query.hall) filter.halls = req.query.hall;
    if (req.query.hallPackage) filter.hallPackage = req.query.hallPackage;
    if (req.query.eventDateFrom || req.query.eventDateTo) {
      filter.eventDate = {};
      if (req.query.eventDateFrom) filter.eventDate.$gte = new Date(req.query.eventDateFrom);
      if (req.query.eventDateTo) filter.eventDate.$lte = new Date(req.query.eventDateTo);
    }
    if (req.query.search) {
      const regex = searchRegex(req.query.search);
      filter.$or = [{ bookingNumber: regex }, { "customerInfo.name": regex }];
    }

    const [items, total] = await Promise.all([
      HallBooking.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize),
      HallBooking.countDocuments(filter),
    ]);

    const withPaid = await Promise.all(
      items.map(async (doc) => {
        const amountPaid = await sumPaidAmount(doc._id);
        const obj = doc.toObject();
        obj.amountPaid = amountPaid;
        obj.balanceAmount = +(doc.finalAmount - amountPaid).toFixed(2);
        return obj;
      })
    );

    return responseHandler({ res, response: { items: withPaid, total, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

async function getHallBooking(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw "Invalid booking ID.";
    const booking = await HallBooking.findOne(HallBooking.notDeletedFilter({ _id: req.params.id }))
      .populate("hall", "name code")
      .populate("hallPackage", "name")
      .populate("halls", "name code")
      .populate("hallPurpose", "name")
      .populate("foodPackage", "name");
    if (!booking) throw "Booking not found.";

    const payments = await HallBookingPayment.find(HallBookingPayment.notDeletedFilter({ booking: booking._id })).sort({ createdAt: 1 });
    const amountPaid = +payments.reduce((sum, p) => sum + p.amount, 0).toFixed(2);

    return responseHandler({
      res,
      response: { booking, payments, amountPaid, balanceAmount: +(booking.finalAmount - amountPaid).toFixed(2) },
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 404 : undefined });
  }
}

// ─── create (confirm) ─────────────────────────────────────────────────────────

async function createHallBooking(req, res) {
  try {
    const { error, value } = createBookingSchema.validate(req.body);
    if (error) throw error.details[0].message;

    const customer = await Customer.findOne(Customer.notDeletedFilter({ _id: value.customerId, status: 1 }));
    if (!customer) throw "Customer not found or inactive.";

    const amounts = await computeBookingAmounts(value);

    // Final availability validation, immediately before writing — if
    // someone else booked the Hall in the meantime, this booking is
    // refused rather than silently double-booking it.
    const availability = await checkHallAvailability({
      hallIds: amounts.halls,
      eventDate: value.eventDate,
      startTime: value.startTime,
      endTime: value.endTime,
    });
    if (!availability.available) {
      return exceptionHandler({
        res,
        statusCode: 409,
        error: `This Hall is no longer available for the selected date and time. Please select a different Hall or time.${describeConflicts(availability.conflicts)}`,
      });
    }

    let paymentModeName = null;
    if (value.paymentAmount > 0) {
      const mode = await PaymentMode.findOne(PaymentMode.notDeletedFilter({ _id: value.paymentModeId, status: 1 })).select("name");
      if (!mode) throw "Payment mode not found or inactive.";
      paymentModeName = mode.name;
      if (paymentModeName === "Other" && !value.paymentRemarks) throw "Remarks are required when Payment Mode is Other.";
      if (value.paymentAmount > amounts.finalAmount + 0.005) throw "Payment amount cannot exceed the Final Booking Amount.";
    }

    const bookingNumber = await generateHallBookingNumber();
    const now = new Date();

    const booking = await HallBooking.create({
      bookingNumber,
      customer: customer._id,
      bookingType: value.bookingType,
      hall: amounts.hall?._id ?? null,
      hallName: amounts.hall?.name ?? null,
      hallPackage: amounts.hallPackage?._id ?? null,
      hallPackageName: amounts.hallPackage?.name ?? null,
      halls: amounts.halls,
      hallPurpose: value.hallPurposeId,
      hallPurposeName: amounts.hallPurposeName,
      eventDate: value.eventDate,
      startTime: value.startTime,
      endTime: value.endTime,
      foodRequired: value.foodRequired,
      foodPackage: amounts.foodPackage?._id ?? null,
      foodPackageName: amounts.foodPackage?.name ?? null,
      paxCount: value.paxCount ?? null,
      foodMenuSnapshot: amounts.foodMenuSnapshot,
      additionalFoodItems: amounts.additionalFoodItems,
      additionalServices: amounts.additionalServicesSnapshot,
      remarks: value.remarks,
      discountPercentage: value.discountPercentage,
      membershipNumber: value.membershipNumber || "",
      memberName: value.memberName || "",
      hallAmount: amounts.hallAmount,
      foodAmount: amounts.foodAmount,
      foodAdjustmentAmount: amounts.foodAdjustmentAmount,
      additionalHourAmount: amounts.additionalHourAmount,
      subtotalAmount: amounts.subtotalAmount,
      discountAmount: amounts.discountAmount,
      gstPercentage: amounts.gstPercentage,
      gstAmount: amounts.gstAmount,
      finalAmount: amounts.finalAmount,
      depositAmount: amounts.depositAmount,
      advanceAmount: value.paymentType === "advance" ? value.paymentAmount : 0,
      bookingStatus: "confirmed",
      paymentStatus: "unpaid",
      bookedBy: req.auth?.userId || null,
      bookedAt: now,
    });

    if (value.paymentAmount > 0) {
      const receiptNo = await generateHallReceiptNumber();
      await HallBookingPayment.create({
        receiptNo,
        booking: booking._id,
        customer: customer._id,
        paymentType: value.paymentType,
        amount: value.paymentAmount,
        paymentMode: value.paymentModeId,
        paymentModeName,
        paymentSubtype: value.paymentSubtype,
        referenceNo: value.referenceNo,
        remarks: value.paymentRemarks,
        paymentDate: now,
        collectedBy: req.auth?.userId || null,
      });
      booking.paymentStatus = derivePaymentStatus(value.paymentAmount, amounts.finalAmount);
      await booking.save();
    }

    return responseHandler({ res, response: booking, successMessage: "Hall Booking confirmed successfully.", statusCode: 201 });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 422 : undefined });
  }
}

router.get("/hall-bookings/customers/search", requirePermission("hall-bookings", "view"), searchCustomers);
router.post("/hall-bookings/customers", requirePermission("hall-bookings", "fullAccess"), createWalkInCustomer);
router.get("/hall-bookings", requirePermission("hall-bookings", "view"), listHallBookings);
router.get("/hall-bookings/:id", requirePermission("hall-bookings", "view"), getHallBooking);
router.post("/hall-bookings/preview", requirePermission("hall-bookings", "view"), previewBooking);
router.post("/hall-bookings", requirePermission("hall-bookings", "fullAccess"), createHallBooking);

module.exports = router;
module.exports.computeBookingAmounts = computeBookingAmounts;
module.exports.sumPaidAmount = sumPaidAmount;
module.exports.derivePaymentStatus = derivePaymentStatus;
module.exports.generateHallReceiptNumber = generateHallReceiptNumber;
module.exports.describeConflicts = describeConflicts;
