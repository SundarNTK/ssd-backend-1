const mongoose = require("mongoose");
const { exceptionHandler } = require("../../utilities/handlers");

const MESSAGE = "Enter the Future Booking Cut-off Date - it is required when Session Required is Yes.";

/**
 * Item / Service / Event masters: "Session Required" = Yes needs the master's Future Booking Cut-off Date (the last
 * day a session can be booked). `field` is that date's field name on the model. Mount after validateBody.
 * Create checks the body; update judges what the record WILL look like (body value, else the saved one), and a
 * request that touches neither field is not checked.
 */
function requireSessionCutoff(Model, field) {
  return async function checkSessionCutoff(req, res, next) {
    try {
      const body = req.body || {};
      if (req.method === "POST") {
        if (body.sessionRequired === true && !body[field]) {
          return exceptionHandler({ res, error: MESSAGE, statusCode: 422 });
        }
        return next();
      }
      if (body.sessionRequired === undefined && body[field] === undefined) return next();
      const id = req.params.id;
      const existing = mongoose.isValidObjectId(id)
        ? await Model.findOne(Model.notDeletedFilter({ _id: id })).select(`sessionRequired ${field}`)
        : null;
      const required = body.sessionRequired !== undefined ? body.sessionRequired : existing?.sessionRequired === true;
      const cutoff = body[field] !== undefined ? body[field] : existing?.[field];
      if (required === true && !cutoff) return exceptionHandler({ res, error: MESSAGE, statusCode: 422 });
      return next();
    } catch (error) {
      return exceptionHandler({ res, error });
    }
  };
}

module.exports = requireSessionCutoff;
