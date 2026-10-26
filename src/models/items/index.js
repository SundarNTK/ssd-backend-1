const mongoose = require("mongoose");
const { auditablePlugin, activeUniqueIndexOptions } = require("../../common/plugins/auditable");

/**
 * One (category, subCategory) pairing per row, with its own display order —
 * an item can sit under several category/sub-category combinations at
 * once (e.g. shown under both "Pooja Items" and "Festival Specials").
 *
 * subCategory is optional: a row can map an item to a Category alone, with
 * no specific SubCategory. The POS Portal has nowhere to file that into as
 * a folder, so it surfaces it directly in that category's listing instead
 * (see controllers/pos getCatalogue).
 */
const categoryDetailSchema = new mongoose.Schema(
  {
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    subCategory: { type: mongoose.Schema.Types.ObjectId, ref: "SubCategory" },
    displayOrder: { type: Number, default: 0 },
  },
  { _id: false }
);

const itemSchema = new mongoose.Schema({
  code: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, required: true, trim: true },
  tamilName: { type: String, default: "" },
  generalLedger: { type: mongoose.Schema.Types.ObjectId, ref: "GeneralLedger", required: true },
  salePrice: { type: Number, required: true, min: 0 },
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

  isInventoryApplicable: { type: Boolean, default: false },
  unitOfMeasure: { type: String, default: null },
  threshold: { type: Number, default: 0 },
  minQuantity: { type: Number, default: 1 },
  maxQuantity: { type: Number, default: 0 }, // 0 = unlimited, matching the reference screenshot's "0 - unlimited" note
  quantityReduction: { type: Number, default: 1 },
  // Live on-hand quantity — moved only by POST /inventory/adjustments
  // (models/inventory-adjustments), never edited directly through the Item
  // master form.
  currentStock: { type: Number, default: 0, min: 0 },
  // Units held by pending bookings (open reservations). Moved only by the atomic reserve/release/consume helpers in
  // common/utils/inventory-stock.js. Available to book = currentStock - reservedStock - threshold.
  reservedStock: { type: Number, default: 0, min: 0 },

  // Cut-off Required: Yes needs the date and stops booking after it; No = no cut-off. Unset on older records (they follow their date).
  cutoffRequired: { type: Boolean },
  futureBookingCutOffDate: { type: Date, default: null },
  isFamilyMembersRequired: { type: Boolean, default: false },
  maxFamilyMembers: { type: Number, default: 2 },
  posAvailability: { type: Boolean, default: true },
  customerPortalAvailability: { type: Boolean, default: true },
  // Independent of posAvailability — gates the Admin Booking Panel's own
  // catalogue separately from the POS counter (see
  // common/utils/pos-catalogue-visibility.js).
  adminBookingVisibility: { type: Boolean, default: true },
  // Marks this item as a quick-access favourite — surfaced by the POS
  // Portal's static "Favorites" tab, ahead of "All Categories".
  favorite: { type: Boolean, default: false },
});

itemSchema.plugin(auditablePlugin);

itemSchema.index({ code: 1 }, activeUniqueIndexOptions({ collation: { locale: "en", strength: 2 } }));
// No two live items share a name (any letter case); a deleted item frees its name. See also makeCrudController's uniqueNames check, which gives the friendly message.
itemSchema.index({ name: 1 }, activeUniqueIndexOptions({ collation: { locale: "en", strength: 2 } }));
itemSchema.index({ status: 1, createdAt: -1 });
// Matches the POS catalogue's actual query shape exactly (controllers/pos
// listPosItems/getCatalogue: filter on status + posAvailability, sort by
// name) — without this, Mongo could only use the index above as a partial
// prefix match on `status` and had to filter posAvailability and sort by
// name in memory on every request. Harmless against a small local dataset,
// but a real cost once the database is a network hop away (Atlas) instead
// of on the same machine as the backend.
itemSchema.index({ status: 1, posAvailability: 1, name: 1 });
// Backs the POS Portal's Favorites tab (GET /pos/booking/items?favorite=true) —
// same filter + sort shape as the index above, with favorite as the extra
// equality filter.
itemSchema.index({ status: 1, posAvailability: 1, favorite: 1, name: 1 });
// Matches the Admin Booking Panel's catalogue query shape (controllers/pos
// listPosItems when req.posPortal === "admin") — same reasoning as the
// posAvailability index above, keyed on adminBookingVisibility instead.
itemSchema.index({ status: 1, adminBookingVisibility: 1, name: 1 });

// Every ref field indexed, including inside the categoryDetails array —
// Mongoose supports indexing a dotted path into an array of subdocuments,
// and this is exactly what a future "items in this category" catalog
// screen (and the POS/customer-portal browsing screens) will filter by.
itemSchema.index({ generalLedger: 1 });
itemSchema.index({ printingGroup: 1 });
itemSchema.index({ deityMapping: 1 });
itemSchema.index({ "categoryDetails.category": 1 });
itemSchema.index({ "categoryDetails.subCategory": 1 });

module.exports = mongoose.model("Item", itemSchema);
