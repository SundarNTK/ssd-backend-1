const mongoose = require("mongoose");
const { auditablePlugin, activeUniqueIndexOptions } = require("../../common/plugins/auditable");

/**
 * A fixed set of payment channels (Cash, PayNow, DBS, NETS, ...) rather than
 * an admin-authored list — records come from seed/seedPaymentModes.js, and
 * the Payment Mode Master only lets an admin view and edit them (no
 * create/delete route — see controllers/payment-modes).
 */
const paymentModeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: "" },
  // Same Temple POS / Customer POS visibility pairing every other master
  // with a public-facing side uses (see e.g. models/categories'
  // posVisibility/customerPortalVisibility) — posAvailability gates the
  // actual counter payment-mode boxes (see controllers/pos's
  // listPaymentModes); publicAvailability is the customer-facing
  // equivalent, not yet consumed anywhere since the Customer Portal has no
  // built checkout yet (app/customer/page.tsx is still a placeholder).
  posAvailability: { type: Boolean, default: true },
  publicAvailability: { type: Boolean, default: true },
  // Offered on the Admin Panel's Booking screen (records saved before this flag count as visible).
  adminBookingVisibility: { type: Boolean, default: true },
});

paymentModeSchema.plugin(auditablePlugin);

paymentModeSchema.index({ name: 1 }, activeUniqueIndexOptions({ collation: { locale: "en", strength: 2 } }));
paymentModeSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("PaymentMode", paymentModeSchema);
