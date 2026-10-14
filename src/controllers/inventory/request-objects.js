const Joi = require("joi");

const objectId = Joi.string().hex().length(24);

// Whole units only, 1 - 1,000,000. `.strict()` refuses "5" / "abc" / "" so only a real number gets through.
const quantity = Joi.number().strict().integer().min(1).max(1000000).required().messages({
  "number.base": "Quantity must be a number.",
  "number.integer": "Quantity must be a whole number.",
  "number.min": "Quantity must be at least 1.",
  "number.max": "Quantity is too large.",
});

const adjustmentEntry = Joi.object({
  refType: Joi.string().valid("Item", "Service", "GeneralItem").required(),
  refId: objectId.required(),
  inventoryType: Joi.string().valid("Stock In", "Stock Out").required(),
  quantity,
  remarks: Joi.string().trim().max(300).allow("").default(""),
});

/** POST /inventory/adjustments - one row (kept for the Inventory Adjustment form). */
const createAdjustmentSchema = adjustmentEntry.keys({
  // Lets a retried request be recognised; a fresh one is generated when the client sends none.
  requestId: Joi.string().trim().min(8).max(100),
});

/** POST /inventory/adjustments/batch - everything the user queued, applied together (all rows or none). */
const batchAdjustmentSchema = Joi.object({
  batchId: Joi.string().trim().min(8).max(100).required(),
  adjustments: Joi.array().items(adjustmentEntry).min(1).max(200).required(),
});

const itemRef = {
  refType: Joi.string().valid("Item", "Service", "GeneralItem").required(),
  refId: objectId.required(),
};
const optionalRequestId = Joi.string().trim().min(8).max(100);

/** POST /inventory/pending - queue a stock in / stock out on an item's entered count (nothing is applied). */
const queuePendingSchema = Joi.object({ ...itemRef, mode: Joi.string().valid("in", "out").required(), quantity, requestId: optionalRequestId });

/** POST /inventory/pending/apply - "Add to Adjust": apply the item's queued count. The request id makes a retry harmless. */
const applyPendingSchema = Joi.object({ ...itemRef, requestId: optionalRequestId.required() });

/** POST /inventory/pending/clear */
const clearPendingSchema = Joi.object({ ...itemRef });

module.exports = { createAdjustmentSchema, batchAdjustmentSchema, queuePendingSchema, applyPendingSchema, clearPendingSchema };
