const mongoose = require("mongoose");
const { auditablePlugin, activeUniqueIndexOptions } = require("../../common/plugins/auditable");

/**
 * A General Item is sold at a price typed in by the cashier at the point of
 * sale (a saree, an old deity photo, etc.) — unlike Item/Service, it
 * deliberately carries NO salePrice field, so nothing server-side can ever
 * fall back to a master price that doesn't exist. See controllers/pos
 * cartLineSchema's manualUnitPrice for where the typed amount comes in.
 *
 * Same (category, subCategory) pairing shape as Item/Service — reuses the
 * existing Category/SubCategory masters rather than a parallel set.
 */
const categoryDetailSchema = new mongoose.Schema(
  {
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    subCategory: { type: mongoose.Schema.Types.ObjectId, ref: "SubCategory" },
    displayOrder: { type: Number, default: 0 },
  },
  { _id: false }
);

const generalItemSchema = new mongoose.Schema({
  code: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, required: true, trim: true },
  tamilName: { type: String, default: "" },
  // GST rate source for the manually-entered amount — see gst-rate.js.
  generalLedger: { type: mongoose.Schema.Types.ObjectId, ref: "GeneralLedger", required: true },
  // No deity mapping for General Items, so — unlike Item/Service — this is
  // always required, never conditional on a mapping toggle.
  printingGroup: { type: mongoose.Schema.Types.ObjectId, ref: "PrintingGroup", required: true },
  description: { type: String, default: "" },
  image: { type: String, default: null }, // full Cloudinary secure_url
  // Print this record's picture under it on the ticket (also needs "Print image on ticket" = Yes in Print Split Setting).
  printImage: { type: Boolean, default: false },
  // The picture printed on the ticket (its own upload, separate from `image`, the card picture). full Cloudinary secure_url
  ticketImage: { type: String, default: null },
  color: { type: String, default: "" },

  categoryDetails: { type: [categoryDetailSchema], default: [] },

  isInventoryApplicable: { type: Boolean, default: false },
  unitOfMeasure: { type: String, default: null },
  threshold: { type: Number, default: 0 },
  minQuantity: { type: Number, default: 1 },
  maxQuantity: { type: Number, default: 0 }, // 0 = unlimited
  quantityReduction: { type: Number, default: 1 },
  currentStock: { type: Number, default: 0, min: 0 },
  // Units held by pending bookings (open reservations). Moved only by the atomic reserve/release/consume helpers in
  // common/utils/inventory-stock.js. Available to book = currentStock - reservedStock - threshold.
  reservedStock: { type: Number, default: 0, min: 0 },

  posAvailability: { type: Boolean, default: true },
  // Independent of posAvailability — gates the Admin Booking Panel's own
  // catalogue separately from the POS counter (see
  // common/utils/pos-catalogue-visibility.js). No customerPortalAvailability
  // — General Items are POS + Admin Booking only, never Customer Portal.
  adminBookingVisibility: { type: Boolean, default: true },
  // Marks this General Item as a quick-access favourite — surfaced by the
  // POS Portal's static "Favorites" tab, same as Item/Service/Category.
  favorite: { type: Boolean, default: false },
});

generalItemSchema.plugin(auditablePlugin);

generalItemSchema.index({ code: 1 }, activeUniqueIndexOptions({ collation: { locale: "en", strength: 2 } }));
generalItemSchema.index({ status: 1, createdAt: -1 });
generalItemSchema.index({ status: 1, posAvailability: 1, name: 1 });
generalItemSchema.index({ status: 1, posAvailability: 1, favorite: 1, name: 1 });
generalItemSchema.index({ status: 1, adminBookingVisibility: 1, name: 1 });
generalItemSchema.index({ generalLedger: 1 });
generalItemSchema.index({ printingGroup: 1 });
generalItemSchema.index({ "categoryDetails.category": 1 });
generalItemSchema.index({ "categoryDetails.subCategory": 1 });

module.exports = mongoose.model("GeneralItem", generalItemSchema);
