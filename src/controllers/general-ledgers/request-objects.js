const Joi = require("joi");
const { GST_TYPES } = require("../../utilities/constants/gst-types");

const objectId = Joi.string().hex().length(24);
// Older saved labels ("Standard GST") are normalized to the official name
// in the controller (canonicalGstType) before this ever runs on read, but
// still need to validate on the way in for legacy client payloads.
const gstTypeField = Joi.string().valid(...GST_TYPES, "Standard GST");

// groupLevel2 only makes sense once groupLevel1 is chosen, groupLevel3 only
// once groupLevel2 is chosen — same chain GL Group's own Level 2/3 forms
// enforce, mirrored here since a GL account drills into the same tree.
const createSchema = Joi.object({
  name: Joi.string().trim().min(1).max(150).required(),
  code: Joi.string().trim().min(1).max(30).required(),
  gstType: gstTypeField.required(),
  groupLevel1: objectId.required(),
  groupLevel2: objectId.allow(null).default(null),
  // Without a Level 2 there can be no Level 3, but the form always sends groupLevel3 (null when empty), so null is fine - only a real id is refused.
  groupLevel3: objectId.allow(null).when("groupLevel2", { is: Joi.exist().not(null), then: Joi.optional(), otherwise: Joi.valid(null) }).default(null),
  description: Joi.string().allow("").default(""),
  status: Joi.number().valid(0, 1).default(1),
});

const updateSchema = Joi.object({
  name: Joi.string().trim().min(1).max(150),
  code: Joi.string().trim().min(1).max(30),
  gstType: gstTypeField,
  groupLevel1: objectId,
  groupLevel2: objectId.allow(null),
  groupLevel3: objectId.allow(null),
  description: Joi.string().allow(""),
  status: Joi.number().valid(0, 1),
});

module.exports = { createSchema, updateSchema };
