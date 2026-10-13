const mongoose = require("mongoose");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");

/** key -> how many times that ticket was reprinted, from a booking's `reprints` log. */
function ticketReprintCounts(reprints) {
  const counts = new Map();
  for (const r of reprints || []) {
    for (const key of r.tickets || []) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * Records a reprint of SPECIFIC tickets of a confirmed booking (the ones the person ticked in the Reprint
 * popup, by ticket `key` - see common/utils/ticket-grouping.js): appends who/when/which tickets to `reprints`
 * and adds the number of tickets to `reprintCount`, in one atomic update so two people reprinting at once each
 * get their own record. The screen calls this only after the printer service has accepted those tickets, so
 * the counts are tickets actually sent to print, not clicks. Each ticket's own count is how many `reprints`
 * entries list its key.
 *
 * Works for either booking store (pos_bookings, or the older bookings) - pass its model.
 */
function makeReprintHandler(Model) {
  return async function reprintBooking(req, res) {
    try {
      const id = req.params.id;
      if (!mongoose.isValidObjectId(id)) throw "Invalid booking ID.";

      const tickets = Array.isArray(req.body?.tickets)
        ? [...new Set(req.body.tickets.map((k) => String(k).trim()).filter(Boolean))].slice(0, 100)
        : [];
      if (tickets.length === 0) throw "Choose at least one ticket to reprint.";

      const booking = await Model.findOneAndUpdate(
        Model.notDeletedFilter({ _id: id, bookingStatus: "confirmed" }),
        {
          $inc: { reprintCount: tickets.length },
          $push: { reprints: { at: new Date(), by: req.auth?.userId ?? null, byName: req.auth?.user?.name ?? "", tickets } },
        },
        { returnDocument: "after" }
      ).select("bookingNumber reprintCount reprints");
      if (!booking) throw "Only a confirmed booking's ticket can be reprinted.";

      const last = booking.reprints[booking.reprints.length - 1];
      const counts = ticketReprintCounts(booking.reprints);
      return responseHandler({
        res,
        response: {
          _id: booking._id,
          bookingNumber: booking.bookingNumber,
          reprintCount: booking.reprintCount,
          lastReprintedAt: last?.at ?? null,
          ticketCounts: Object.fromEntries(tickets.map((k) => [k, counts.get(k) || 0])),
        },
        successMessage: `${tickets.length} ticket${tickets.length === 1 ? "" : "s"} reprinted.`,
      });
    } catch (error) {
      return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
    }
  };
}

const reprintFields = {
  // Tickets reprinted in total (each ticket sent to print again counts 1), and a log of every reprint: when, by whom,
  // and which tickets (by key).
  reprintCount: { type: Number, default: 0 },
  reprints: {
    type: [
      new mongoose.Schema(
        {
          at: { type: Date, default: Date.now },
          by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
          byName: { type: String, default: "" },
          tickets: { type: [String], default: [] },
        },
        { _id: false }
      ),
    ],
    default: [],
  },
};

module.exports = { makeReprintHandler, reprintFields, ticketReprintCounts };
