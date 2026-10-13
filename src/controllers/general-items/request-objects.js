const Joi = require("joi");

const objectId = Joi.string().hex().length(24);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

// Sourced from the Unit master (see models/units) as its unitCode — see
// controllers/items/request-objects.js's matching field for the full
// rationale, unchanged here.
const unitOfMeasureField = Joi.string().trim().max(20);

// subCategory is optional — a row can map a General Item to a Category
// alone, with no specific SubCategory (see models/general-items).
const categoryDetailEntry = Joi.object({
  category: objectId.required(),
  subCategory: objectId.allow(null),
  displayOrder: Joi.number().integer().min(0).default(0),
});

const createSchema = Joi.object({
  code: Joi.string().trim().min(1).max(30).required(),
  name: Joi.string().trim().min(1).max(150).required(),
  tamilName: Joi.string().allow("").default(""),
  generalLedger: objectId.required(),
  printingGroup: objectId.required(),
  description: Joi.string().allow("").default(""),
  image: Joi.string().allow("", null).default(null),
  printImage: Joi.boolean().default(false),
  ticketImage: Joi.string().allow("", null).default(null),
  color: Joi.string().trim().pattern(HEX_COLOR).allow("").default(""),

  categoryDetails: Joi.array().items(categoryDetailEntry).default([]),

  isInventoryApplicable: Joi.boolean().default(false),
  unitOfMeasure: unitOfMeasureField.allow(null).default(null),
  threshold: Joi.number().integer().min(0).default(0),
  minQuantity: Joi.number().integer().min(1).default(1),
  maxQuantity: Joi.number().integer().min(0).default(0),
  quantityReduction: Joi.number().integer().min(1).default(1),

  posAvailability: Joi.boolean().default(true),
  adminBookingVisibility: Joi.boolean().default(true),
  favorite: Joi.boolean().default(false),

  status: Joi.number().valid(0, 1).default(1),
});

const updateSchema = Joi.object({
  code: Joi.string().trim().min(1).max(30),
  name: Joi.string().trim().min(1).max(150),
  tamilName: Joi.string().allow(""),
  generalLedger: objectId,
  printingGroup: objectId,
  description: Joi.string().allow(""),
  image: Joi.string().allow("", null),
  printImage: Joi.boolean(),
  ticketImage: Joi.string().allow("", null),
  color: Joi.string().trim().pattern(HEX_COLOR).allow(""),

  categoryDetails: Joi.array().items(categoryDetailEntry),

  isInventoryApplicable: Joi.boolean(),
  unitOfMeasure: unitOfMeasureField.allow(null),
  threshold: Joi.number().integer().min(0),
  minQuantity: Joi.number().integer().min(1),
  maxQuantity: Joi.number().integer().min(0),
  quantityReduction: Joi.number().integer().min(1),

  posAvailability: Joi.boolean(),
  adminBookingVisibility: Joi.boolean(),
  favorite: Joi.boolean(),

  status: Joi.number().valid(0, 1),
});

module.exports = { createSchema, updateSchema };
