const Joi = require("joi");
const { IP_ACCESS_MODES } = require("../../models/ip-access-settings");

/** POST /access-control/entries — the address itself is checked in depth by common/utils/ip-access parseEntry(). */
const addSchema = Joi.object({
  ip: Joi.string().trim().max(50).required(),
  label: Joi.string().trim().allow("").max(80).default(""),
});

/** PUT /access-control/mode */
const modeSchema = Joi.object({
  mode: Joi.string().valid(...IP_ACCESS_MODES).required(),
});

module.exports = { addSchema, modeSchema };
