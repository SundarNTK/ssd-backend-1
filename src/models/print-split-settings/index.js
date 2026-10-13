const mongoose = require("mongoose");
const { auditablePlugin } = require("../../common/plugins/auditable");

/**
 * Singleton — exactly one document ever exists in this collection. Decides
 * how POS ticket printing splits a booking's lines into physical tickets:
 *
 *   DEITY_WISE       — one ticket per deity, regardless of Print Group.
 *   PRINT_GROUP_WISE — one ticket per resolved Print Group (the default —
 *                      matches how Deity/Service.printingGroup was already
 *                      designed to be used before this master existed).
 *
 * See common/utils/ticket-grouping.js for where this value is actually
 * consumed — this model only stores the choice. Not a list master (no
 * create/delete route — see controllers/print-split-settings), so it has no
 * `code`/`name` uniqueness concerns the way every other master here does.
 */
const printSplitSettingSchema = new mongoose.Schema({
  mode: { type: String, enum: ["DEITY_WISE", "PRINT_GROUP_WISE"], default: "PRINT_GROUP_WISE", required: true },
  // Global switch: print each offering's picture on the ticket. Off = no picture ever prints, whatever the
  // individual masters say; on = only offerings whose own master also says yes and has a picture.
  printImage: { type: Boolean, default: false },
});

printSplitSettingSchema.plugin(auditablePlugin);

module.exports = mongoose.model("PrintSplitSetting", printSplitSettingSchema);
