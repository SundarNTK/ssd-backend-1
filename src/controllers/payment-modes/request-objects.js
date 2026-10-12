const Joi = require("joi");

// No createSchema — payment modes are seeded (see seed/seedPaymentModes.js),
// not created through the API. Only PUT /payment-modes/:id exists.
const updateSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100),
  description: Joi.string().allow(""),
  posAvailability: Joi.boolean(),
  adminBookingVisibility: Joi.boolean(),
  publicAvailability: Joi.boolean(),
  status: Joi.number().valid(0, 1),
});

module.exports = { updateSchema };
