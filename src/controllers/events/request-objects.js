const Joi = require("joi");
const { GST_CLASSIFICATIONS } = require("../../utilities/constants/gst-classifications");

const DATE_TYPES = ["SINGLE", "MULTIPLE", "RANGE"];

const objectId = Joi.string().hex().length(24);

const slotDetailEntry = Joi.object({
  slotName: Joi.string().trim().min(1).max(100).required(),
  date: Joi.date().required(),
  startTime: Joi.string().trim().min(1).max(10).required(),
  endTime: Joi.string().trim().min(1).max(10).required(),
  totalSeats: Joi.number().integer().min(1).required(), // a slot needs at least 1 seat
  bookedSeats: Joi.number().integer().min(0).default(0), // ignored - the server owns the seat counters
  heldSeats: Joi.number().integer().min(0).default(0), // ignored - the server owns the seat counters
  status: Joi.number().valid(0, 1).default(1),
});

const createSchema = Joi.object({
  code: Joi.string().trim().min(1).max(30).required(),
  name: Joi.string().trim().min(1).max(150).required(),
  tamilName: Joi.string().allow("").default(""),
  description: Joi.string().allow("").default(""),
  image: Joi.string().allow("", null).default(null),
  printImage: Joi.boolean().default(false),
  ticketImage: Joi.string().allow("", null).default(null),
  sliderImage: Joi.string().allow("", null).default(null),

  category: objectId.required(),
  subCategory: objectId.allow(null).default(null),
  deityMapping: Joi.array().items(objectId).default([]),

  dateType: Joi.string().valid(...DATE_TYPES).default("RANGE"),
  eventDates: Joi.array().items(Joi.date()).default([]),
  startDate: Joi.date().required(),
  endDate: Joi.date().required(),

  isSlotRequired: Joi.boolean().default(false),
  slotDetails: Joi.array().items(slotDetailEntry).default([]),

  salePrice: Joi.number().min(0.01).required(), // must be greater than 0
  generalLedger: objectId.required(),
  gstClassification: Joi.string().valid(...GST_CLASSIFICATIONS).allow("").default(""), // legacy - see models/events
  displayOrder: Joi.number().integer().min(0).default(1),

  isFamilyMembersRequired: Joi.boolean().default(false),
  maxFamilyMembers: Joi.number().integer().min(1).default(2),
  termsAndConditions: Joi.string().allow("").default(""),

  posVisibility: Joi.boolean().default(true),
  publicVisibility: Joi.boolean().default(true),
  adminBookingVisibility: Joi.boolean().default(true),

  status: Joi.number().valid(0, 1).default(1),
});

const updateSchema = Joi.object({
  code: Joi.string().trim().min(1).max(30),
  name: Joi.string().trim().min(1).max(150),
  tamilName: Joi.string().allow(""),
  description: Joi.string().allow(""),
  image: Joi.string().allow("", null),
  printImage: Joi.boolean(),
  ticketImage: Joi.string().allow("", null),
  sliderImage: Joi.string().allow("", null),

  category: objectId,
  subCategory: objectId.allow(null),
  deityMapping: Joi.array().items(objectId),

  dateType: Joi.string().valid(...DATE_TYPES),
  eventDates: Joi.array().items(Joi.date()),
  startDate: Joi.date(),
  endDate: Joi.date(),

  isSlotRequired: Joi.boolean(),
  slotDetails: Joi.array().items(slotDetailEntry),

  salePrice: Joi.number().min(0.01), // must be greater than 0
  generalLedger: objectId,
  gstClassification: Joi.string().valid(...GST_CLASSIFICATIONS).allow(""),
  displayOrder: Joi.number().integer().min(0),

  isFamilyMembersRequired: Joi.boolean(),
  maxFamilyMembers: Joi.number().integer().min(1),
  termsAndConditions: Joi.string().allow(""),

  posVisibility: Joi.boolean(),
  publicVisibility: Joi.boolean(),
  adminBookingVisibility: Joi.boolean(),

  status: Joi.number().valid(0, 1),
});

module.exports = { createSchema, updateSchema };
