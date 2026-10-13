/**
 * POS / Admin Booking controller
 * Mounted at /pos — see routes/index.js.
 *
 * The same handler set is registered on two route trees, one per calling
 * surface, so the portal stamp on every Order/Booking/Transaction can be
 * derived server-side from the route rather than trusted from the client
 * body (see setPortal()/registerBookingRoutes() near the bottom):
 *
 *   /pos/booking/*        — POS Portal counter terminal → portal: "pos"
 *   /pos/admin/booking/*  — Admin Panel booking screen  → portal: "admin"
 *
 * Endpoints (identical shape under either prefix above):
 *
 *   GET  /customers/search?query=          — quick customer lookup
 *   GET  /customers/lookup?mobileNumber=   — exact match on an unregistered walk-in, for Create Customer auto-fill
 *   GET  /customers/self                   — find-or-create the logged-in staff member's own customer profile
 *   POST /customers                        — create a walk-in devotee profile (isRegistered: false)
 *   PATCH /customers/:id/family-members    — append newly-typed devotees onto a customer's own profile
 *   GET  /customers/:id/recent-bookings    — last N confirmed bookings, for "repeat a past booking"
 *   GET  /items?search=&category=&subCategory=&favorite=    — POS item picker
 *   GET  /services?search=&category=&subCategory=&favorite= — POS service picker
 *        (favorite=true powers the POS Portal's static "Favorites" tab —
 *        a flat, cross-category pick list, same shape as a search result)
 *   GET  /events                           — live + upcoming events (POS Portal "Events" tab, display only)
 *   GET  /catalogue                        — category tabs + sub-category folders
 *   GET  /deities                          — active deity roster
 *   GET  /nakshathirams                    — active nakshathiram roster
 *   GET  /payment-modes                    — active payment modes
 *   POST /summary                          — price + availability calc (no writes)
 *   POST /recheck-lines                    — re-validate past lines against the live catalogue
 *   POST /orders                           — create order + reserve inventory
 *   POST /orders/:id/confirm               — confirm order → Booking + Transaction + stock-out
 *   GET  /bookings?search=&status=&portal=&paymentStatus= — POS Transactions ledger
 *   GET  /bookings/:id                     — full booking + payment history
 *   POST /bookings/:id/payments            — collect another installment against
 *                                             a partially-paid booking
 *
 * Partial payment: POST /orders and POST /orders/:id/confirm both take an
 * optional `paidAmount` — omit it to pay in full (unchanged default
 * behaviour), or send any amount from 0 up to the priced grandTotal to
 * confirm the booking with only part of it collected. The booking itself is
 * still written and inventory still committed either way; only its
 * paymentStatus ("paid" | "partial" | "pending") and the Transaction amount
 * differ. The remaining balance is then collected — once or over several
 * more visits — via POST /bookings/:id/payments, which keeps appending
 * Transaction rows against the same bookingId until amountPaid reaches
 * grandTotal. See writeBookingFromOrder()'s and recordBookingPayment()'s own
 * comments for the mechanics.
 *
 * Inventory reservation lifecycle: see inventory-reservation.js.
 */

const express = require("express");
const authGuard = require("../../common/middleware/auth-guard");
const adminOnly = require("../../common/middleware/admin-only");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { USER_TYPES } = require("../../utilities/constants/user-types");
const { resolveGstRate, extractGstForLines } = require("../../common/utils/gst-rate");
const { sortLineDeities } = require("../../common/utils/sort-line-deities");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");
const { nextSequence } = require("../../common/utils/sequence");
const escapeRegex = require("../../common/utils/escape-regex");
const env = require("../../config/env");
const createCustomerProfile = require("../../utilities/helpers/create-customer-profile");
const ensureCustomerProfileForUser = require("../../utilities/helpers/ensure-customer-profile-for-user");

const Item = require("../../models/items");
const Service = require("../../models/services");
const GeneralItem = require("../../models/general-items");
const Event = require("../../models/events");
const Deity = require("../../models/deities");
const Nakshathiram = require("../../models/nakshathirams");
const Entity = require("../../models/entities");
const { Customer } = require("../../models/customers");
const PaymentMode = require("../../models/payment-modes");
const { Order } = require("../../models/orders");
const { Booking, BOOKING_STATUSES } = require("../../models/bookings");
const { Transaction } = require("../../models/transactions");
const { PosBooking } = require("../../models/pos-bookings");
const { resolveEventLine } = require("../../common/utils/event-line");
const { slotHasStarted } = require("../../common/utils/event-seats");
const { holdSeats, refreshHolds, releaseHoldRoute, releaseOrphanHolds } = require("./event-holds");
const PrintSplitSetting = require("../../models/print-split-settings");
const findActiveEntityById = require("../../utilities/helpers/find-active-entity-by-id");
const { enrichBookingDevoteesForPrint } = require("../../common/utils/enrich-devotees-for-print");
const { resolveLineUnits, buildTicketGroups } = require("../../common/utils/ticket-grouping");

const {
  placeReservationsForOrder,
  consumeReservations,
  cancelReservations,
  getAvailability,
  getAvailabilityBatch,
} = require("./inventory-reservation");

const {
  summarySchema,
  createOrderSchema,
  confirmOrderSchema,
  customerSearchSchema,
  createCustomerSchema,
  addFamilyMembersSchema,
  recheckLinesSchema,
  recordPaymentSchema,
  holdSeatsSchema,
  refreshHoldsSchema,
  releaseOrphanHoldsSchema,
} = require("./request-objects");

const mongoose = require("mongoose");
const { ticketImageUrl } = require("../../common/utils/ticket-image");
const { makeReprintHandler, ticketReprintCounts } = require("../../common/utils/booking-reprint");

// ─── helpers ──────────────────────────────────────────────────────────────────

function searchRegex(term) {
  return new RegExp(escapeRegex(term.trim()), "i");
}

// Shared with controllers/pos-orders — see common/utils/effective-quantity
// for the full rationale. Re-exported below (module.exports.effectiveQuantity)
// so existing test imports of this module keep working unchanged.
const { effectiveQuantity } = require("../../common/utils/effective-quantity");
const {
  POS_VISIBLE,
  loadPosVisibleHierarchy,
  loadHierarchyForPortal,
  posHierarchyClause,
  offeringInPosHierarchy,
} = require("../../common/utils/pos-catalogue-visibility");

/**
 * Generate the next sequential order number: POS-YYYYMMDD-NNNN
 * Uses the shared atomic sequence counter.
 */
async function generateOrderNumber() {
  const n = await nextSequence("pos_order");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `POS${today}${String(n).padStart(4, "0")}`;
}

/**
 * Generate the next booking number: BKG-YYYYMMDD-NNNN
 */
async function generateBookingNumber() {
  const n = await nextSequence("booking");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `BKG${today}${String(n).padStart(4, "0")}`;
}

/**
 * Generate the next receipt number: RCP-YYYYMMDD-NNNN
 * Uses its own sequence counter, distinct from the booking number's — a
 * receipt is the Transaction's identity, not the Booking's.
 */
async function generateReceiptNumber() {
  const n = await nextSequence("receipt");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `RCP-${today}-${String(n).padStart(4, "0")}`;
}

/**
 * A booking's amountPaid is never stored on the Booking itself — it's always
 * the sum of its "paid" Transaction rows, so there's exactly one source of
 * truth for how much has actually been collected (see models/transactions'
 * own comment). Small change from floating-point cents drift is swallowed by
 * rounding to 2dp everywhere this is used.
 */
function sumPaidAmount(transactions) {
  return +transactions
    .filter((t) => t.paymentStatus === "paid")
    .reduce((sum, t) => sum + t.amount, 0)
    .toFixed(2);
}

/**
 * "paid" once amountPaid has reached grandTotal (a fraction of a cent short
 * still counts, to absorb floating-point rounding), "partial" once something
 * but not everything has been collected, "pending" if nothing has.
 */
function derivePaymentStatus(amountPaid, grandTotal) {
  if (amountPaid >= grandTotal - 0.005) return "paid";
  if (amountPaid > 0) return "partial";
  return "pending";
}

// ─── customer lookup ──────────────────────────────────────────────────────────

/**
 * GET /pos/booking/customers/search?query=
 * Search customers by mobile, email, or name for the Personal Details step.
 * Returns up to 10 matches.
 */
async function searchCustomers(req, res) {
  try {
    const { error, value } = customerSearchSchema.validate(req.query);
    if (error) throw error.details[0].message;

    const { query } = value;
    const regex = searchRegex(query);

    const customers = await Customer.find(
      Customer.notDeletedFilter({
        status: 1,
        $or: [{ name: regex }, { email: regex }, { mobileNumber: regex }],
      })
    )
      .select("customerCode name email mobileNumber familyMembers maxFamilyMembers")
      .populate({ path: "familyMembers.natchathiram", select: "name tamilName" })
      .sort({ name: 1 })
      .limit(10);

    return responseHandler({ res, response: { items: customers } });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * GET /pos/booking/customers/self
 * Find-or-create the Customer profile linked to the logged-in staff user
 * (via Customer.linkedUserId, same idempotent helper used at registration
 * and admin user create/update) — lets a booking go through under the
 * staff member's own name when nobody at the counter picked or created a
 * separate customer for it.
 */
async function getSelfCustomer(req, res) {
  try {
    const found = await ensureCustomerProfileForUser(req.auth.user, req.auth.entityId);
    // Same shape the customer search returns, family members included: the booking's devotee
    // name suggestions are built from them, and this profile is what gets picked whenever
    // nobody was selected before an offering was added.
    const customer = await Customer.findById(found._id)
      .select("customerCode name email mobileNumber familyMembers maxFamilyMembers")
      .populate({ path: "familyMembers.natchathiram", select: "name tamilName" });
    return responseHandler({ res, response: customer });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * POST /pos/booking/customers
 * Creates a walk-in devotee profile at the counter — no login attached.
 * The admin-side Customer master deliberately has no create endpoint (see
 * controllers/customers's own comment): every other path into the Customer
 * collection carries context this doesn't need. A POS walk-in is exactly
 * the case that comment named as the reason this would eventually exist.
 */
async function createWalkInCustomer(req, res) {
  try {
    const { error, value } = createCustomerSchema.validate(req.body);
    if (error) throw error.details[0].message;

    const { name, email, mobileNumber } = value;

    const emailTaken = await Customer.exists(Customer.notDeletedFilter({ email }));
    if (emailTaken) throw "A devotee profile already uses this email.";
    if (mobileNumber) {
      const mobileTaken = await Customer.exists(Customer.notDeletedFilter({ mobileNumber }));
      if (mobileTaken) throw "A devotee profile already uses this mobile number.";
    }

    const entityId = req.auth?.entityId || (await Entity.findOne(Entity.notDeletedFilter({ code: env.DEFAULT_ENTITY_CODE })))?._id;
    if (!entityId) throw "No temple entity is configured.";

    const customer = await createCustomerProfile({
      entityId,
      name,
      email,
      mobileNumber: mobileNumber || null,
      // A walk-in starts unregistered — see models/customers' own comment.
      // A repeat visit on the same mobile is matched and reused (GET
      // .../customers/lookup) rather than hitting the mobile-uniqueness
      // error below a second time.
      isRegistered: false,
    });
    customer.createdBy = req.auth?.userId || null;
    await customer.save();

    return responseHandler({ res, response: customer, successMessage: "Devotee profile created.", statusCode: 201 });
  } catch (error) {
    if (error?.code === 11000) {
      return exceptionHandler({ res, error: "Those details are already used by another profile.", statusCode: 409 });
    }
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * PATCH /pos/booking/customers/:id/family-members
 * Called as a fire-and-forget side effect when the counter types a devotee
 * name during "Add to Cart" that isn't already one of this customer's known
 * family members — the booking itself never depends on this succeeding, so
 * a failure here is reported but doesn't touch the cart.
 *
 * Deliberately additive, not a replace: unlike the admin Customer master's
 * `PUT /customers/:id` (which lets staff overwrite the whole list, including
 * removals), this only ever appends. It skips anything that already matches
 * an existing member by name (case-insensitive, English or Tamil) so
 * re-booking a known devotee never creates a duplicate, and silently caps at
 * `maxFamilyMembers` (dropping the overflow rather than failing the request)
 * since the cashier has no way to resolve that conflict mid-checkout.
 */
async function addFamilyMembers(req, res) {
  try {
    const customer = await Customer.findOne(Customer.notDeletedFilter({ _id: req.params.id }));
    if (!customer) return exceptionHandler({ res, error: "Devotee profile not found.", statusCode: 404 });

    const known = new Set();
    customer.familyMembers.forEach((m) => {
      if (m.nameEnglish) known.add(m.nameEnglish.trim().toLowerCase());
      if (m.nameTamil) known.add(m.nameTamil.trim().toLowerCase());
    });

    const room = Math.max(0, customer.maxFamilyMembers - customer.familyMembers.length);
    const toAdd = [];
    for (const m of req.body.familyMembers) {
      if (toAdd.length >= room) break;
      // A blank key (a Tamil-only or English-only entry) must never be added
      // to `known` — every subsequent entry missing that same side would
      // otherwise match on "" and be wrongly treated as a duplicate.
      const englishKey = m.nameEnglish ? m.nameEnglish.trim().toLowerCase() : "";
      const tamilKey = m.nameTamil ? m.nameTamil.trim().toLowerCase() : "";
      if ((englishKey && known.has(englishKey)) || (tamilKey && known.has(tamilKey))) continue;
      toAdd.push({ nameEnglish: m.nameEnglish || "", nameTamil: m.nameTamil || "", natchathiram: m.natchathiram || null });
      if (englishKey) known.add(englishKey);
      if (tamilKey) known.add(tamilKey);
    }

    if (toAdd.length > 0) {
      customer.familyMembers.push(...toAdd);
      customer.updatedBy = req.auth?.userId || null;
      await customer.save();
    }
    await customer.populate({ path: "familyMembers.natchathiram", select: "name tamilName" });

    return responseHandler({ res, response: { addedCount: toAdd.length, familyMembers: customer.familyMembers } });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * GET /pos/booking/customers/lookup?mobileNumber=
 * Exact-match lookup for the Create Customer form's auto-fill — as the
 * counter types a mobile number, this finds a matching *unregistered*
 * walk-in profile so a repeat visit reuses it instead of hitting the
 * mobile-uniqueness error on a second POST. Scoped to isRegistered: false
 * on purpose: a real registration is never silently pulled into the walk-in
 * create form this way — reusing one of those goes through customer search.
 */
async function lookupCustomerByMobile(req, res) {
  try {
    const mobileNumber = (req.query.mobileNumber || "").trim();
    if (!mobileNumber) return responseHandler({ res, response: null });

    const customer = await Customer.findOne(
      Customer.notDeletedFilter({ mobileNumber, status: 1, isRegistered: false })
    ).select("customerCode name email mobileNumber");

    return responseHandler({ res, response: customer });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * GET /pos/booking/customers/:id/recent-bookings?limit=3
 * The counter's "repeat a past booking" feature — last N confirmed
 * bookings for a customer, with full line detail so the frontend can offer
 * to re-add them to the cart (after re-checking live availability via
 * recheckLines(), since the catalogue may have moved on since then), and so
 * the devotee-suggestion chips in the booking form can offer "who this
 * customer usually books for".
 *
 * Shared by both the POS Portal and Admin Booking trees (registered once
 * via registerCatalogueRoutes), and reads BOTH booking collections —
 * models/bookings (legacy `bookings`, still written by Admin Booking) AND
 * models/pos-bookings (`pos_bookings`, written by the POS Portal since its
 * order/booking/payment writes moved off the shared collections onto their
 * own — see controllers/pos-orders). A customer's history can legitimately
 * span both depending on which counter booked them; querying only one (the
 * bug this fixed) silently hid the other's devotees — most visibly for a
 * staff member's own linked "self" customer, whose bookings are almost
 * always POS Portal ones and so had ZERO rows in the legacy collection this
 * used to query exclusively.
 *
 * Default (no `limit`) is 3 — the counter's "last 3" preview. The POS
 * Portal's "Load more" button re-requests this with a large limit (200) to
 * stand in for "every booking this customer has" without an unbounded query
 * — no real customer's confirmed-booking count is expected to approach that.
 */
async function getRecentBookings(req, res) {
  try {
    const customerId = req.params.id;
    if (!mongoose.isValidObjectId(customerId)) throw "Invalid customer ID.";
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 3));

    const [legacyBookings, posBookings] = await Promise.all([
      Booking.find(Booking.notDeletedFilter({ customer: customerId, bookingStatus: "confirmed" }))
        .select("bookingNumber orderId lines grandTotal bookedAt")
        .populate("orderId", "orderNumber")
        .populate("lines.deities", "name")
        .sort({ bookedAt: -1 })
        .limit(limit),
      PosBooking.find(PosBooking.notDeletedFilter({ customer: customerId, bookingStatus: "confirmed" }))
        .select("bookingNumber orderId lines grandTotal bookedAt")
        .populate("orderId", "orderNumber")
        .populate("lines.deities", "name")
        .sort({ bookedAt: -1 })
        .limit(limit),
    ]);

    const items = [...legacyBookings, ...posBookings]
      .sort((a, b) => new Date(b.bookedAt) - new Date(a.bookedAt))
      .slice(0, limit)
      .map((b) => ({
        _id: b._id,
        bookingNumber: b.bookingNumber,
        orderNumber: b.orderId?.orderNumber ?? null,
        lines: b.lines,
        grandTotal: b.grandTotal,
        bookedAt: b.bookedAt,
      }));

    return responseHandler({ res, response: { items } });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

// ─── item / service catalogue for POS picker ─────────────────────────────────

/**
 * GET /pos/booking/items?search=&category=&page=&pageSize=
 * Returns active items with posAvailability = true.
 */
async function listPosItems(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 50);

    // Admin Booking Panel and POS Portal counter each have their own
    // visibility gate — adminBookingVisibility vs posAvailability — driven
    // by which route tree this request came in on (see setPortal()).
    const isAdmin = req.posPortal === "admin";
    const visField = isAdmin ? "adminBookingVisibility" : "posAvailability";
    const categoryVisField = isAdmin ? "adminBookingVisibility" : "posVisibility";
    const { categoryIds, subCategoryIds } = await loadHierarchyForPortal(req.posPortal);

    const and = [posHierarchyClause(categoryIds, subCategoryIds)];
    const filter = Item.notDeletedFilter({ status: 1, [visField]: true });
    if (req.query.search) {
      const regex = searchRegex(req.query.search);
      and.push({ $or: [{ name: regex }, { code: regex }] });
    }
    if (req.query.category) {
      if (!categoryIds.some((id) => String(id) === String(req.query.category))) {
        return responseHandler({ res, response: { items: [], total: 0, page, pageSize } });
      }
      filter["categoryDetails.category"] = req.query.category;
    }
    if (req.query.subCategory) {
      if (!subCategoryIds.some((id) => String(id) === String(req.query.subCategory))) {
        return responseHandler({ res, response: { items: [], total: 0, page, pageSize } });
      }
      filter["categoryDetails.subCategory"] = req.query.subCategory;
    }
    // Powers the POS Portal's static "Favorites" tab — a flat, cross-
    // category pick list of every favourite-flagged item, same shape as the
    // search results view (see favorite=true on listPosServices too).
    if (req.query.favorite === "true") {
      filter.favorite = true;
    }
    filter.$and = and;

    const [items, total] = await Promise.all([
      Item.find(filter)
        .populate({ path: "categoryDetails.category", select: "name color", match: { isDeleted: false, status: 1, [categoryVisField]: POS_VISIBLE } })
        .populate({ path: "categoryDetails.subCategory", select: "name", match: { isDeleted: false, status: 1, [categoryVisField]: POS_VISIBLE } })
        .populate("generalLedger", "gstType")
        // Sorted by admin-assigned display order (ties alphabetical) so the
        // POS cart's Deities multi-select shows them in the configured
        // order, not insertion order — see models/deities' displayOrder.
        .populate({ path: "deityMapping", select: "name color", options: { sort: { displayOrder: 1, name: 1 } } })
        .select("name tamilName code salePrice isInventoryApplicable currentStock threshold isDeityMappingRequired deityMapping isFamilyMembersRequired maxFamilyMembers minQuantity maxQuantity categoryDetails image color favorite")
        .sort({ name: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      Item.countDocuments(filter),
    ]);

    const itemsWithAvailability = await decorateItems(items);

    return responseHandler({ res, response: { items: itemsWithAvailability, total, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * GET /pos/booking/services?search=&category=&page=&pageSize=
 * Returns active services with isPosAvailable = true.
 */
async function listPosServices(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 50);

    const isAdmin = req.posPortal === "admin";
    const visField = isAdmin ? "adminBookingVisibility" : "isPosAvailable";
    const categoryVisField = isAdmin ? "adminBookingVisibility" : "posVisibility";
    const { categoryIds, subCategoryIds } = await loadHierarchyForPortal(req.posPortal);

    const and = [posHierarchyClause(categoryIds, subCategoryIds)];
    const filter = Service.notDeletedFilter({ status: 1, [visField]: true });
    if (req.query.search) {
      const regex = searchRegex(req.query.search);
      and.push({ $or: [{ name: regex }, { code: regex }] });
    }
    if (req.query.category) {
      if (!categoryIds.some((id) => String(id) === String(req.query.category))) {
        return responseHandler({ res, response: { items: [], total: 0, page, pageSize } });
      }
      filter["categoryDetails.category"] = req.query.category;
    }
    if (req.query.subCategory) {
      if (!subCategoryIds.some((id) => String(id) === String(req.query.subCategory))) {
        return responseHandler({ res, response: { items: [], total: 0, page, pageSize } });
      }
      filter["categoryDetails.subCategory"] = req.query.subCategory;
    }
    // Powers the POS Portal's static "Favorites" tab — see the matching
    // comment on listPosItems above.
    if (req.query.favorite === "true") {
      filter.favorite = true;
    }
    filter.$and = and;

    const [services, total] = await Promise.all([
      Service.find(filter)
        .populate({ path: "categoryDetails.category", select: "name color", match: { isDeleted: false, status: 1, [categoryVisField]: POS_VISIBLE } })
        .populate({ path: "categoryDetails.subCategory", select: "name", match: { isDeleted: false, status: 1, [categoryVisField]: POS_VISIBLE } })
        // Sorted by admin-assigned display order (ties alphabetical) so the
        // POS cart's Deities multi-select shows them in the configured
        // order, not insertion order — see models/deities' displayOrder.
        .populate({ path: "deityMapping", select: "name color", options: { sort: { displayOrder: 1, name: 1 } } })
        .select("name tamilName code salePrice categoryDetails isInventoryRequired currentStock thresholdCount isDeityMappingRequired deityMapping isFamilyMembersRequired maxFamilyMembers image color favorite")
        .sort({ name: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      Service.countDocuments(filter),
    ]);

    const servicesWithAvailability = await decorateServices(services);

    return responseHandler({ res, response: { items: servicesWithAvailability, total, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * GET /(booking|admin/booking)/events
 * Events that are on or still to come, for the POS Portal's "Events" tab. An
 * event is live while it is Active and its last date has not passed - an
 * event that finished yesterday drops off by itself, and one starting next
 * month shows as upcoming. Display only: events are not sold through the
 * cart yet, so this returns what the card needs (dates, description, slot
 * availability) and nothing price-calculation related.
 *
 * "Today" is the temple's own calendar day (Singapore), not the server's,
 * since event dates are stored as plain calendar dates.
 */
async function listPosEvents(req, res) {
  try {
    const isAdmin = req.posPortal === "admin";
    const sgToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const todayStart = new Date(`${sgToday}T00:00:00.000Z`);

    const filter = Event.notDeletedFilter({ status: 1, endDate: { $gte: todayStart } });
    if (isAdmin) filter.adminBookingVisibility = { $ne: false };
    else filter.posVisibility = true;

    const events = await Event.find(filter)
      .populate({ path: "category", select: "name color" })
      .populate({ path: "deityMapping", select: "name tamilName image color", options: { sort: { displayOrder: 1, name: 1 } } })
      .select(
        "name tamilName code description image sliderImage category deityMapping dateType eventDates startDate endDate salePrice isSlotRequired slotDetails isFamilyMembersRequired maxFamilyMembers termsAndConditions"
      )
      .sort({ startDate: 1, displayOrder: 1, name: 1 })
      .lean();

    // Only slots that have not started yet: active, and their Singapore start time still ahead.
    // An event that needs a slot and has none left (all started or over) is not offered at all.
    const items = events
      .map((e) => ({
        ...e,
        slotDetails: (e.slotDetails || [])
          .filter((slot) => slot.status === 1 && !slotHasStarted(slot))
          .sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.startTime).localeCompare(String(b.startTime))),
      }))
      .filter((e) => !e.isSlotRequired || e.slotDetails.length > 0);

    return responseHandler({ res, response: { items, total: items.length } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * GET /(booking|admin/booking)/general-items?search=&category=&page=&pageSize=
 * General Items carry no salePrice — the amount is typed in by the cashier
 * at the point of sale (see cartLineSchema's manualUnitPrice). Shown as its
 * own separate browsing tab/picker, never folded into getCatalogue()'s
 * Item/Service folder browser — see the General Item plan's rationale.
 */
async function listGeneralItems(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 50);

    const isAdmin = req.posPortal === "admin";
    const visField = isAdmin ? "adminBookingVisibility" : "posAvailability";
    const categoryVisField = isAdmin ? "adminBookingVisibility" : "posVisibility";
    const { categoryIds, subCategoryIds } = await loadHierarchyForPortal(req.posPortal);

    const and = [posHierarchyClause(categoryIds, subCategoryIds)];
    const filter = GeneralItem.notDeletedFilter({ status: 1, [visField]: true });
    if (req.query.search) {
      const regex = searchRegex(req.query.search);
      and.push({ $or: [{ name: regex }, { code: regex }] });
    }
    if (req.query.category) {
      if (!categoryIds.some((id) => String(id) === String(req.query.category))) {
        return responseHandler({ res, response: { items: [], total: 0, page, pageSize } });
      }
      filter["categoryDetails.category"] = req.query.category;
    }
    if (req.query.subCategory) {
      if (!subCategoryIds.some((id) => String(id) === String(req.query.subCategory))) {
        return responseHandler({ res, response: { items: [], total: 0, page, pageSize } });
      }
      filter["categoryDetails.subCategory"] = req.query.subCategory;
    }
    if (req.query.favorite === "true") {
      filter.favorite = true;
    }
    filter.$and = and;

    const [generalItems, total] = await Promise.all([
      GeneralItem.find(filter)
        .populate({ path: "categoryDetails.category", select: "name color", match: { isDeleted: false, status: 1, [categoryVisField]: POS_VISIBLE } })
        .populate({ path: "categoryDetails.subCategory", select: "name", match: { isDeleted: false, status: 1, [categoryVisField]: POS_VISIBLE } })
        .select("name tamilName code isInventoryApplicable currentStock threshold minQuantity maxQuantity categoryDetails image color favorite")
        .sort({ name: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      GeneralItem.countDocuments(filter),
    ]);

    const generalItemsWithAvailability = await decorateGeneralItems(generalItems);

    return responseHandler({ res, response: { items: generalItemsWithAvailability, total, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * Shared shaping for the two catalogue endpoints above and for the
 * "uncategorized" bucket in getCatalogue() below — one definition of what a
 * POS-facing item/service payload looks like, instead of copies that drift.
 */
async function decorateItems(items) {
  // One batched query for the whole page instead of getAvailability()'s two
  // queries per item (see getAvailabilityBatch's own comment) — items[] here
  // already carries currentStock/threshold/isInventoryApplicable from the
  // caller's own .select(), so nothing is re-fetched.
  const availByRefId = await getAvailabilityBatch("Item", items);
  return items.map((item) => ({
    _id: item._id,
    code: item.code,
    name: item.name,
    tamilName: item.tamilName,
    salePrice: item.salePrice,
    image: item.image || null,
    color: item.color || "",
    isDeityMappingRequired: item.isDeityMappingRequired,
    deityMapping: item.deityMapping,
    isFamilyMembersRequired: item.isFamilyMembersRequired,
    maxFamilyMembers: item.maxFamilyMembers,
    minQuantity: item.minQuantity,
    maxQuantity: item.maxQuantity,
    categoryDetails: item.categoryDetails,
    favorite: Boolean(item.favorite),
    inventory: availByRefId.get(String(item._id)),
  }));
}

async function decorateServices(services) {
  const availByRefId = await getAvailabilityBatch("Service", services);
  return services.map((svc) => ({
    _id: svc._id,
    code: svc.code,
    name: svc.name,
    tamilName: svc.tamilName,
    defaultSalePrice: svc.salePrice ?? 0,
    image: svc.image || null,
    color: svc.color || "",
    categoryDetails: svc.categoryDetails,
    isDeityMappingRequired: svc.isDeityMappingRequired,
    deityMapping: svc.deityMapping,
    isFamilyMembersRequired: svc.isFamilyMembersRequired,
    maxFamilyMembers: svc.maxFamilyMembers,
    favorite: Boolean(svc.favorite),
    inventory: availByRefId.get(String(svc._id)),
  }));
}

/**
 * General Items carry no price field — the frontend must never look for a
 * salePrice/defaultSalePrice on these; the cashier types the amount in at
 * add-to-cart time instead (see cartLineSchema's manualUnitPrice).
 */
async function decorateGeneralItems(generalItems) {
  const availByRefId = await getAvailabilityBatch("GeneralItem", generalItems);
  return generalItems.map((gi) => ({
    _id: gi._id,
    code: gi.code,
    name: gi.name,
    tamilName: gi.tamilName,
    image: gi.image || null,
    color: gi.color || "",
    minQuantity: gi.minQuantity,
    maxQuantity: gi.maxQuantity,
    categoryDetails: gi.categoryDetails,
    favorite: Boolean(gi.favorite),
    inventory: availByRefId.get(String(gi._id)),
  }));
}

/**
 * GET /pos/booking/payment-modes
 * Returns every active payment mode available at the Temple POS counter —
 * `posAvailability` is what actually gates this (see models/payment-modes
 * and seed/seedPaymentModes.js): DBS is seeded with posAvailability: false
 * (it's a back-office bank-transfer record, never a counter payment option)
 * and is excluded here for exactly that reason, not hardcoded by name.
 * Cash/PayNow/NETS/Credit Card are all posAvailability: true; the POS
 * counter's own PaymentModeBoxes further decides which of those it can
 * actually process yet (Cash + PayNow live, NETS still "Coming soon").
 *
 * This used to read `publicAvailability` instead — the field meant for a
 * customer-facing checkout, not this counter — which happened to work only
 * because every seeded mode's publicAvailability and posAvailability agree
 * today. `publicAvailability` stays reserved for the Customer Portal's own
 * checkout once that's built (still a placeholder — see app/customer).
 *
 * Deactivating a Payment Mode (status: 0) from the master already removes
 * it here via `notDeletedFilter`/status, same as every other master's POS
 * visibility gate.
 */
async function listPaymentModes(req, res) {
  try {
    // Each portal reads its own flag: the counter posAvailability, the Admin Panel adminBookingVisibility.
    const visibility = req.posPortal === "admin" ? { adminBookingVisibility: { $ne: false } } : { posAvailability: true };
    const modes = await PaymentMode.find(
      PaymentMode.notDeletedFilter({ status: 1, ...visibility })
    )
      .select("name description")
      .sort({ name: 1 });

    return responseHandler({ res, response: { items: modes } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

// ─── catalogue browsing (categories → sub-category folders) ─────────────────

/**
 * GET /pos/booking/catalogue
 *
 * Powers the POS Portal's folder browser. SubCategory carries no parent
 * Category reference at the master level (see models/sub-categories) — the
 * only place a category/subCategory pairing actually exists is on each
 * Item/Service's own `categoryDetails` rows. So "folders" here are derived
 * by scanning the live catalogue rather than read off a fixed hierarchy:
 * every distinct SubCategory present in an active, POS-available Item or
 * Service becomes one folder card — keyed by subCategory alone, not by
 * (category, subCategory), since the same sub-category can be reused
 * across several categories (an Item under "Pooja Items / Daily" and a
 * Service under "Archanai / Daily" land in the same "Daily" folder, not
 * two duplicate ones). `categoryIds` on the folder lists every category
 * its contents actually span, so the frontend can still decide whether a
 * folder belongs in a given category's filtered view.
 *
 * subCategory is optional on a categoryDetails row (a master can be mapped
 * to a Category without a specific SubCategory, or carry no categoryDetails
 * at all). Either way there's no folder to file into, so both go out in the
 * same "uncategorized" arrays, each item/service carrying its own
 * `categoryId` — null for the fully-uncategorized case, the mapped
 * category's id when only the subCategory is missing. The frontend uses
 * that id to decide whether an entry belongs in the unfiltered "All
 * Categories" view only, or also inside a specific category's filtered view.
 */
async function getCatalogue(req, res) {
  try {
    // The two portals see their own visibility flags: the counter reads posAvailability /
    // isPosAvailable, the Admin Booking screen reads adminBookingVisibility - the same rule
    // the item / service / general-item pickers and the order routes already apply.
    const isAdmin = req.posPortal === "admin";
    const itemVis = isAdmin ? { adminBookingVisibility: true } : { posAvailability: true };
    const serviceVis = isAdmin ? { adminBookingVisibility: true } : { isPosAvailable: true };
    const { categories, subCategories, categoryIds, subCategoryIds } = await loadHierarchyForPortal(req.posPortal);
    const visible = posHierarchyClause(categoryIds, subCategoryIds);
    const [items, services, generalItems] = await Promise.all([
      Item.find(Item.notDeletedFilter({ status: 1, ...itemVis, $and: [visible] })).select("categoryDetails"),
      Service.find(Service.notDeletedFilter({ status: 1, ...serviceVis, $and: [visible] })).select("categoryDetails"),
      GeneralItem.find(GeneralItem.notDeletedFilter({ status: 1, ...itemVis, $and: [visible] })).select("categoryDetails"),
    ]);
    const subCategoryById = new Map(subCategories.map((s) => [String(s._id), s]));
    const categoryById = new Map(categories.map((c) => [String(c._id), c]));

    // Keyed by subCategoryId alone, not (categoryId, subCategoryId) — a
    // Sub Category has no parent Category at the master level (see
    // models/sub-categories), so the same sub-category name showing up
    // under two different categories (e.g. an Item filed under "Pooja
    // Items / Daily" and a Service filed under "Archanai / Daily") is one
    // folder, not two duplicate "Daily" cards, with both an item and a
    // service inside it.
    const folderMap = new Map(); // subCategoryId -> folder accumulator
    const categoryItemIds = new Map(); // categoryId -> Set(itemId)
    const categoryServiceIds = new Map(); // categoryId -> Set(serviceId)
    const categoryOnlyItemIds = new Map(); // itemId -> categoryId (subCategory-less row)
    const categoryOnlyServiceIds = new Map(); // serviceId -> categoryId (subCategory-less row)

    function addToFolder(cd, kind, docId) {
      const catId = String(cd.category);

      // A row pointing at a category that's been deactivated or deleted
      // has nowhere valid to be shown — skip it entirely rather than
      // surfacing a "—" placeholder folder/category pill in POS.
      if (!categoryById.has(catId)) return;

      const subId = cd.subCategory ? String(cd.subCategory) : null;
      // Sub-category was deleted or inactivated — do not count this mapping
      // and do not fall back to a loose card (that inflated category pills).
      if (subId && !subCategoryById.has(subId)) return;

      const perCategory = kind === "Item" ? categoryItemIds : categoryServiceIds;
      if (!perCategory.has(catId)) perCategory.set(catId, new Set());
      perCategory.get(catId).add(String(docId));

      if (!subId) {
        const map = kind === "Item" ? categoryOnlyItemIds : categoryOnlyServiceIds;
        if (!map.has(String(docId))) map.set(String(docId), catId);
        return;
      }

      if (!folderMap.has(subId)) {
        folderMap.set(subId, {
          categoryIds: new Set(),
          subCategoryId: subId,
          subCategoryName: subCategoryById.get(subId)?.name ?? "—",
          subCategoryTamilName: subCategoryById.get(subId)?.tamilName || null,
          color: subCategoryById.get(subId)?.color ?? null,
          image: subCategoryById.get(subId)?.image || null,
          displayOrder: subCategoryById.get(subId)?.displayOrder ?? null,
          itemIds: new Set(),
          serviceIds: new Set(),
        });
      }
      const folder = folderMap.get(subId);
      folder.categoryIds.add(catId);
      const bucket = kind === "Item" ? folder.itemIds : folder.serviceIds;
      bucket.add(String(docId));
    }

    const uncategorizedItemIds = [];
    for (const item of items) {
      if (!item.categoryDetails || item.categoryDetails.length === 0) {
        uncategorizedItemIds.push(item._id);
        continue;
      }
      for (const cd of item.categoryDetails) addToFolder(cd, "Item", item._id);
    }

    const uncategorizedServiceIds = [];
    for (const svc of services) {
      if (!svc.categoryDetails || svc.categoryDetails.length === 0) {
        uncategorizedServiceIds.push(svc._id);
        continue;
      }
      for (const cd of svc.categoryDetails) addToFolder(cd, "Service", svc._id);
    }

    const folders = [...folderMap.values()]
      .map((f) => ({
        categoryIds: [...f.categoryIds],
        subCategoryId: f.subCategoryId,
        subCategoryName: f.subCategoryName,
        subCategoryTamilName: f.subCategoryTamilName,
        color: f.color,
        image: f.image || null,
        displayOrder: f.displayOrder,
        itemCount: f.itemIds.size,
        serviceCount: f.serviceIds.size,
        total: f.itemIds.size + f.serviceIds.size,
      }))
      .sort((a, b) => {
        const aOrder = a.displayOrder != null ? a.displayOrder : Infinity;
        const bOrder = b.displayOrder != null ? b.displayOrder : Infinity;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.subCategoryName.localeCompare(b.subCategoryName);
      });

    // General Items are filed under categories too (the POS lists them in their
    // category's tab), so a category that holds ONLY General Items still needs
    // its tab even though it has no folders or loose items/services to count.
    const categoriesWithGeneralItems = new Set();
    for (const gi of generalItems) {
      for (const cd of gi.categoryDetails || []) {
        if (categoryById.has(String(cd.category))) categoriesWithGeneralItems.add(String(cd.category));
      }
    }

    const categoriesOut = categories
      .map((c) => {
        const catId = String(c._id);
        const folderCount = folders.filter((f) => f.categoryIds.includes(catId)).length;
        const looseCount =
          [...categoryOnlyItemIds.values()].filter((id) => id === catId).length +
          [...categoryOnlyServiceIds.values()].filter((id) => id === catId).length;
        return { _id: c._id, name: c.name, color: c.color, image: c.image || null, count: folderCount + looseCount };
      })
      .filter((c) => c.count > 0 || categoriesWithGeneralItems.has(String(c._id)));

    // Both the fully-uncategorized ids and the category-only ids are fetched
    // and decorated together — the only difference the response needs to
    // carry is which categoryId (if any) each one resolves to.
    const allUncategorizedItemIds = [...new Set([...uncategorizedItemIds.map(String), ...categoryOnlyItemIds.keys()])];
    const allUncategorizedServiceIds = [...new Set([...uncategorizedServiceIds.map(String), ...categoryOnlyServiceIds.keys()])];

    const [uncategorizedItemsRaw, uncategorizedServicesRaw] = await Promise.all([
      allUncategorizedItemIds.length
        ? decorateItems(
            await Item.find(Item.notDeletedFilter({ _id: { $in: allUncategorizedItemIds }, status: 1, ...itemVis }))
              // Sorted by admin-assigned display order (ties alphabetical) so the
        // POS cart's Deities multi-select shows them in the configured
        // order, not insertion order — see models/deities' displayOrder.
        .populate({ path: "deityMapping", select: "name color", options: { sort: { displayOrder: 1, name: 1 } } })
              .select(
                "name tamilName code salePrice isInventoryApplicable currentStock threshold isDeityMappingRequired deityMapping isFamilyMembersRequired maxFamilyMembers minQuantity maxQuantity categoryDetails image color"
              )
          )
        : [],
      allUncategorizedServiceIds.length
        ? decorateServices(
            await Service.find(Service.notDeletedFilter({ _id: { $in: allUncategorizedServiceIds }, status: 1, ...serviceVis }))
              // Sorted by admin-assigned display order (ties alphabetical) so the
        // POS cart's Deities multi-select shows them in the configured
        // order, not insertion order — see models/deities' displayOrder.
        .populate({ path: "deityMapping", select: "name color", options: { sort: { displayOrder: 1, name: 1 } } })
              .select(
                "name tamilName code salePrice categoryDetails isInventoryRequired currentStock thresholdCount isDeityMappingRequired deityMapping isFamilyMembersRequired maxFamilyMembers image color"
              )
          )
        : [],
    ]);

    const uncategorizedItems = uncategorizedItemsRaw.map((item) => ({
      ...item,
      categoryId: categoryOnlyItemIds.get(String(item._id)) ?? null,
    }));
    const uncategorizedServices = uncategorizedServicesRaw.map((svc) => ({
      ...svc,
      categoryId: categoryOnlyServiceIds.get(String(svc._id)) ?? null,
    }));

    return responseHandler({
      res,
      response: {
        categories: categoriesOut,
        totalCount: folders.length + uncategorizedItems.length + uncategorizedServices.length,
        folders,
        uncategorizedItems,
        uncategorizedServices,
      },
    });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * GET /pos/booking/deities
 * Full active Deity roster for the "which deity is this offering for" picker.
 * Both Item and Service now carry their own curated `deityMapping` (returned
 * inline on each offering by decorateItems/decorateServices) — the frontend
 * prefers that curated list and falls back to this full roster only when an
 * offering's own mapping is empty.
 */
async function listDeities(req, res) {
  try {
    const deities = await Deity.find(Deity.notDeletedFilter({ status: 1 }))
      .select("name tamilName")
      .sort({ displayOrder: 1, name: 1 });
    return responseHandler({ res, response: { items: deities } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * GET /pos/booking/nakshathirams
 * Active Nakshathiram master, for the devotee-details Nakshatra dropdown —
 * sourced from the real master (Nakshathiram Master) rather than a
 * hardcoded list, and exposed under /pos so POS counter staff don't also
 * need the Nakshathiram master's own view permission.
 */
async function listNakshathirams(req, res) {
  try {
    const rows = await Nakshathiram.find(Nakshathiram.notDeletedFilter({ status: 1 }))
      .select("name tamilName rasi")
      .sort({ displayOrder: 1, name: 1 });
    return responseHandler({ res, response: { items: rows } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

// ─── booking summary (no writes) ─────────────────────────────────────────────

/**
 * POST /pos/booking/summary
 *
 * Accepts the cart lines, validates them, resolves current prices and
 * availability, and returns a full cost breakdown. Does NOT write anything
 * to the database.
 *
 * Used by the frontend "Cart Summary" panel in real time as items are added.
 */
async function bookingSummary(req, res) {
  try {
    const { error, value } = summarySchema.validate(req.body);
    if (error) throw error.details[0].message;

    const { customerId, lines } = value;
    const isAdmin = req.posPortal === "admin";
    const itemVisField = isAdmin ? "adminBookingVisibility" : "posAvailability";
    const svcVisField = isAdmin ? "adminBookingVisibility" : "isPosAvailable";
    const hierarchy = await loadHierarchyForPortal(req.posPortal);

    // Validate customer exists
    const customer = await Customer.findOne(
      Customer.notDeletedFilter({ _id: customerId, status: 1 })
    ).select("customerCode name email mobileNumber");
    if (!customer) throw "Customer not found or inactive.";

    const rawLines = [];

    for (const line of lines) {
      const { refType, refId } = line;
      let { deities, devotees } = line;

      let name, code, unitPrice, gstType, generalLedgerId;
      // Event lines resolve through one shared helper — see common/utils/event-line.js.
      let eventParts = null;

      if (refType === "Event") {
        eventParts = await resolveEventLine(line, { portal: isAdmin ? "admin" : "pos" });
        ({ name, code, unitPrice, gstType, deities, devotees } = eventParts);
        generalLedgerId = eventParts.generalLedgerId;
      } else if (refType === "Item") {
        const item = await Item.findOne(
          Item.notDeletedFilter({ _id: refId, status: 1, [itemVisField]: true })
        ).populate("generalLedger", "gstType");
        if (!item || !offeringInPosHierarchy(item, hierarchy.categoryIds, hierarchy.subCategoryIds)) {
          throw `Item not found or not available.`;
        }

        name = item.name;
        code = item.code;
        unitPrice = item.salePrice;
        gstType = item.generalLedger?.gstType ?? null;
        generalLedgerId = item.generalLedger?._id ?? null;
      } else if (refType === "Service") {
        const svc = await Service.findOne(
          Service.notDeletedFilter({ _id: refId, status: 1, [svcVisField]: true })
        ).populate("generalLedger", "gstType");
        if (!svc || !offeringInPosHierarchy(svc, hierarchy.categoryIds, hierarchy.subCategoryIds)) {
          throw `Service not found or not available.`;
        }

        name = svc.name;
        code = svc.code;
        unitPrice = svc.salePrice ?? 0;
        gstType = svc.generalLedger?.gstType ?? null;
        generalLedgerId = svc.generalLedger?._id ?? null;
      } else {
        const gi = await GeneralItem.findOne(
          GeneralItem.notDeletedFilter({ _id: refId, status: 1, [itemVisField]: true })
        ).populate("generalLedger", "gstType");
        if (!gi || !offeringInPosHierarchy(gi, hierarchy.categoryIds, hierarchy.subCategoryIds)) {
          throw `Product not found or not available.`;
        }

        name = gi.name;
        code = gi.code;
        // General Items carry no master price — the cashier's typed amount
        // is trusted here ONLY because Joi forbids manualUnitPrice for any
        // other refType (see cartLineSchema).
        unitPrice = line.manualUnitPrice;
        gstType = gi.generalLedger?.gstType ?? null;
        generalLedgerId = gi.generalLedger?._id ?? null;
      }

      const gstRate = await resolveGstRate(gstType);

      // Check availability (read-only — no reservation written here)
      // An event's "stock" is the seats left on its chosen slot.
      const avail = eventParts
        ? {
            isInventoryApplicable: eventParts.seatsLeft !== Infinity,
            currentStock: 0,
            reservedQty: 0,
            availableQty: eventParts.seatsLeft,
            threshold: 0,
          }
        : await getAvailability(refType, refId);
      const available = avail.isInventoryApplicable ? avail.availableQty : Infinity;

      // Deity-mapped lines price (and reserve) per selected deity, not per
      // the raw `quantity` the client sent — see effectiveQuantity().
      const qty = effectiveQuantity(line);
      // Master prices (Item.salePrice / Service.categoryDetails.salePrice)
      // are the GST-inclusive counter price the devotee actually pays — GST
      // is extracted out of it, independently per line, via
      // extractGstForLines after this loop; its returned totals sum the
      // unrounded per-line figures so the cart total never drifts from a
      // single extraction on the whole cart. See common/utils/gst-rate.js.
      rawLines.push({
        refType,
        refId,
        name,
        code,
        quantity: qty,
        unitPrice,
        lineGross: unitPrice * qty,
        generalLedger: generalLedgerId,
        gstType,
        gstRate,
        deities,
        devotees,
        inventory: avail.isInventoryApplicable
          ? {
              isApplicable: true,
              currentStock: avail.currentStock,
              reservedQty: avail.reservedQty,
              availableQty: avail.availableQty,
              threshold: avail.threshold,
            }
          : { isApplicable: false },
        availableForBooking: available,
        quantityExceedsStock: eventParts ? eventParts.seatsExceeded : avail.isInventoryApplicable && qty > avail.availableQty,
        eventSlot: eventParts?.eventSlot ?? null,
        seats: eventParts?.seats ?? 1,
        holdId: eventParts?.holdId ?? null,
      });
    }

    const gst = extractGstForLines(rawLines);
    const resolvedLines = rawLines.map((l, i) => ({
      refType: l.refType,
      refId: l.refId,
      name: l.name,
      code: l.code,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      generalLedger: l.generalLedger,
      gstType: l.gstType,
      gstRate: l.gstRate,
      gstAmount: gst.lines[i].gstAmount,
      glAmount: gst.lines[i].glAmount,
      lineGst: gst.lines[i].gstAmount,
      lineTotal: l.lineGross,
      deities: l.deities,
      devotees: l.devotees,
      inventory: l.inventory,
      availableForBooking: l.availableForBooking,
      quantityExceedsStock: l.quantityExceedsStock,
      eventSlot: l.eventSlot,
      seats: l.seats,
    }));
    const subtotal = gst.totalGlAmount;
    const totalGst = gst.totalGstAmount;

    // grandTotal is the sum of each line's GST-inclusive gross (unitPrice ×
    // qty) — subtotal here is the GL/net amount (gross minus the extracted
    // GST), so subtotal + gstAmount reconciles exactly back to grandTotal.
    const grandTotal = +(subtotal + totalGst).toFixed(2);

    return responseHandler({
      res,
      response: {
        customer: {
          _id: customer._id,
          customerCode: customer.customerCode,
          name: customer.name,
          email: customer.email,
          mobileNumber: customer.mobileNumber,
        },
        lines: resolvedLines,
        subtotal: +subtotal.toFixed(2),
        gstAmount: +totalGst.toFixed(2),
        grandTotal,
        hasStockIssues: resolvedLines.some((l) => l.quantityExceedsStock),
      },
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * POST /pos/booking/recheck-lines
 *
 * Same per-line lookups as bookingSummary(), but tolerant — used by the
 * "repeat a past booking" flow, where some lines from an old order may no
 * longer be valid (deactivated, no longer POS-available, or genuinely out
 * of stock) while others still are. Unlike bookingSummary(), a bad line
 * never throws; it comes back with `available: false` and a reason so the
 * caller can offer "add just the available ones" instead of an all-or-
 * nothing failure.
 */
async function recheckLines(req, res) {
  try {
    const { error, value } = recheckLinesSchema.validate(req.body);
    if (error) throw error.details[0].message;

    const isAdmin = req.posPortal === "admin";
    const itemVisField = isAdmin ? "adminBookingVisibility" : "posAvailability";
    const svcVisField = isAdmin ? "adminBookingVisibility" : "isPosAvailable";
    const hierarchy = await loadHierarchyForPortal(req.posPortal);
    const results = await Promise.all(
      value.lines.map(async (line) => {
        const { refType, refId, quantity, deities, devotees } = line;
        const base = { refType, refId, quantity, deities, devotees };

        // offeringMeta rides along on a successful re-check so the frontend
        // can reconstruct a full Offering for the cart line — without it,
        // "repeat a past booking" lines have no way to reopen an Edit
        // modal (isDeityMappingRequired, maxFamilyMembers, etc. aren't
        // derivable from the plain name/code/price already returned here).
        let name, code, unitPrice, offeringMeta;
        if (refType === "Event") {
          // A past event booking is tied to one slot and its devotees — it is
          // booked again from the Events tab, not replayed from history.
          return { ...base, available: false, reason: "Event bookings cannot be repeated — add the event again from the Events tab." };
        }
        if (refType === "Item") {
          const item = await Item.findOne(Item.notDeletedFilter({ _id: refId, status: 1, [itemVisField]: true })).populate({
            path: "deityMapping",
            select: "name tamilName color",
            options: { sort: { displayOrder: 1, name: 1 } },
          });
          if (!item || !offeringInPosHierarchy(item, hierarchy.categoryIds, hierarchy.subCategoryIds)) {
            return { ...base, available: false, reason: "No longer available for sale." };
          }
          name = item.name;
          code = item.code;
          unitPrice = item.salePrice;
          offeringMeta = {
            tamilName: item.tamilName,
            image: item.image || null,
            color: item.color || "",
            isDeityMappingRequired: item.isDeityMappingRequired,
            deityMapping: item.deityMapping,
            isFamilyMembersRequired: item.isFamilyMembersRequired,
            maxFamilyMembers: item.maxFamilyMembers,
          };
        } else if (refType === "Service") {
          const svc = await Service.findOne(Service.notDeletedFilter({ _id: refId, status: 1, [svcVisField]: true })).populate({
            path: "deityMapping",
            select: "name tamilName color",
            options: { sort: { displayOrder: 1, name: 1 } },
          });
          if (!svc || !offeringInPosHierarchy(svc, hierarchy.categoryIds, hierarchy.subCategoryIds)) {
            return { ...base, available: false, reason: "No longer available for sale." };
          }
          name = svc.name;
          code = svc.code;
          unitPrice = svc.salePrice ?? 0;
          offeringMeta = {
            tamilName: svc.tamilName,
            image: svc.image || null,
            color: svc.color || "",
            isDeityMappingRequired: svc.isDeityMappingRequired,
            deityMapping: svc.deityMapping,
            isFamilyMembersRequired: svc.isFamilyMembersRequired,
            maxFamilyMembers: svc.maxFamilyMembers,
          };
        } else {
          const gi = await GeneralItem.findOne(GeneralItem.notDeletedFilter({ _id: refId, status: 1, [itemVisField]: true }));
          if (!gi || !offeringInPosHierarchy(gi, hierarchy.categoryIds, hierarchy.subCategoryIds)) {
            return { ...base, available: false, reason: "No longer available for sale." };
          }
          name = gi.name;
          code = gi.code;
          // No master price to re-derive — carry the cart's own typed
          // amount forward as-is (repeat-booking replays it unchanged).
          unitPrice = line.manualUnitPrice;
          offeringMeta = {
            tamilName: gi.tamilName,
            image: gi.image || null,
            color: gi.color || "",
            isDeityMappingRequired: false,
            deityMapping: [],
            isFamilyMembersRequired: false,
            maxFamilyMembers: 0,
          };
        }

        const qty = effectiveQuantity(line);
        const avail = await getAvailability(refType, refId);
        if (avail.isInventoryApplicable && qty > avail.availableQty) {
          return {
            ...base,
            available: false,
            name,
            code,
            reason:
              avail.availableQty > 0
                ? `Only ${avail.availableQty} available (need ${qty}).`
                : "Out of stock.",
          };
        }

        return {
          ...base,
          available: true,
          name,
          code,
          unitPrice,
          lineTotal: +(unitPrice * qty).toFixed(2),
          quantity: qty,
          ...offeringMeta,
        };
      })
    );

    return responseHandler({ res, response: { lines: results } });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

// ─── create order ─────────────────────────────────────────────────────────────

/**
 * POST /pos/booking/orders
 *
 * 1. Validate all lines (price, availability).
 * 2. Atomically place inventory reservations for inventory-applicable lines.
 *    If ANY line fails the availability check, ALL previously-placed
 *    reservations for this order are immediately rolled back.
 * 3. Write the Order document (status: "pending").
 * 4. Decide confirmation server-side, from the resolved payment mode — never
 *    from anything the client asserts. Cash is confirmed immediately, in
 *    this same request, via writeBookingFromOrder() (the same write
 *    confirmOrder() runs) — a cashier collecting cash in person IS the
 *    confirmation, so there's nothing for a second client-triggered call to
 *    add except another opportunity to fake success. Any other payment mode
 *    stays "pending" with its 30-minute hold; a future online gateway would
 *    confirm it server-to-server (via its own webhook calling confirmOrder),
 *    never via the browser. Either way the response carries a `status`
 *    field ("confirmed" | "pending") and the frontend polls
 *    GET /orders/:id/status until it reads "confirmed" rather than deciding
 *    that for itself.
 */
async function createOrder(req, res) {
  try {
    const { error, value } = createOrderSchema.validate(req.body);
    if (error) throw error.details[0].message;

    const { customerId, lines, paymentModeId, paidAmount } = value;
    const isAdmin = req.posPortal === "admin";
    const itemVisField = isAdmin ? "adminBookingVisibility" : "posAvailability";
    const svcVisField = isAdmin ? "adminBookingVisibility" : "isPosAvailable";
    const hierarchy = await loadHierarchyForPortal(req.posPortal);

    const customer = await Customer.findOne(
      Customer.notDeletedFilter({ _id: customerId, status: 1 })
    ).select("customerCode name email mobileNumber");
    if (!customer) throw "Customer not found or inactive.";

    const paymentMode = await PaymentMode.findOne(
      PaymentMode.notDeletedFilter({ _id: paymentModeId, status: 1 })
    ).select("name");
    if (!paymentMode) throw "Payment mode not found or inactive.";

    // ── 1. Resolve all line details (prices, names, codes) ──────────────────
    const rawLines = [];

    for (const line of lines) {
      const { refType, refId } = line;
      let { deities, devotees } = line;
      let name, code, unitPrice, gstType, generalLedgerId;
      let eventParts = null;

      if (refType === "Event") {
        eventParts = await resolveEventLine(line, { portal: req.posPortal === "admin" ? "admin" : "pos" });
        ({ name, code, unitPrice, gstType, deities, devotees } = eventParts);
        generalLedgerId = eventParts.generalLedgerId;
      } else if (refType === "Item") {
        const item = await Item.findOne(
          Item.notDeletedFilter({ _id: refId, status: 1, [itemVisField]: true })
        ).populate("generalLedger", "gstType");
        if (!item || !offeringInPosHierarchy(item, hierarchy.categoryIds, hierarchy.subCategoryIds)) {
          throw `An item in the cart is no longer available.`;
        }
        name = item.name;
        code = item.code;
        unitPrice = item.salePrice;
        gstType = item.generalLedger?.gstType ?? null;
        generalLedgerId = item.generalLedger?._id ?? null;
      } else if (refType === "Service") {
        const svc = await Service.findOne(
          Service.notDeletedFilter({ _id: refId, status: 1, [svcVisField]: true })
        ).populate("generalLedger", "gstType");
        if (!svc || !offeringInPosHierarchy(svc, hierarchy.categoryIds, hierarchy.subCategoryIds)) {
          throw `A service in the cart is no longer available.`;
        }
        name = svc.name;
        code = svc.code;
        unitPrice = svc.salePrice ?? 0;
        gstType = svc.generalLedger?.gstType ?? null;
        generalLedgerId = svc.generalLedger?._id ?? null;
      } else {
        const gi = await GeneralItem.findOne(
          GeneralItem.notDeletedFilter({ _id: refId, status: 1, [itemVisField]: true })
        ).populate("generalLedger", "gstType");
        if (!gi || !offeringInPosHierarchy(gi, hierarchy.categoryIds, hierarchy.subCategoryIds)) {
          throw `A product in the cart is no longer available.`;
        }
        name = gi.name;
        code = gi.code;
        unitPrice = line.manualUnitPrice;
        gstType = gi.generalLedger?.gstType ?? null;
        generalLedgerId = gi.generalLedger?._id ?? null;
      }

      const gstRate = await resolveGstRate(gstType);

      // Deity-mapped lines price (and later reserve/consume stock) per
      // selected deity — see effectiveQuantity(). This value becomes the
      // Order's stored line quantity, so the fix here also covers the
      // reservation and stock-out steps below without touching them.
      const qty = effectiveQuantity(line);
      // Same GST-extraction math as bookingSummary — see the comment there.
      rawLines.push({
        refType,
        refId,
        quantity: qty,
        name,
        code,
        unitPrice,
        lineGross: unitPrice * qty,
        generalLedger: generalLedgerId,
        gstType,
        gstRate,
        deities,
        devotees,
        eventSlot: eventParts?.eventSlot ?? null,
        seats: eventParts?.seats ?? 1,
        holdId: eventParts?.holdId ?? null,
      });
    }

    const gst = extractGstForLines(rawLines);
    const resolvedLines = rawLines.map((l, i) => ({
      refType: l.refType,
      refId: l.refId,
      quantity: l.quantity,
      name: l.name,
      code: l.code,
      unitPrice: l.unitPrice,
      lineTotal: l.lineGross,
      generalLedger: l.generalLedger,
      gstType: l.gstType,
      gstRate: l.gstRate,
      gstAmount: gst.lines[i].gstAmount,
      glAmount: gst.lines[i].glAmount,
      deities: l.deities,
      devotees: l.devotees,
      eventSlot: l.eventSlot,
      seats: l.seats,
      holdId: l.holdId,
    }));
    const subtotal = gst.totalGlAmount;
    const totalGst = gst.totalGstAmount;

    // grandTotal is the sum of each line's GST-inclusive gross — subtotal
    // is the GL/net amount, so subtotal + gstAmount reconciles exactly.
    const grandTotal = +(subtotal + totalGst).toFixed(2);
    // Only checkable now that the cart has actually been priced server-side
    // — the schema only knows paidAmount isn't negative.
    if (paidAmount != null && paidAmount > grandTotal + 0.005) {
      throw `Payment amount cannot exceed the total payable amount of ${grandTotal.toFixed(2)}.`;
    }
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const orderNumber = await generateOrderNumber();

    // ── 2. Write the Order first (gives us an _id for reservations) ─────────
    const order = await Order.create({
      orderNumber,
      customer: customerId,
      lines: resolvedLines.map((l) => ({
        refType: l.refType,
        refId: l.refId,
        name: l.name,
        code: l.code,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        generalLedger: l.generalLedger,
        gstType: l.gstType,
        gstRate: l.gstRate,
        gstAmount: l.gstAmount,
        glAmount: l.glAmount,
        deities: l.deities,
        devotees: l.devotees,
        eventSlot: l.eventSlot,
        seats: l.seats,
      })),
      subtotal: +subtotal.toFixed(2),
      gstAmount: +totalGst.toFixed(2),
      grandTotal,
      paymentMode: paymentModeId,
      paymentModeName: paymentMode.name,
      orderStatus: "pending",
      // Stamped from req.posPortal, which is set by the setPortal()
      // middleware on whichever route tree received this request — never
      // from the client body, so a POS terminal cannot forge "admin".
      portal: req.posPortal ?? "admin",
      expiresAt,
      bookedBy: req.auth?.userId ?? null,
      entity: req.auth?.entityId ?? null,
      createdBy: req.auth?.userId ?? null,
    });

    // ── 3. Place inventory reservations ─────────────────────────────────────
    // If this throws, we cancel the order too and re-throw to the client.
    try {
      // Who is booking (and from which portal) only matters to Event seat holds.
      const holdOptions = resolvedLines.some((l) => l.refType === "Event") ? [{ ownerId: req.auth?.userId ?? null, posOnly: req.posPortal !== "admin" }] : [];
      await placeReservationsForOrder(resolvedLines, order._id, ...holdOptions);
    } catch (reservationError) {
      // Roll back the order so the order number isn't a ghost
      await Order.findByIdAndUpdate(order._id, { orderStatus: "cancelled" });
      throw reservationError;
    }

    // ── 4. Cash confirms itself, right here, server-side ────────────────────
    if (paymentMode.name.trim().toLowerCase() === "cash") {
      // `order` came straight out of Order.create() a moment ago, so it's
      // already got everything writeBookingFromOrder() reads (subtotal,
      // grandTotal, paymentMode, portal, ...) — customer is the one field
      // that's still just an id on this doc, so swap in the full record
      // already fetched above.
      const confirmed = await writeBookingFromOrder({ ...order.toObject?.() ?? order, customer }, paidAmount);
      return responseHandler({
        res,
        response: { ...confirmed, status: "confirmed" },
        successMessage:
          confirmed.paymentStatus === "paid" ? "Booking confirmed successfully." : "Booking confirmed with a partial payment.",
        statusCode: 201,
      });
    }

    return responseHandler({
      res,
      response: {
        _id: order._id,
        orderNumber: order.orderNumber,
        customer: {
          _id: customer._id,
          customerCode: customer.customerCode,
          name: customer.name,
          email: customer.email,
          mobileNumber: customer.mobileNumber,
        },
        lines: order.lines,
        subtotal: order.subtotal,
        gstAmount: order.gstAmount,
        grandTotal: order.grandTotal,
        paymentModeName: order.paymentModeName,
        orderStatus: order.orderStatus,
        expiresAt: order.expiresAt,
        status: "pending",
      },
      successMessage: "Order created. Inventory held for 30 minutes.",
      statusCode: 201,
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

// ─── confirm order → booking ──────────────────────────────────────────────────

/**
 * Writes the Booking (permanent confirmed record), then the Transaction
 * (payment/receipt record), then marks the Order confirmed — plain
 * sequential writes, not a MongoDB multi-document transaction. A
 * transaction was tried here first for atomicity, but it measurably added
 * latency (its own start/commit round trips on top of an already slow
 * shared Atlas cluster — this was the actual cause of "Confirm Booking"
 * stalling in the browser). For this system's scale, a crash landing
 * exactly between these three writes is rare enough that a best-effort
 * cleanup (delete whatever landed, then re-throw so the order stays
 * retryable) is the better trade than paying transaction overhead on every
 * single booking. Finishes by calling consumeReservations() — permanently
 * decrementing currentStock on each inventory-applicable ref and writing
 * InventoryAdjustment "Stock Out" rows.
 *
 * Shared by confirmOrder() (the standalone endpoint — an idempotent
 * re-confirm, or a future payment gateway's webhook) and createOrder()'s
 * Cash branch (confirmed in the same request the order is created in).
 * `order` must carry `_id`, `orderNumber`, `customer` (populated doc or
 * plain id), `lines`, `subtotal`, `gstAmount`, `grandTotal`, `paymentMode`,
 * `paymentModeName`, `portal`, `bookedBy`, `entity` — exactly the shape
 * both callers already have on hand, whether from a freshly created Order
 * doc or one just fetched back out of the database.
 *
 * `paidAmount` is how much is being collected at confirm time — omit it (or
 * pass undefined/null) to pay the full grandTotal, exactly as before. Pass
 * anything from 0 up to grandTotal to open a partial payment: the booking is
 * still confirmed (inventory is committed either way — see the module
 * comment on Booking), but its paymentStatus reflects what's actually been
 * collected, and the remainder can be collected later via
 * POST /pos/booking/bookings/:id/payments (recordBookingPayment()).
 */
async function writeBookingFromOrder(order, paidAmount) {
  const [bookingNumber, receiptNo] = await Promise.all([generateBookingNumber(), generateReceiptNumber()]);
  const now = new Date();
  const customerId = order.customer._id ?? order.customer;

  // Clamp rather than reject — the amount was already validated by the
  // caller against the price the client *quoted*; grandTotal here is the
  // server's own just-recomputed figure, and the two can differ by a cent of
  // rounding. Silently capping at grandTotal (and floor of 0) means that kind
  // of drift never blocks a checkout the cashier already collected cash for.
  const amountNow = paidAmount == null ? order.grandTotal : Math.max(0, Math.min(paidAmount, order.grandTotal));
  const bookingPaymentStatus = derivePaymentStatus(amountNow, order.grandTotal);

  let booking;
  let transaction;
  try {
    // ── 1. Write Booking (permanent record) ──────────────────────────────
    booking = await Booking.create({
      bookingNumber,
      orderId: order._id,
      customer: customerId,
      lines: order.lines,
      subtotal: order.subtotal,
      gstAmount: order.gstAmount,
      grandTotal: order.grandTotal,
      paymentMode: order.paymentMode,
      paymentModeName: order.paymentModeName,
      paymentStatus: bookingPaymentStatus,
      bookingStatus: "confirmed",
      portal: order.portal,
      bookedBy: order.bookedBy,
      entity: order.entity,
      bookedAt: now,
      createdBy: order.bookedBy ?? null,
    });

    // ── 2. Write Transaction (payment/receipt record) ─────────────────────
    // Skipped entirely for a $0 "pay later" confirm — a paymentStatus:
    // "pending" booking with no Transaction row yet is exactly what
    // recordBookingPayment() expects to find when the first installment
    // comes in (amountPaid sums to 0 over an empty set, same as any booking
    // with no rows), and it avoids a zero-amount Transaction that would
    // otherwise need special-casing everywhere receipts are displayed.
    if (amountNow > 0) {
      transaction = await Transaction.create({
        receiptNo,
        bookingId: booking._id,
        orderId: order._id,
        customer: customerId,
        paymentMode: order.paymentMode,
        paymentModeName: order.paymentModeName,
        amount: amountNow,
        paymentStatus: "paid",
        portal: order.portal,
        transactionDate: now,
        processedBy: order.bookedBy,
        createdBy: order.bookedBy ?? null,
      });
    }

    // ── 3. Update Order ─────────────────────────────────────────────────
    await Order.findByIdAndUpdate(order._id, { orderStatus: "confirmed", bookingId: booking._id });
  } catch (writeError) {
    // Best-effort cleanup so a retry doesn't leave orphaned rows or try to
    // confirm again against a half-written state — order stays "pending"
    // (never touched above), so the client can safely retry the same order.
    if (transaction) await Transaction.deleteOne({ _id: transaction._id }).catch(() => {});
    if (booking) await Booking.deleteOne({ _id: booking._id }).catch(() => {});
    throw writeError;
  }

  // ── 4. Permanently decrement stock + consume reservations ────────────────
  await consumeReservations(order._id, order.lines, order.bookedBy, bookingNumber);

  const customerSnap = order.customer?.customerCode
    ? order.customer
    : await Customer.findById(order.customer).select("customerCode name email mobileNumber");

  return {
    _id: booking._id,
    bookingNumber: booking.bookingNumber,
    orderNumber: order.orderNumber,
    receiptNo: transaction?.receiptNo ?? null,
    customer: {
      _id: customerSnap._id,
      customerCode: customerSnap.customerCode,
      name: customerSnap.name,
      email: customerSnap.email,
      mobileNumber: customerSnap.mobileNumber,
    },
    lines: booking.lines,
    subtotal: booking.subtotal,
    gstAmount: booking.gstAmount,
    grandTotal: booking.grandTotal,
    paymentModeName: booking.paymentModeName,
    paymentStatus: booking.paymentStatus,
    bookingStatus: booking.bookingStatus,
    bookedAt: booking.bookedAt,
    amountPaid: amountNow,
    balanceAmount: +(booking.grandTotal - amountNow).toFixed(2),
  };
}

/**
 * POST /pos/booking/orders/:id/confirm
 *
 * Verifies the order is still pending and not expired, then hands off to
 * writeBookingFromOrder(). No longer the routine "Cash" path the frontend
 * calls on every checkout (see createOrder) — this stays as the idempotent
 * re-confirm (returns the existing booking if already confirmed) and as
 * the landing spot a future online-payment gateway's webhook would call.
 */
async function confirmOrder(req, res) {
  try {
    const orderId = req.params.id;
    if (!mongoose.isValidObjectId(orderId)) throw "Invalid order ID.";

    // No required body for cash — just validate whatever comes
    const { error, value } = confirmOrderSchema.validate(req.body ?? {});
    if (error) throw error.details[0].message;
    const { paidAmount } = value;

    const order = await Order.findOne(
      Order.notDeletedFilter({ _id: orderId })
    ).populate("customer", "customerCode name email mobileNumber");

    if (!order) throw "Order not found.";
    if (order.orderStatus === "confirmed") {
      // Idempotent — return the existing booking + its transaction.
      // Guard against the edge case where the booking doc was force-deleted
      // after the order was already confirmed (should never happen in normal
      // operation, but failing with a clear message is better than a crash).
      const [existing, existingTxn] = await Promise.all([
        Booking.findById(order.bookingId)
          .populate("customer", "customerCode name email mobileNumber")
          // Print order, not display order — this feeds the receipt (see
          // models/deities' printOrder field). Sorted in JS below —
          // Mongoose can't apply a populate `sort` to a path nested
          // inside a document array like this one.
          .populate({ path: "lines.deities", select: "name printOrder" })
          .populate("bookedBy", "name email"),
        Transaction.findOne(Transaction.notDeletedFilter({ orderId: order._id })),
      ]);
      if (!existing) throw "Booking record not found for this confirmed order.";
      sortLineDeities(existing, "printOrder");
      return responseHandler({
        res,
        response: {
          ...existing.toObject(),
          receiptNo: existingTxn?.receiptNo ?? null,
          orderNumber: order.orderNumber,
          status: "confirmed",
        },
        successMessage: "Booking already confirmed.",
      });
    }
    if (order.orderStatus === "cancelled") throw "This order has been cancelled and cannot be confirmed.";

    // Check the 30-minute hold hasn't expired
    if (new Date() > order.expiresAt) {
      await cancelReservations(order._id);
      await Order.findByIdAndUpdate(order._id, { orderStatus: "cancelled" });
      throw "Order expired — the 30-minute hold has lapsed. Please create a new order.";
    }

    if (paidAmount != null && paidAmount > order.grandTotal + 0.005) {
      throw `Payment amount cannot exceed the total payable amount of ${order.grandTotal.toFixed(2)}.`;
    }

    const confirmed = await writeBookingFromOrder(order, paidAmount);
    return responseHandler({
      res,
      response: { ...confirmed, status: "confirmed" },
      successMessage:
        confirmed.paymentStatus === "paid" ? "Booking confirmed successfully." : "Booking confirmed with a partial payment.",
      statusCode: 201,
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * GET /pos/booking/orders/:id/status
 *
 * Read-only poll target. The frontend never decides "payment succeeded"
 * itself any more (see createOrder/confirmOrder) — it creates the order
 * and then watches this until the status the server already settled on
 * shows up confirmed. Purely a read: never mutates anything, not even past
 * expiry — an actual pending → confirmed/cancelled transition only ever
 * happens inside createOrder's cash branch or confirmOrder itself.
 */
async function getOrderStatus(req, res) {
  try {
    const orderId = req.params.id;
    if (!mongoose.isValidObjectId(orderId)) throw "Invalid order ID.";

    const order = await Order.findOne(Order.notDeletedFilter({ _id: orderId })).select(
      "orderStatus orderNumber expiresAt bookingId"
    );
    if (!order) throw "Order not found.";

    if (order.orderStatus === "confirmed") {
      const [booking, txn] = await Promise.all([
        Booking.findById(order.bookingId)
          .populate("customer", "customerCode name email mobileNumber")
          // Print order, not display order — see confirmOrder's comment above.
          .populate({ path: "lines.deities", select: "name printOrder" })
          .populate("bookedBy", "name email"),
        Transaction.findOne(Transaction.notDeletedFilter({ orderId: order._id })),
      ]);
      if (!booking) throw "Booking record not found for this confirmed order.";
      sortLineDeities(booking, "printOrder");
      return responseHandler({
        res,
        // Flat, same shape as createOrder/confirmOrder's own "confirmed"
        // response — one BookingConfirmation-shaped object everywhere a
        // confirmed booking comes back from, regardless of which of the
        // three endpoints is the one that discovered it.
        response: { ...booking.toObject(), receiptNo: txn?.receiptNo ?? null, orderNumber: order.orderNumber, status: "confirmed" },
      });
    }

    if (order.orderStatus === "cancelled") {
      return responseHandler({ res, response: { status: "cancelled" } });
    }

    const expired = new Date() > order.expiresAt;
    return responseHandler({ res, response: { status: expired ? "expired" : "pending", expiresAt: order.expiresAt } });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

// ─── POS Transactions (read-only ledger) ──────────────────────────────────────

function deriveLineType(lines) {
  const types = new Set((lines || []).map((l) => l.refType));
  if (types.size === 0) return "—";
  if (types.size === 1) return [...types][0];
  return "Mixed";
}

/**
 * GET /pos/booking/bookings?search=&status=&portal=&page=&pageSize=
 *
 * Read-only ledger backing the "POS Transactions" admin screen. Lists
 * confirmed/cancelled Bookings — pending Orders that never got confirmed are
 * abandoned holds, not transactions, so they don't appear here.
 *
 * `portal` filters by the surface that created the booking:
 *   "admin"    → Admin Booking screen (Admin Panel)
 *   "pos"      → POS Portal counter terminal
 *   "customer" → Customer Portal self-service (future)
 * Omit to see all portals together (default for the transactions screen).
 */
async function listBookings(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);

    const filter = Booking.notDeletedFilter();
    if (req.query.status && BOOKING_STATUSES.includes(req.query.status)) {
      filter.bookingStatus = req.query.status;
    }
    if (req.query.portal && ["admin", "pos", "customer"].includes(req.query.portal)) {
      filter.portal = req.query.portal;
    }
    if (req.query.paymentStatus && ["paid", "partial", "pending"].includes(req.query.paymentStatus)) {
      filter.paymentStatus = req.query.paymentStatus;
    }
    if (req.query.search) {
      const regex = searchRegex(req.query.search);
      const [matchingCustomers, matchingTransactions] = await Promise.all([
        Customer.find(Customer.notDeletedFilter({ name: regex })).select("_id"),
        Transaction.find(Transaction.notDeletedFilter({ receiptNo: regex })).select("bookingId"),
      ]);
      filter.$or = [
        { bookingNumber: regex },
        { customer: { $in: matchingCustomers.map((c) => c._id) } },
        { _id: { $in: matchingTransactions.map((t) => t.bookingId) } },
      ];
    }

    const [bookings, total] = await Promise.all([
      Booking.find(filter)
        .populate("customer", "customerCode name email mobileNumber")
        .populate("orderId", "orderNumber")
        .select(
          "bookingNumber orderId customer lines subtotal gstAmount grandTotal paymentModeName paymentStatus bookingStatus portal reprintCount bookedAt"
        )
        .sort({ bookedAt: -1 })
        .skip(req.listWindow?.skip ?? (page - 1) * pageSize)
        .limit(req.listWindow?.limit ?? pageSize),
      Booking.countDocuments(filter),
    ]);

    // Receipt numbers (and the amount actually collected) live on
    // Transaction, not Booking (see models/transactions' own comment on
    // why) — one batched lookup instead of populate, since
    // Booking↔Transaction isn't a declared ref in either direction. A
    // booking can have more than one Transaction row now (partial payments),
    // so this groups by booking rather than assuming a 1:1.
    const bookingIds = bookings.map((b) => b._id);
    const transactions = await Transaction.find(Transaction.notDeletedFilter({ bookingId: { $in: bookingIds } }))
      .select("bookingId receiptNo amount paymentStatus transactionDate")
      .sort({ transactionDate: 1 });
    const transactionsByBooking = new Map();
    for (const t of transactions) {
      const key = String(t.bookingId);
      if (!transactionsByBooking.has(key)) transactionsByBooking.set(key, []);
      transactionsByBooking.get(key).push(t);
    }

    const items = bookings.map((b) => {
      const bookingTxns = transactionsByBooking.get(String(b._id)) ?? [];
      const amountPaid = sumPaidAmount(bookingTxns);
      return {
        _id: b._id,
        bookingNumber: b.bookingNumber,
        // First receipt issued for this booking — the one printed at
        // confirm time. Later installments get their own receiptNo, visible
        // in the booking detail's payment history.
        receiptNo: bookingTxns[0]?.receiptNo ?? null,
        orderNumber: b.orderId?.orderNumber ?? null,
        customer: b.customer
          ? { _id: b.customer._id, customerCode: b.customer.customerCode, name: b.customer.name }
          : null,
        lineType: deriveLineType(b.lines),
        paymentModeName: b.paymentModeName,
        subtotal: b.subtotal,
        gstAmount: b.gstAmount,
        grandTotal: b.grandTotal,
        paymentStatus: b.paymentStatus,
        amountPaid,
        balanceAmount: +(b.grandTotal - amountPaid).toFixed(2),
        bookingStatus: b.bookingStatus,
        portal: b.portal,
        reprintCount: b.reprintCount ?? 0,
        bookedAt: b.bookedAt,
      };
    });

    return responseHandler({ res, response: { items, total, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * GET /pos/booking/bookings/:id
 *
 * Full detail for one booking — every line (with deity/devotee breakdown),
 * customer profile, order reference, payment info, and the Transaction
 * record (receipt number, amount, transaction date).
 */
async function getBookingDetail(req, res) {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) throw "Invalid booking ID.";

    const [booking, transactions] = await Promise.all([
      Booking.findOne(Booking.notDeletedFilter({ _id: id }))
        .populate("customer", "customerCode name email mobileNumber")
        .populate("orderId", "orderNumber orderStatus")
        .populate("paymentMode", "name")
        // Print order, not display order — see confirmOrder's comment above.
        .populate({ path: "lines.deities", select: "name printOrder" })
        .populate("bookedBy", "name email"),
      Transaction.find(Transaction.notDeletedFilter({ bookingId: id }))
        .select("receiptNo amount paymentStatus paymentModeName transactionDate processedBy")
        .populate("processedBy", "name email")
        .sort({ transactionDate: 1 }),
    ]);

    if (!booking) throw "Booking not found.";
    sortLineDeities(booking, "printOrder");

    const amountPaid = sumPaidAmount(transactions);

    return responseHandler({
      res,
      response: {
        ...booking.toObject(),
        // Every payment collected against this booking, oldest first — the
        // receipt number lives here, not on the Booking itself, by design
        // (1:many, see models/transactions). A fully-paid-at-confirm booking
        // still comes back with exactly one row here, same as before; a
        // partial-payment booking shows its full installment history.
        transactions,
        amountPaid,
        balanceAmount: +(booking.grandTotal - amountPaid).toFixed(2),
      },
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 404 : undefined });
  }
}

/**
 * POST /pos/booking/bookings/:id/payments
 *
 * Records one more installment against a confirmed booking that isn't fully
 * paid yet — the "collect the rest" step of the partial-payment flow started
 * by createOrder/confirmOrder's `paidAmount`. Writes a new Transaction row
 * (its own receipt number) and recomputes the Booking's paymentStatus from
 * the new total collected; never touches bookingStatus or inventory — those
 * were already settled at confirm time, regardless of how much had been
 * paid then.
 */
async function recordBookingPayment(req, res) {
  try {
    const bookingId = req.params.id;
    if (!mongoose.isValidObjectId(bookingId)) throw "Invalid booking ID.";

    const { error, value } = recordPaymentSchema.validate(req.body ?? {});
    if (error) throw error.details[0].message;
    const { amount, paymentModeId } = value;

    const booking = await Booking.findOne(Booking.notDeletedFilter({ _id: bookingId }));
    if (!booking) throw "Booking not found.";
    if (booking.bookingStatus !== "confirmed") throw "Only confirmed bookings can receive payments.";

    const existingTxns = await Transaction.find(Transaction.notDeletedFilter({ bookingId: booking._id })).select("amount paymentStatus");
    const paidSoFar = sumPaidAmount(existingTxns);
    const balance = +(booking.grandTotal - paidSoFar).toFixed(2);
    if (balance <= 0.005) throw "This booking is already fully paid.";
    if (amount > balance + 0.005) throw `Payment amount cannot exceed the outstanding balance of ${balance.toFixed(2)}.`;

    // Defaults to the booking's own payment mode — an installment doesn't
    // have to be collected the same way the first payment was (e.g. booked
    // against Cash, balance topped up via PayNow later).
    let paymentMode = booking.paymentMode;
    let paymentModeName = booking.paymentModeName;
    if (paymentModeId) {
      const mode = await PaymentMode.findOne(PaymentMode.notDeletedFilter({ _id: paymentModeId, status: 1 })).select("name");
      if (!mode) throw "Payment mode not found or inactive.";
      paymentMode = mode._id;
      paymentModeName = mode.name;
    }

    const receiptNo = await generateReceiptNumber();
    const transaction = await Transaction.create({
      receiptNo,
      bookingId: booking._id,
      orderId: booking.orderId,
      customer: booking.customer,
      paymentMode,
      paymentModeName,
      amount,
      paymentStatus: "paid",
      portal: booking.portal,
      transactionDate: new Date(),
      processedBy: req.auth?.userId ?? null,
      createdBy: req.auth?.userId ?? null,
    });

    const newAmountPaid = +(paidSoFar + amount).toFixed(2);
    booking.paymentStatus = derivePaymentStatus(newAmountPaid, booking.grandTotal);
    await booking.save();

    return responseHandler({
      res,
      response: {
        receiptNo: transaction.receiptNo,
        amount: transaction.amount,
        paymentModeName,
        transactionDate: transaction.transactionDate,
        paymentStatus: booking.paymentStatus,
        amountPaid: newAmountPaid,
        balanceAmount: +(booking.grandTotal - newAmountPaid).toFixed(2),
      },
      successMessage:
        booking.paymentStatus === "paid" ? "Payment recorded — booking is now fully paid." : "Payment recorded successfully.",
      statusCode: 201,
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * Resolves a confirmed Admin Booking's lines into physical print tickets —
 * the Admin Booking Page's own counterpart to controllers/pos-orders'
 * computeBookingTicketGroups, which does the exact same job for the POS
 * Portal's PosBooking/PosTransaction collections. The Admin Booking screen
 * was never wired to any ticket-groups resolver at all until now (it writes
 * to the older, shared Booking/Transaction collections instead), so this is
 * a straight port of that function onto this module's own models rather
 * than a shared implementation — the two booking trees intentionally don't
 * share write models (see the module doc comment above), so this has no
 * single collection to query against.
 *
 * @returns {Promise<{ticketGroups, receipt, temple, customer, splitMode}>}
 */
async function computeAdminBookingTicketGroups(bookingId) {
  if (!mongoose.isValidObjectId(bookingId)) throw "Invalid booking ID.";

  const booking = await Booking.findOne(Booking.notDeletedFilter({ _id: bookingId })).populate({
    path: "lines.deities",
    select: "name tamilName printingGroup printOrder",
    populate: { path: "printingGroup", select: "name" },
  });
  if (!booking) throw "Booking not found.";
  // Determines the order deity-wise tickets print in for a multi-deity
  // line (see models/deities' printOrder field) — sorted here, in JS, not
  // via the populate above: Mongoose can't apply a populate `sort` to a
  // path nested inside a document array like lines.deities.
  sortLineDeities(booking, "printOrder");

  // Print tickets in Tamil for devotee name + star — resolve nakshatra
  // from the master and transliterate Latin devotee names. Done on the
  // in-memory booking only; never written back.
  await enrichBookingDevoteesForPrint(booking);

  const [setting, paidTxns, entity] = await Promise.all([
    PrintSplitSetting.findOne({}),
    // ALL paid installments, not just the first — see the matching comment
    // on controllers/pos-orders' computeBookingTicketGroups for why.
    Transaction.find(Transaction.notDeletedFilter({ bookingId: booking._id, paymentStatus: "paid" }))
      .sort({ transactionDate: 1 })
      .select("receiptNo paymentModeName"),
    booking.entity ? findActiveEntityById(booking.entity) : Promise.resolve(null),
  ]);
  const splitMode = setting?.mode ?? "PRINT_GROUP_WISE";

  const paymentModeNames = [];
  const seenModeNames = new Set();
  for (const t of paidTxns) {
    if (seenModeNames.has(t.paymentModeName)) continue;
    seenModeNames.add(t.paymentModeName);
    paymentModeNames.push(t.paymentModeName);
  }
  if (paymentModeNames.length === 0) paymentModeNames.push(booking.paymentModeName);

  // Batch-load every Item/Service/GeneralItem referenced by this booking's
  // lines in three queries total, not one per line.
  const itemIds = booking.lines.filter((l) => l.refType === "Item").map((l) => l.refId);
  const serviceIds = booking.lines.filter((l) => l.refType === "Service").map((l) => l.refId);
  const generalItemIds = booking.lines.filter((l) => l.refType === "GeneralItem").map((l) => l.refId);
  const [items, services, generalItems] = await Promise.all([
    itemIds.length
      ? Item.find({ _id: { $in: itemIds } }).select("isDeityMappingRequired printingGroup tamilName ticketImage printImage").populate("printingGroup", "name")
      : [],
    serviceIds.length
      ? Service.find({ _id: { $in: serviceIds } }).select("isDeityMappingRequired printingGroup tamilName ticketImage printImage").populate("printingGroup", "name")
      : [],
    generalItemIds.length
      ? GeneralItem.find({ _id: { $in: generalItemIds } }).select("printingGroup tamilName ticketImage printImage").populate("printingGroup", "name")
      : [],
  ]);
  const offeringsById = new Map([...items, ...services, ...generalItems].map((doc) => [String(doc._id), doc]));
  // Event lines print per deity (the picked deities carry the print group), so an event
  // behaves like a deity-mapped offering here.
  const eventIds = booking.lines.filter((l) => l.refType === "Event").map((l) => l.refId);
  if (eventIds.length) {
    const eventDocs = await Event.find({ _id: { $in: eventIds } }).select("tamilName ticketImage printImage");
    for (const e of eventDocs) offeringsById.set(String(e._id), { isDeityMappingRequired: true, tamilName: e.tamilName, ticketImage: e.ticketImage, printImage: e.printImage });
  }

  
  // Picture to print under each line - only when Print Split Setting's "Print image on ticket" is Yes AND the
  // record's own master says yes and has a picture (otherwise no imageUrl is sent and the ticket is unchanged).
  const printImageOn = setting?.printImage === true;
  for (const doc of offeringsById.values()) doc.ticketImageUrl = ticketImageUrl(doc, printImageOn);

  const units = booking.lines.flatMap((line) => resolveLineUnits(line, offeringsById.get(String(line.refId)), line.deities));
  const ticketGroups = buildTicketGroups(units, splitMode);
  // How many times each ticket has been reprinted so far (the Reprint popup shows it and numbers the next one).
  const reprintCounts = ticketReprintCounts(booking.reprints);
  for (const g of ticketGroups) g.reprintCount = reprintCounts.get(g.key) || 0;

  return {
    ticketGroups,
    receipt: {
      receiptNo: paidTxns[0]?.receiptNo ?? null,
      bookingNumber: booking.bookingNumber,
      printedAt: new Date().toISOString(),
      paymentModeNames,
    },
    temple: entity ? { name: entity.templeName || entity.name, tamilName: entity.templeTamilName || "" } : null,
    customer: booking.customerInfo,
    splitMode,
  };
}

/**
 * GET /pos/admin/booking/bookings/:id/ticket-groups — thin HTTP wrapper, see
 * computeAdminBookingTicketGroups above.
 */
async function getAdminBookingTicketGroups(req, res) {
  try {
    const result = await computeAdminBookingTicketGroups(req.params.id);
    return responseHandler({ res, response: result });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

// ─── router assembly ──────────────────────────────────────────────────────────

/**
 * Portal middleware factory — stamps req.posPortal with the correct value
 * derived from which route tree received the request, so handler functions
 * never trust anything from the client body to decide what portal stamped a
 * booking. This mirrors how HEB's OBS controller derives the booking
 * platform from the URL segment rather than a client-supplied field.
 *
 * Route layout:
 *   /pos/booking/*        → portal: "pos"   (POS Portal counter terminal)
 *   /pos/admin/booking/*  → portal: "admin" (Admin Panel booking screen)
 *   (future) /pos/customer/booking/* → portal: "customer"
 */
/**
 * The Payment Mode picker is read by both the booking flow's "Payment Mode"
 * selector and the POS Transactions ledger's "Record Payment" installment
 * picker (choosing which mode a partial-payment top-up came in). Gating it
 * on "admin-booking" view alone would 403 a cashier who only has
 * "pos-transactions" access — either module's view level is enough to read
 * this lookup list, since it's the same handful of harmless {_id, name}
 * rows a booking screen already exposes to admin-booking viewers.
 */
function requirePaymentModeAccess(req, res, next) {
  if (req.auth?.userType === USER_TYPES.SUPER_ADMIN) return next();
  const perms = req.auth?.permissions ?? {};
  if (LEDGER_MODULES.some((m) => perms[m]?.view) || perms["admin-booking"]?.view) return next();
  return exceptionHandler({
    res,
    error: "You don't have view access to Admin Booking or POS Transactions.",
    statusCode: 403,
  });
}

/**
 * The three transaction ledgers (Admin / POS / Customer Transactions) read the
 * same booking endpoints on the Admin tree, so a grant on any of them opens
 * the list, detail and payment routes; the screen itself pins which portal it
 * lists.
 */
const LEDGER_MODULES = ["admin-transactions", "pos-transactions", "customer-transactions"];
function requireLedgerAccess(level) {
  const guard = (req, res, next) => {
    if (req.auth?.userType === USER_TYPES.SUPER_ADMIN) return next();
    if (LEDGER_MODULES.some((m) => req.auth?.permissions?.[m]?.[level])) return next();
    return exceptionHandler({ res, error: `You don't have ${level} access to transactions.`, statusCode: 403 });
  };
  Object.defineProperty(guard, "name", { value: `requireLedgerAccess:${level}` });
  return guard;
}

function setPortal(portalValue) {
  return function stampPortal(req, _res, next) {
    req.posPortal = portalValue;
    next();
  };
}

/**
 * Register the shared catalogue/lookup routes onto a given Express Router.
 * Called for both the POS sub-router and the Admin sub-router — these reads
 * (items/services/customers/payment-modes/catalogue/summary) don't write an
 * order/booking of their own, so both trees keep sharing this one
 * implementation regardless of which collections each tree's own
 * order/booking WRITE routes end up backed by (see below).
 */
function registerCatalogueRoutes(r) {
  // ── Lookup / catalogue (read) ──────────────────────────────────────────
  r.get("/customers/search",    requirePermission("admin-booking", "view"),       searchCustomers);
  r.get("/customers/lookup",    requirePermission("admin-booking", "view"),       lookupCustomerByMobile);
  r.get("/customers/self",      requirePermission("admin-booking", "view"),       getSelfCustomer);
  r.post("/customers",          requirePermission("admin-booking", "fullAccess"), validateBody(createCustomerSchema), createWalkInCustomer);
  r.patch("/customers/:id/family-members", requirePermission("admin-booking", "fullAccess"), validateBody(addFamilyMembersSchema), addFamilyMembers);
  r.get("/customers/:id/recent-bookings", requirePermission("admin-booking", "view"), getRecentBookings);
  r.get("/items",               requirePermission("admin-booking", "view"),       listPosItems);
  r.get("/services",            requirePermission("admin-booking", "view"),       listPosServices);
  r.get("/general-items",       requirePermission("admin-booking", "view"),       listGeneralItems);
  r.get("/events",              requirePermission("admin-booking", "view"),       listPosEvents);
  // Seat holds - taken when an event goes into the cart, given back when it leaves (see ./event-holds).
  r.post("/events/holds",         requirePermission("admin-booking", "view"), validateBody(holdSeatsSchema),    holdSeats);
  r.post("/events/holds/refresh", requirePermission("admin-booking", "view"), validateBody(refreshHoldsSchema), refreshHolds);
  r.post("/events/holds/release-orphans", requirePermission("admin-booking", "view"), validateBody(releaseOrphanHoldsSchema), releaseOrphanHolds);
  r.delete("/events/holds/:id",   requirePermission("admin-booking", "view"),                                   releaseHoldRoute);
  r.get("/payment-modes",       requirePaymentModeAccess,                         listPaymentModes);
  r.get("/catalogue",           requirePermission("admin-booking", "view"),       getCatalogue);
  r.get("/deities",             requirePermission("admin-booking", "view"),       listDeities);
  r.get("/nakshathirams",       requirePermission("admin-booking", "view"),       listNakshathirams);

  r.post("/summary",            requirePermission("admin-booking", "view"),       validateBody(summarySchema),      bookingSummary);
  r.post("/recheck-lines",      requirePermission("admin-booking", "view"),       validateBody(recheckLinesSchema), recheckLines);
}

/**
 * Runs a list handler against a fake response and hands back what it would have sent, so the
 * Admin ledger can stitch the two booking stores together.
 */
function captureList(handler, req, listWindow) {
  return new Promise((resolve, reject) => {
    const fake = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        if (this.statusCode >= 400) reject(new Error(body?.message || "List failed."));
        else resolve(body?.data);
        return this;
      },
    };
    Promise.resolve(handler({ ...req, query: { ...req.query }, listWindow }, fake)).catch(reject);
  });
}

/**
 * Admin Transactions: bookings made from the Admin Panel now live with the counter's
 * (pos_bookings, portal "admin"); older ones are still in bookings. New ones are always newer
 * than old ones, so the ledger is simply the new list followed by the old one.
 * Any other portal filter (Customer) reads the older store as before.
 */
async function adminListBookings(req, res) {
  try {
    if (req.query.portal !== "admin") return listBookings(req, res);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    const skip = (page - 1) * pageSize;

    const [posCount, legacyCount] = await Promise.all([
      captureList(posOrders.listBookings, req, { skip: 0, limit: 1 }),
      captureList(listBookings, req, { skip: 0, limit: 1 }),
    ]);
    const posTotal = posCount.total;
    const items = [];
    if (skip < posTotal) {
      const part = await captureList(posOrders.listBookings, req, { skip, limit: Math.min(pageSize, posTotal - skip) });
      items.push(...part.items);
    }
    const remaining = pageSize - items.length;
    if (remaining > 0) {
      const part = await captureList(listBookings, req, { skip: Math.max(0, skip - posTotal), limit: remaining });
      items.push(...part.items);
    }
    return responseHandler({ res, response: { items, total: posTotal + legacyCount.total, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/** Sends a booking-by-id request to whichever store holds that booking. */
function byBookingStore(posHandler, legacyHandler) {
  return async function routeByStore(req, res, next) {
    try {
      const id = req.params.id;
      const inPosStore = mongoose.isValidObjectId(id) && (await PosBooking.exists({ _id: id }));
      return (inPosStore ? posHandler : legacyHandler)(req, res, next);
    } catch (error) {
      return exceptionHandler({ res, error });
    }
  };
}

const reprintLegacyBooking = makeReprintHandler(Booking);

function registerAdminLedgerRoutes(r) {
  r.get("/bookings", requireLedgerAccess("view"), adminListBookings);
  r.get("/bookings/:id", requireLedgerAccess("view"), byBookingStore(posOrders.getBookingDetail, getBookingDetail));
  r.get("/bookings/:id/ticket-groups", requireLedgerAccess("view"), byBookingStore(posOrders.getBookingTicketGroups, getAdminBookingTicketGroups));
  r.post("/bookings/:id/reprint", requireLedgerAccess("edit"), byBookingStore(posOrders.reprintPosBooking, reprintLegacyBooking));
  r.post(
    "/bookings/:id/payments",
    requireLedgerAccess("fullAccess"),
    validateBody(recordPaymentSchema),
    byBookingStore(posOrders.recordBookingPayment, recordBookingPayment)
  );
}

/**
 * The Admin Panel's own order/booking/payment WRITE routes — unchanged from
 * before the pos_orders split, still backed by the shared Order/Booking/
 * Transaction collections (models/orders, models/bookings,
 * models/transactions). Mounted ONLY on the Admin Booking tree now; the POS
 * Portal tree gets its own implementation from controllers/pos-orders
 * instead (see registerPosOrderRoutes below) — see that module's own
 * comment for why the two trees no longer share this block.
 */
function registerAdminBookingWriteRoutes(r) {
  r.post("/orders",             requirePermission("admin-booking", "fullAccess"), validateBody(createOrderSchema),  createOrder);
  r.post("/orders/:id/confirm", requirePermission("admin-booking", "fullAccess"),                                   confirmOrder);
  r.get("/orders/:id/status",   requirePermission("admin-booking", "view"),                                         getOrderStatus);

  r.get("/bookings",            requireLedgerAccess("view"),    listBookings);
  r.get("/bookings/:id",        requireLedgerAccess("view"),    getBookingDetail);
  r.get("/bookings/:id/ticket-groups", requireLedgerAccess("view"), getAdminBookingTicketGroups);

  r.post("/bookings/:id/payments", requireLedgerAccess("fullAccess"), validateBody(recordPaymentSchema), recordBookingPayment);
}

const router = express.Router();

// All POS routes require an authenticated admin
router.use(authGuard, adminOnly);

router.get("/health", (_req, res) =>
  res.json({ ok: true, service: "SSD-Backend", module: "pos" })
);

// ── POS Portal: /pos/booking/* → portal = "pos" ───────────────────────────
// Order/booking/payment writes here are backed by pos_orders/pos_bookings/
// pos_transactions (controllers/pos-orders), not the shared Order/Booking/
// Transaction collections the Admin tree below still uses.
const posOrders = require("../pos-orders");
const { registerPosOrderRoutes, registerPosOrderWriteRoutes } = posOrders;
const posBookingRouter = express.Router();
registerCatalogueRoutes(posBookingRouter);
registerPosOrderRoutes(posBookingRouter);
router.use("/booking", setPortal("pos"), posBookingRouter);

// ── Admin Panel: /pos/admin/booking/* → portal = "admin" ─────────────────
const adminBookingRouter = express.Router();
registerCatalogueRoutes(adminBookingRouter);
// Same order + payment implementation as the counter (Cash, PayNow, NETS, card, manual confirm),
// stamped portal "admin"; only the ledger below differs (it also reads the older Admin records).
registerPosOrderWriteRoutes(adminBookingRouter);
registerAdminLedgerRoutes(adminBookingRouter);
router.use("/admin/booking", setPortal("admin"), adminBookingRouter);

module.exports = router;
// Exposed for unit testing (src/controllers/pos/__tests__) — the router
// object is a function, so these are just extra properties on it and don't
// change how routes/index.js consumes the default export.
module.exports.createOrder = createOrder;
module.exports.confirmOrder = confirmOrder;
module.exports.getOrderStatus = getOrderStatus;
module.exports.effectiveQuantity = effectiveQuantity;
module.exports.recordBookingPayment = recordBookingPayment;
module.exports.getRecentBookings = getRecentBookings;
module.exports.computeAdminBookingTicketGroups = computeAdminBookingTicketGroups;
module.exports.getAdminBookingTicketGroups = getAdminBookingTicketGroups;
