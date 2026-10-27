const Joi = require("joi");

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const amount = Joi.number().min(0).max(9999999.99).precision(2).strict();

const entrySchema = Joi.object({
  paymentModeId: Joi.string().hex().length(24).required(),
  amount: amount.required(),
  remarks: Joi.string().trim().allow("").max(300).default(""),
});

// One day, one amount per payment mode, entered together.
const createSchema = Joi.object({
  date: Joi.string().pattern(DAY).required().messages({ "string.pattern.base": "Enter a valid date (YYYY-MM-DD)." }),
  entries: Joi.array().items(entrySchema).min(1).max(20).required(),
});

// The date and the payment mode of an entry never change; a wrong one is deleted and entered again.
const updateSchema = Joi.object({
  amount,
  remarks: Joi.string().trim().allow("").max(300),
}).min(1);

module.exports = { createSchema, updateSchema, DAY };
