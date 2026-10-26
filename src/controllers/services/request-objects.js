const Joi = require("joi");

const objectId = Joi.string().hex().length(24);
// AM / PM, multi-select; unique. Whether it must be non-empty (sessionRequired = Yes) is checked by requireSessionCutoff.
const sessionsField = Joi.array().items(Joi.string().valid("AM", "PM")).unique();
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

// subCategory is optional — a row can map a service to a Category alone,
// with no specific SubCategory (see models/services categoryDetailSchema).
// Price lives on the Service itself (see createSchema/updateSchema below),
// not per row — a service costs the same under every category it's in.
const categoryDetailEntry = Joi.object({
  category: objectId.required(),
  subCategory: objectId.allow(null),
  displayOrder: Joi.number().integer().min(0).default(1),
});

// deityMapping is only meaningful (and only required) once
// isDeityMappingRequired is turned on — otherwise it's cleared to [].
// Create always sends a full object, so a missing key safely defaults to [].
// Update must NOT apply that default: validateBody() fills in .default()
// for any key absent from the request body, and crud.update() spreads the
// whole validated body into findOneAndUpdate — so a partial PUT that
// doesn't mention deityMapping would silently blank out an existing
// mapping. Leaving it undefined on update means "not part of this PUT",
// so the existing value in the DB is left untouched.
const deityMappingField = Joi.array()
  .items(objectId)
  .when("isDeityMappingRequired", {
    is: true,
    then: Joi.array().min(1).required(),
    otherwise: Joi.array().default([]),
  });

const deityMappingFieldForUpdate = Joi.array()
  .items(objectId)
  .when("isDeityMappingRequired", {
    is: true,
    then: Joi.array().min(1).required(),
    otherwise: Joi.array(),
  });

// Printing group is entered on the service only when deity mapping is off.
// When mapping is on, the selected deity's Deity Master printing group is
// used instead — any value the client still sends is discarded.
const printingGroupWhenDeityMapped = Joi.any().custom(() => null);

const printingGroupField = Joi.when("isDeityMappingRequired", {
  is: true,
  then: printingGroupWhenDeityMapped.default(null),
  otherwise: objectId.required(),
});

const printingGroupFieldForUpdate = Joi.when("isDeityMappingRequired", {
  is: true,
  then: printingGroupWhenDeityMapped,
  otherwise: objectId,
});

const createSchema = Joi.object({
  code: Joi.string().trim().min(1).max(30).required(),
  name: Joi.string().trim().min(1).max(150).required(),
  tamilName: Joi.string().allow("").default(""),
  description: Joi.string().allow("").default(""),
  image: Joi.string().allow("", null).default(null),
  printImage: Joi.boolean().default(false),
  sessionRequired: Joi.boolean().default(false),
  availableSessions: sessionsField,
  recurringRequired: Joi.boolean().default(false),
  ticketImage: Joi.string().allow("", null).default(null),
  color: Joi.string().trim().pattern(HEX_COLOR).allow("").default(""),

  isDeityMappingRequired: Joi.boolean().default(false),
  deityMapping: deityMappingField,
  printingGroup: printingGroupField,

  // Mandatory: at least one Category (Sub Category stays optional).
  categoryDetails: Joi.array().items(categoryDetailEntry).min(1).required().messages({ "array.min": "At least one Category is required.", "any.required": "At least one Category is required." }),

  generalLedger: objectId.required(),
  salePrice: Joi.number().min(0.01).required(), // must be greater than 0

  isFamilyMembersRequired: Joi.boolean().default(false),
  maxFamilyMembers: Joi.number().integer().min(1).default(2),


  isInventoryRequired: Joi.boolean().default(false),
  thresholdCount: Joi.number().integer().min(1).default(1).messages({ "number.min": "Threshold must be at least 1." }),

  // Mandatory: the last day this service can be booked (it is hidden from booking afterwards).
  cutoffRequired: Joi.boolean().default(true),
  bookingCutoffDate: Joi.date().when("cutoffRequired", { is: false, then: Joi.date().allow(null).default(null), otherwise: Joi.date().required() }),
  minQuantity: Joi.number().integer().min(1).required(),
  maxQuantity: Joi.number().integer().min(Joi.ref("minQuantity")).required().messages({ "number.min": "Max Quantity cannot be less than Min Quantity." }),
  isPosAvailable: Joi.boolean().default(true),
  publicAvailability: Joi.boolean().default(true),
  adminBookingVisibility: Joi.boolean().default(true),
  favorite: Joi.boolean().default(false),

  status: Joi.number().valid(0, 1).default(1),
});

const updateSchema = Joi.object({
  code: Joi.string().trim().min(1).max(30),
  name: Joi.string().trim().min(1).max(150),
  tamilName: Joi.string().allow(""),
  description: Joi.string().allow(""),
  image: Joi.string().allow("", null),
  printImage: Joi.boolean(),
  sessionRequired: Joi.boolean(),
  availableSessions: sessionsField,
  recurringRequired: Joi.boolean(),
  ticketImage: Joi.string().allow("", null),
  color: Joi.string().trim().pattern(HEX_COLOR).allow(""),

  isDeityMappingRequired: Joi.boolean(),
  deityMapping: deityMappingFieldForUpdate,
  printingGroup: printingGroupFieldForUpdate,

  categoryDetails: Joi.array().items(categoryDetailEntry).min(1).messages({ "array.min": "At least one Category is required." }),

  generalLedger: objectId,
  salePrice: Joi.number().min(0.01), // must be greater than 0

  isFamilyMembersRequired: Joi.boolean(),
  maxFamilyMembers: Joi.number().integer().min(1),


  isInventoryRequired: Joi.boolean(),
  thresholdCount: Joi.number().integer().min(1).messages({ "number.min": "Threshold must be at least 1." }),

  cutoffRequired: Joi.boolean(),
  bookingCutoffDate: Joi.date().allow(null),
  minQuantity: Joi.number().integer().min(1),
  maxQuantity: Joi.number().integer().min(1),
  isPosAvailable: Joi.boolean(),
  publicAvailability: Joi.boolean(),
  adminBookingVisibility: Joi.boolean(),
  favorite: Joi.boolean(),

  status: Joi.number().valid(0, 1),
});

module.exports = { createSchema, updateSchema };
