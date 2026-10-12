const express = require("express");
const requirePermission = require("../../common/middleware/require-permission");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");
const { checkHallAvailability } = require("../../common/utils/hall-availability");

const Hall = require("../../models/halls");
const HallPackage = require("../../models/hall-packages");
const { checkSchema } = require("./request-objects");

// Mounted at /hall-meal — see routes/index.js.
const router = express.Router();

/**
 * POST /hall-meal/availability/check
 * Resolves the requested Hall (or every Hall inside the requested Package)
 * and runs the shared overlap check against it. The same function backs
 * Hall Booking's final pre-confirm revalidation and Reschedule's
 * revalidation — see common/utils/hall-availability.js.
 */
async function checkAvailability(req, res) {
  try {
    const { error, value } = checkSchema.validate(req.body);
    if (error) throw error.details[0].message;
    const { bookingType, hallId, hallPackageId, eventDate, startTime, endTime, excludeBookingId } = value;

    let hallIds = [];
    let includedHalls = [];
    let label = null;

    if (bookingType === "individual") {
      const hall = await Hall.findOne(Hall.notDeletedFilter({ _id: hallId, status: 1 })).select("name code");
      if (!hall) throw "Hall not found or inactive.";
      hallIds = [hall._id];
      includedHalls = [{ _id: hall._id, name: hall.name, code: hall.code }];
      label = hall.name;
    } else {
      const pkg = await HallPackage.findOne(HallPackage.notDeletedFilter({ _id: hallPackageId, status: 1 })).populate(
        "halls",
        "name code"
      );
      if (!pkg) throw "Hall Package not found or inactive.";
      if (!pkg.halls.length) throw "This Hall Package has no Halls mapped to it.";
      hallIds = pkg.halls.map((h) => h._id);
      includedHalls = pkg.halls.map((h) => ({ _id: h._id, name: h.name, code: h.code }));
      label = pkg.name;
    }

    const result = await checkHallAvailability({ hallIds, eventDate, startTime, endTime, excludeBookingId });

    return responseHandler({
      res,
      response: {
        bookingType,
        label,
        includedHalls,
        eventDate,
        startTime,
        endTime,
        ...result,
      },
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 422 : undefined });
  }
}

router.post("/availability/check", requirePermission.any(["hall-bookings", "hall-availability"], "view"), checkAvailability);

module.exports = router;
