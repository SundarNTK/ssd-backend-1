const mongoose = require("mongoose");
const { auditablePlugin, activeUniqueIndexOptions } = require("../../common/plugins/auditable");

/**
 * One (category, subCategory) pairing per row, with its own display order —
 * a service can be sold under several category/sub-category combinations
 * at once (e.g. a pooja listed under both "Daily Pooja" and "Festival
 * Special"). Price is a single service-level figure (see Service.salePrice
 * below), not per pairing — a service costs the same no matter which
 * category/sub-category it's found under, the same way Item.salePrice works.
 *
 * subCategory is optional: a row can map a service to a Category alone,
 * with no specific SubCategory. The POS Portal has nowhere to file that
 * into as a folder, so it surfaces it directly in that category's listing
 * instead (see controllers/pos getCatalogue).
 */
const categoryDetailSchema = new mongoose.Schema(
  {
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    subCategory: { type: mongoose.Schema.Types.ObjectId, ref: "SubCategory" },
    displayOrder: { type: Number, default: 1 },
  },
  { _id: false }
);

const serviceSchema = new mongoose.Schema({
  code: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, required: true, trim: true },
  tamilName: { type: String, default: "" },
  description: { type: String, default: "" },
  image: { type: String, default: null }, // full Cloudinary secure_url
  // Print this record's picture under it on the ticket (also needs "Print image on ticket" = Yes in Print Split Setting).
  printImage: { type: Boolean, default: false },
  // Session rule: a master with sessionRequired is booked for a day, today up to its Future Booking Cut-off Date (common/utils/session-rule.js).
  sessionRequired: { type: Boolean, default: false },
  // Which halves of the day can be booked when sessionRequired: any of "AM" / "PM" (required then, empty otherwise).
  availableSessions: { type: [{ type: String, enum: ["AM", "PM"] }], default: [] },
  recurringRequired: { type: Boolean, default: false },
  // The picture printed on the ticket (its own upload, separate from `image`, the card picture). full Cloudinary secure_url
  ticketImage: { type: String, default: null },
  // Optional hex card colour ("" = use the POS default theme).
  color: { type: String, default: "" },

  isDeityMappingRequired: { type: Boolean, default: false },
  deityMapping: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Deity" }], default: [] },
  // Required when isDeityMappingRequired is false. When mapping is on, the
  // print group comes from the selected deity (Deity.printingGroup) instead.
  printingGroup: { type: mongoose.Schema.Types.ObjectId, ref: "PrintingGroup", default: null },

  categoryDetails: { type: [categoryDetailSchema], default: [] },

  generalLedger: { type: mongoose.Schema.Types.ObjectId, ref: "GeneralLedger", required: true },
  salePrice: { type: Number, required: true, min: 0, default: 0 },

  isFamilyMembersRequired: { type: Boolean, default: false },
  maxFamilyMembers: { type: Number, default: 2 },


  isInventoryRequired: { type: Boolean, default: false },
  thresholdCount: { type: Number, default: 0 },
  // Live on-hand quantity — moved only by POST /inventory/adjustments
  // (models/inventory-adjustments), never edited directly through the
  // Service master form.
  currentStock: { type: Number, default: 0, min: 0 },
  // Units held by pending bookings (open reservations). Moved only by the atomic reserve/release/consume helpers in
  // common/utils/inventory-stock.js. Available to book = currentStock - reservedStock - threshold.
  reservedStock: { type: Number, default: 0, min: 0 },

  bookingCutoffDate: { type: Date, default: null },
  // Quantity a booking starts at / cannot go below, and the most that can be booked per line (0 = no limit: older records).
  minQuantity: { type: Number, default: 1 },
  maxQuantity: { type: Number, default: 0 },
  isPosAvailable: { type: Boolean, default: true },
  publicAvailability: { type: Boolean, default: true },
  // Independent of isPosAvailable — gates the Admin Booking Panel's own
  // catalogue separately from the POS counter (see
  // common/utils/pos-catalogue-visibility.js).
  adminBookingVisibility: { type: Boolean, default: true },
  // Marks this service as a quick-access favourite — surfaced by the POS
  // Portal's static "Favorites" tab, ahead of "All Categories".
  favorite: { type: Boolean, default: false },
});

serviceSchema.plugin(auditablePlugin);

serviceSchema.index({ code: 1 }, activeUniqueIndexOptions({ collation: { locale: "en", strength: 2 } }));
// No two live services share a name (any letter case); a deleted service frees its name. See also makeCrudController's uniqueNames check, which gives the friendly message.
serviceSchema.index({ name: 1 }, activeUniqueIndexOptions({ collation: { locale: "en", strength: 2 } }));
serviceSchema.index({ status: 1, createdAt: -1 });
// Same reasoning as Item's matching index — covers listPosServices/
// getCatalogue's actual filter (status + isPosAvailable) and sort (name) in
// one index instead of an in-memory sort on every request.
serviceSchema.index({ status: 1, isPosAvailable: 1, name: 1 });
// Backs the POS Portal's Favorites tab (GET /pos/booking/services?favorite=true).
serviceSchema.index({ status: 1, isPosAvailable: 1, favorite: 1, name: 1 });
// Matches the Admin Booking Panel's catalogue query shape (controllers/pos
// listPosServices when req.posPortal === "admin").
serviceSchema.index({ status: 1, adminBookingVisibility: 1, name: 1 });

// Every ref field indexed, including inside the categoryDetails array and the
// deityMapping array — Mongoose supports indexing a dotted/array path into
// subdocuments, and future "services under this category" / "services for
// this deity" screens will filter by exactly these.
serviceSchema.index({ generalLedger: 1 });
serviceSchema.index({ printingGroup: 1 });
serviceSchema.index({ deityMapping: 1 });
serviceSchema.index({ "categoryDetails.category": 1 });
serviceSchema.index({ "categoryDetails.subCategory": 1 });

module.exports = mongoose.model("Service", serviceSchema);
