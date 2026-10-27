const mongoose = require("mongoose");
const { auditablePlugin, activeUniqueIndexOptions } = require("../../common/plugins/auditable");

/**
 * What the temple actually collected on a day, per payment mode, as counted by the person who entered it (cash in
 * hand, the NETS terminal's settlement, the PayNow bank credits). The Daily Collection Summary sets these beside what
 * the bookings say was collected, so a shortage or an excess shows up.
 *
 * One record per day per payment mode (enforced by the unique index below, not only by the controller). The date is
 * the temple's own Singapore calendar day as "YYYY-MM-DD", the same day the summary groups payments by.
 */
const dailyCollectionEntrySchema = new mongoose.Schema({
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  paymentMode: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentMode", required: true },
  // Snapshot of the mode's name, so the entry still reads right if the mode is renamed later.
  paymentModeName: { type: String, required: true, trim: true, uppercase: true },
  amount: { type: Number, required: true, min: 0 },
  remarks: { type: String, default: "", trim: true, maxlength: 300 },
});

dailyCollectionEntrySchema.plugin(auditablePlugin);

dailyCollectionEntrySchema.index({ date: 1, paymentMode: 1 }, activeUniqueIndexOptions());
dailyCollectionEntrySchema.index({ date: -1, paymentModeName: 1 });

module.exports = mongoose.model("DailyCollectionEntry", dailyCollectionEntrySchema, "daily_collection_entries");
