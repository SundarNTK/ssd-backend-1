const Joi = require("joi");

/**
 * PUT /masters/print-split-setting
 * Only `mode` is ever written — there's no `code`/`name`/`status` the way
 * every other master's update schema carries, because this isn't a list
 * record (see models/print-split-settings' own comment).
 */
const updateSchema = Joi.object({
  mode: Joi.string().valid("DEITY_WISE", "PRINT_GROUP_WISE").required(),
  printImage: Joi.boolean(),
});

module.exports = { updateSchema };
