const mongoose = require("mongoose");
const { exceptionHandler } = require("../../utilities/handlers");

const SESSIONS_MESSAGE = "Select at least one Available Session (AM / PM) - it is required when Session Required is Yes.";
const MESSAGE = "Enter the Future Booking Cut-off Date - it is required when Session Required is Yes.";
const CUTOFF_MESSAGE = "Enter the Future Booking Cut-off Date - it is required when Cut-off Required is Yes.";

/**
 * Item / Service / Event masters: "Session Required" = Yes needs the master's Future Booking Cut-off Date (the last
 * day a session can be booked). `field` is that date's field name on the model. Mount after validateBody.
 * Create checks the body; update judges what the record WILL look like (body value, else the saved one), and a
 * request that touches neither field is not checked.
 */
function requireSessionCutoff(Model, field) {
  const hasCutoffFlag = !!Model.schema.path("cutoffRequired");
  return async function checkSessionCutoff(req, res, next) {
    try {
      const body = req.body || {};
      if (req.method === "POST") {
        if (hasCutoffFlag) {
          // Cut-off Required = No: no cut-off at all (a stray date is dropped); Yes: the date is needed.
          if (body.cutoffRequired === false) {
            body[field] = null;
          } else if (!body[field]) {
            return exceptionHandler({ res, error: CUTOFF_MESSAGE, statusCode: 422 });
          }
        }
        if (body.sessionRequired === true && body.cutoffRequired !== false && !body[field]) {
          return exceptionHandler({ res, error: MESSAGE, statusCode: 422 });
        }
        if (Model.schema.path("availableSessions")) {
          if (body.sessionRequired === true && !body.availableSessions?.length) return exceptionHandler({ res, error: SESSIONS_MESSAGE, statusCode: 422 });
          if (body.sessionRequired !== true) body.availableSessions = [];
        }
        return next();
      }
      const hasSessions = !!Model.schema.path("availableSessions");
      if (body.sessionRequired === undefined && body[field] === undefined && body.cutoffRequired === undefined && !(hasSessions && body.availableSessions !== undefined)) return next();
      const id = req.params.id;
      const existing = mongoose.isValidObjectId(id)
        ? await Model.findOne(Model.notDeletedFilter({ _id: id })).select(`sessionRequired availableSessions cutoffRequired ${field}`)
        : null;
      const required = body.sessionRequired !== undefined ? body.sessionRequired : existing?.sessionRequired === true;
      const cutoff = body[field] !== undefined ? body[field] : existing?.[field];
      if (hasCutoffFlag) {
        const cutoffRequired = body.cutoffRequired !== undefined ? body.cutoffRequired : existing?.cutoffRequired;
        if (cutoffRequired === false) {
          body[field] = null;
        } else if (cutoffRequired === true && !cutoff) {
          return exceptionHandler({ res, error: CUTOFF_MESSAGE, statusCode: 422 });
        }
      }
      if (required === true && !cutoff && !(hasCutoffFlag && (body.cutoffRequired ?? existing?.cutoffRequired) === false)) return exceptionHandler({ res, error: MESSAGE, statusCode: 422 });
      if (hasSessions) {
        const sessions = body.availableSessions !== undefined ? body.availableSessions : existing?.availableSessions;
        if (required === true && !sessions?.length) return exceptionHandler({ res, error: SESSIONS_MESSAGE, statusCode: 422 });
        if (required !== true) body.availableSessions = [];
      }
      return next();
    } catch (error) {
      return exceptionHandler({ res, error });
    }
  };
}

module.exports = requireSessionCutoff;
