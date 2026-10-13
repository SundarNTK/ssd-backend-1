const mongoose = require("mongoose");
const { auditablePlugin, activeUniqueIndexOptions } = require("../../common/plugins/auditable");

/**
 * One bookable slot within the event's date range — its own name, date,
 * time window, seat capacity, and status, so a multi-day event (or one with
 * several sessions per day) can be sold slot by slot.
 */
const slotDetailSchema = new mongoose.Schema(
  {
    slotName: { type: String, required: true, trim: true },
    date: { type: Date, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    totalSeats: { type: Number, default: 0 },
    // Seats of confirmed bookings, and seats temporarily held by carts / pending
    // orders. Both are maintained ONLY by atomic updates in common/utils/
    // event-seats.js - the admin form shows them read-only and anything it
    // sends is ignored. Seats left = totalSeats - bookedSeats - heldSeats.
    bookedSeats: { type: Number, default: 0, min: 0 },
    heldSeats: { type: Number, default: 0, min: 0 },
    status: { type: Number, enum: [0, 1], default: 1 },
  },
  { _id: false }
);

const eventSchema = new mongoose.Schema({
  code: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, required: true, trim: true },
  tamilName: { type: String, default: "" },
  description: { type: String, default: "" },
  image: { type: String, default: null }, // full Cloudinary secure_url
  // Print this record's picture under it on the ticket (also needs "Print image on ticket" = Yes in Print Split Setting).
  printImage: { type: Boolean, default: false },
  // The picture printed on the ticket (its own upload, separate from `image`, the card picture). full Cloudinary secure_url
  ticketImage: { type: String, default: null },
  // Wide banner artwork (<= 300 KB) for the Customer Portal's home-page slider
  // and event cards — separate from `image`, which is a small thumbnail.
  sliderImage: { type: String, default: null },

  category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
  subCategory: { type: mongoose.Schema.Types.ObjectId, ref: "SubCategory", default: null },
  deityMapping: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Deity" }], default: [] },

  // SINGLE: one date. MULTIPLE: a hand-picked set of dates (`eventDates`).
  // RANGE: every day from startDate to endDate. startDate/endDate are always
  // filled in (the earliest and latest date), so listing, sorting and slot
  // validation work the same whatever the type.
  dateType: { type: String, enum: ["SINGLE", "MULTIPLE", "RANGE"], default: "RANGE" },
  eventDates: { type: [Date], default: [] },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },

  isSlotRequired: { type: Boolean, default: false },
  slotDetails: { type: [slotDetailSchema], default: [] },

  salePrice: { type: Number, required: true, min: 0 },
  // The General Ledger the sale posts to - its GST Type decides the GST, exactly as for
  // Items and Services. Required when an event is created or edited; kept optional on the
  // schema only so events saved before this existed still load (see gstClassification).
  generalLedger: { type: mongoose.Schema.Types.ObjectId, ref: "GeneralLedger", default: null },
  // Legacy: events created before the General Ledger field used this APPLICABLE / EXEMPTED /
  // OUT_OF_SCOPE choice. Only read as a fallback while an event has no General Ledger yet.
  gstClassification: { type: String, default: "" },
  displayOrder: { type: Number, default: 1 },

  isFamilyMembersRequired: { type: Boolean, default: false },
  maxFamilyMembers: { type: Number, default: 2 },
  termsAndConditions: { type: String, default: "" },

  posVisibility: { type: Boolean, default: true },
  publicVisibility: { type: Boolean, default: true },
  // Shown on the Admin Panel's Booking screen. POS reads posVisibility, the Customer Portal publicVisibility.
  adminBookingVisibility: { type: Boolean, default: true },
});

eventSchema.plugin(auditablePlugin);

eventSchema.index({ code: 1 }, activeUniqueIndexOptions({ collation: { locale: "en", strength: 2 } }));
eventSchema.index({ status: 1, createdAt: -1 });
eventSchema.index({ startDate: 1, endDate: 1 });

// Every ref field indexed — Mongoose doesn't index a `ref` automatically.
eventSchema.index({ category: 1 });
eventSchema.index({ generalLedger: 1 });
eventSchema.index({ subCategory: 1 });
eventSchema.index({ deityMapping: 1 });

module.exports = mongoose.model("Event", eventSchema);
