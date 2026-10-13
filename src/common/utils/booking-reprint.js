const mongoose = require("mongoose");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");

/**
 * Records one reprint of a confirmed booking's ticket: bumps `reprintCount` and appends who/when to
 * `reprints`, in one atomic update so two people reprinting at once each get their own number.
 * The screen calls this only after the printer service has accepted the ticket, so the count is
 * tickets actually sent to print, not clicks.
 *
 * Works for either booking store (pos_bookings, or the older bookings) - pass its model.
 */
function makeReprintHandler(Model) {
  return async function reprintBooking(req, res) {
    try {
      const id = req.params.id;
      if (!mongoose.isValidObjectId(id)) throw "Invalid booking ID.";

      const booking = await Model.findOneAndUpdate(
        Model.notDeletedFilter({ _id: id, bookingStatus: "confirmed" }),
        {
          $inc: { reprintCount: 1 },
          $push: { reprints: { at: new Date(), by: req.auth?.userId ?? null, byName: req.auth?.user?.name ?? "" } },
        },
        { returnDocument: "after" }
      ).select("bookingNumber reprintCount reprints");
      if (!booking) throw "Only a confirmed booking's ticket can be reprinted.";

      const last = booking.reprints[booking.reprints.length - 1];
      return responseHandler({
        res,
        response: {
          _id: booking._id,
          bookingNumber: booking.bookingNumber,
          reprintCount: booking.reprintCount,
          lastReprintedAt: last?.at ?? null,
        },
        successMessage: `Ticket reprint #${booking.reprintCount} recorded.`,
      });
    } catch (error) {
      return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
    }
  };
}

const reprintFields = {
  // How many times this booking's ticket has been reprinted, and each reprint's time and user.
  reprintCount: { type: Number, default: 0 },
  reprints: {
    type: [
      new mongoose.Schema(
        {
          at: { type: Date, default: Date.now },
          by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
          byName: { type: String, default: "" },
        },
        { _id: false }
      ),
    ],
    default: [],
  },
};

module.exports = { makeReprintHandler, reprintFields };
