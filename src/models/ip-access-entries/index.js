const mongoose = require("mongoose");
const { auditablePlugin, activeUniqueIndexOptions } = require("../../common/plugins/auditable");

/**
 * One address (or small range) allowed to open the admin and POS sites.
 * Managed by a System Admin from Administration > Access Control; read on
 * every site visit by controllers/access-check. The list is short (the
 * controller caps it) so it is loaded whole and held in memory briefly.
 *
 * `ip` is stored already normalized by common/utils/ip-access's
 * parseEntry(): "203.0.113.10" or "198.51.100.0/29". `createdBy` and the
 * createdByInfo snapshot come from the shared audit plugin, so the screen
 * can show who added each entry and when.
 */
const ipAccessEntrySchema = new mongoose.Schema({
  ip: { type: String, required: true, trim: true },
  label: { type: String, default: "", trim: true, maxlength: 80 },
});

ipAccessEntrySchema.plugin(auditablePlugin);
ipAccessEntrySchema.index({ ip: 1 }, activeUniqueIndexOptions());

module.exports = {
  IpAccessEntry: mongoose.model("IpAccessEntry", ipAccessEntrySchema, "ip_access_entries"),
};
