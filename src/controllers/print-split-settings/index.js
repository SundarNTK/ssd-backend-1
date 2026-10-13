/**
 * Print Split Setting — a singleton master (exactly one document), not a
 * list, so this deliberately does NOT use common/factories/crud-controller:
 * that factory is list/pagination-oriented (list/create/update-by-id/
 * soft-delete) and has no id-less get/upsert operation, and its create()
 * would happily insert a second document, defeating "singleton". Two
 * handlers instead, both id-less.
 *
 * GET self-heals — if no document exists yet (fresh install, seed script
 * never ran) it creates the default (PRINT_GROUP_WISE) rather than 404ing,
 * so the admin page always has something to render. See
 * seed/seedPrintSplitSetting.js for the equivalent explicit seed, kept for
 * parity with how every other master's defaults are seeded.
 */
const express = require("express");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");
const PrintSplitSetting = require("../../models/print-split-settings");
const { updateSchema } = require("./request-objects");

async function getSetting(req, res) {
  try {
    let doc = await PrintSplitSetting.findOne({});
    if (!doc) doc = await PrintSplitSetting.create({ mode: "PRINT_GROUP_WISE" });
    return responseHandler({ res, response: doc });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

async function updateSetting(req, res) {
  try {
    const doc = await PrintSplitSetting.findOneAndUpdate(
      {},
      {
        mode: req.body.mode,
        ...(req.body.printImage !== undefined ? { printImage: req.body.printImage } : {}),
        updatedBy: req.auth?.userId || null,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return responseHandler({ res, response: doc, successMessage: "Print split setting updated successfully." });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

// Mounted at /masters — see routes/index.js (authGuard/adminOnly applied
// once for the whole /masters group there, not per master).
const router = express.Router();

router.get("/print-split-setting", requirePermission("print-split-setting", "view"), getSetting);
router.put(
  "/print-split-setting",
  requirePermission("print-split-setting", "edit"),
  validateBody(updateSchema),
  updateSetting
);

module.exports = router;
module.exports.getSetting = getSetting;
module.exports.updateSetting = updateSetting;
