const mongoose = require("mongoose");
const { auditablePlugin } = require("../../common/plugins/auditable");

/**
 * Singleton — exactly one document. Says how the IP allow list is applied to
 * the admin and POS sites:
 *
 *   off      the list is ignored; everyone can open the sites (the default,
 *            so deploying this feature changes nothing until it is switched on)
 *   report   nothing is blocked; visits that WOULD be blocked are logged and
 *            shown on the Access Control screen, to check the list is right
 *            before enforcing it
 *   enforce  only addresses on the list (and the server's always-allowed
 *            addresses) can open the sites; everyone else gets 403
 *
 * A server-side switch (IP_ACCESS_FORCE_OFF) overrides this to "off" for
 * emergencies — see config/env.js and common/utils/ip-access-service.js.
 */
const IP_ACCESS_MODES = ["off", "report", "enforce"];

const ipAccessSettingSchema = new mongoose.Schema({
  mode: { type: String, enum: IP_ACCESS_MODES, default: "off", required: true },
});

ipAccessSettingSchema.plugin(auditablePlugin);

module.exports = {
  IpAccessSetting: mongoose.model("IpAccessSetting", ipAccessSettingSchema, "ip_access_settings"),
  IP_ACCESS_MODES,
};
