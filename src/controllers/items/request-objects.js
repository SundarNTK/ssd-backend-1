const Joi = require("joi");

const objectId = Joi.string().hex().length(24);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

// Sourced from the Unit master (see models/units) as its unitCode — e.g.
// "UN001" — not a fixed enum. Kept a plain string (not an objectId ref) to
// match how the frontend already stores it (ItemPage.tsx's fetchUnitOptions
// comment explains why: existing item data and every other place that reads
// unitOfMeasure as a string — inventory, low-stock report, exports — keeps
// working unchanged). This used to `.valid()` against a hardcoded
// PCS/KG/GRAM/... list from before the Unit master existed, which rejected
// every real unit code the moment that master's own values (e.g. "UN001")
// stopped matching it.
const unitOfMeasureField = Joi.string().trim().max(20);

// subCategory is optional — a row can map an item to a Category alone, with
// no specific SubCategory (see models/items categoryDetailSchema).
const categoryDetailEntry = Joi.object({
  category: objectId.required(),
  subCategory: objectId.allow(null),
  displayOrder: Joi.number().integer().min(0).default(0),
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

// Printing group is entered on the item only when deity mapping is off.
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
  generalLedger: objectId.required(),
  salePrice: Joi.number().min(0.01).required(), // must be greater than 0
  description: Joi.string().allow("").default(""),
  image: Joi.string().allow("", null).default(null),
  printImage: Joi.boolean().default(false),
  sessionRequired: Joi.boolean().default(false),
  recurringRequired: Joi.boolean().default(false),
  ticketImage: Joi.string().allow("", null).default(null),
  color: Joi.string().trim().pattern(HEX_COLOR).allow("").default(""),

  isDeityMappingRequired: Joi.boolean().default(false),
  deityMapping: deityMappingField,
  printingGroup: printingGroupField,

  categoryDetails: Joi.array().items(categoryDetailEntry).default([]),

  isInventoryApplicable: Joi.boolean().default(false),
  unitOfMeasure: unitOfMeasureField.allow(null).default(null),
  threshold: Joi.number().integer().min(0).default(0),
  minQuantity: Joi.number().integer().min(1).required(),
  maxQuantity: Joi.number().integer().min(Joi.ref("minQuantity")).required().messages({ "number.min": "Max Quantity cannot be less than Min Quantity." }),
  quantityReduction: Joi.number().integer().min(1).default(1),

  // Mandatory: the last day this item can be booked (it is hidden from booking afterwards).
  futureBookingCutOffDate: Joi.date().required(),
  isFamilyMembersRequired: Joi.boolean().default(false),
  maxFamilyMembers: Joi.number().integer().min(1).default(2),
  posAvailability: Joi.boolean().default(true),
  customerPortalAvailability: Joi.boolean().default(true),
  adminBookingVisibility: Joi.boolean().default(true),
  favorite: Joi.boolean().default(false),

  status: Joi.number().valid(0, 1).default(1),
});

const updateSchema = Joi.object({
  code: Joi.string().trim().min(1).max(30),
  name: Joi.string().trim().min(1).max(150),
  tamilName: Joi.string().allow(""),
  generalLedger: objectId,
  salePrice: Joi.number().min(0.01), // must be greater than 0
  description: Joi.string().allow(""),
  image: Joi.string().allow("", null),
  printImage: Joi.boolean(),
  sessionRequired: Joi.boolean(),
  recurringRequired: Joi.boolean(),
  ticketImage: Joi.string().allow("", null),
  color: Joi.string().trim().pattern(HEX_COLOR).allow(""),

  isDeityMappingRequired: Joi.boolean(),
  deityMapping: deityMappingFieldForUpdate,
  printingGroup: printingGroupFieldForUpdate,

  categoryDetails: Joi.array().items(categoryDetailEntry),

  isInventoryApplicable: Joi.boolean(),
  unitOfMeasure: unitOfMeasureField.allow(null),
  threshold: Joi.number().integer().min(0),
  minQuantity: Joi.number().integer().min(1),
  maxQuantity: Joi.number().integer().min(1),
  quantityReduction: Joi.number().integer().min(1),

  futureBookingCutOffDate: Joi.date(),
  isFamilyMembersRequired: Joi.boolean(),
  maxFamilyMembers: Joi.number().integer().min(1),
  posAvailability: Joi.boolean(),
  customerPortalAvailability: Joi.boolean(),
  adminBookingVisibility: Joi.boolean(),
  favorite: Joi.boolean(),

  status: Joi.number().valid(0, 1),
});

module.exports = { createSchema, updateSchema };
