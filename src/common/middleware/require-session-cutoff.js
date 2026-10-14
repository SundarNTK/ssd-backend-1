const mongoose = require("mongoose");
const { exceptionHandler } = require("../../utilities/handlers");

const MESSAGE = "Enter the Session Cutoff Date - it is required when Session Required is Yes.";

/**
 * Item / Service / Event masters: "Session Required" = Yes needs a Session Cutoff Date. Mount after validateBody.
 * Create checks the body; update judges what the record WILL look like (body value, else the saved one), and a
 * request that touches neither field is not checked.
 */
function requireSessionCutoff(Model) {
  return async function checkSessionCutoff(req, res, next) {
    try {
      const body = req.body || {};
      if (req.method === "POST") {
        if (body.sessionRequired === true && !body.sessionCutoffDate) {
          return exceptionHandler({ res, error: MESSAGE, statusCode: 422 });
        }
        return next();
      }
      if (body.sessionRequired === undefined && body.sessionCutoffDate === undefined) return next();
      const id = req.params.id;
      const existing = mongoose.isValidObjectId(id)
        ? await Model.findOne(Model.notDeletedFilter({ _id: id })).select("sessionRequired sessionCutoffDate")
        : null;
      const required = body.sessionRequired !== undefined ? body.sessionRequired : existing?.sessionRequired === true;
      const cutoff = body.sessionCutoffDate !== undefined ? body.sessionCutoffDate : existing?.sessionCutoffDate;
      if (required === true && !cutoff) return exceptionHandler({ res, error: MESSAGE, statusCode: 422 });
      return next();
    } catch (error) {
      return exceptionHandler({ res, error });
    }
  };
}

module.exports = requireSessionCutoff;
