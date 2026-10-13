const mongoose = require("mongoose");
const { exceptionHandler } = require("../../utilities/handlers");

const MESSAGE = "Upload a Ticket Image - it is required when Print Image on Ticket is Yes.";

/**
 * Item / Service / General Item / Event masters: a record that prints a picture on its ticket
 * ("Print Image on Ticket" = Yes) must have its own Ticket Image. Mount after validateBody.
 *
 * - Create: printImage Yes needs a ticketImage in the body.
 * - Update: judged on what the record WILL look like (the body's value, else what is saved). A request that
 *   touches neither field (a status or favorite toggle) is not checked, so those keep working.
 */
function requireTicketImage(Model) {
  return async function checkTicketImage(req, res, next) {
    try {
      const body = req.body || {};
      if (req.method === "POST") {
        if (body.printImage === true && !body.ticketImage) {
          return exceptionHandler({ res, error: MESSAGE, statusCode: 422 });
        }
        return next();
      }
      if (body.printImage === undefined && body.ticketImage === undefined) return next();
      const id = req.params.id;
      const existing = mongoose.isValidObjectId(id)
        ? await Model.findOne(Model.notDeletedFilter({ _id: id })).select("printImage ticketImage")
        : null;
      const printImage = body.printImage !== undefined ? body.printImage : existing?.printImage === true;
      const ticketImage = body.ticketImage !== undefined ? body.ticketImage : existing?.ticketImage;
      if (printImage === true && !ticketImage) return exceptionHandler({ res, error: MESSAGE, statusCode: 422 });
      return next();
    } catch (error) {
      return exceptionHandler({ res, error });
    }
  };
}

module.exports = requireTicketImage;
