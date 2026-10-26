/**
 * The Future Booking Cut-off Date of an Item / Service / Event: the last day it can be booked. Once that day has
 * passed (Singapore time) the POS and Admin Booking still list it, but as out of stock, and a booking that still
 * names it is refused. No cut-off date = no limit.
 *
 * Items and Services also carry `cutoffRequired`: false means the master has no cut-off at all, whatever date may
 * still be stored. Records saved before that field existed (undefined) follow their date as before.
 *
 * The field is `futureBookingCutOffDate` on Items and Events, `bookingCutoffDate` on Services.
 */
const { todayStart } = require("./event-seats");

/** Mongo clause: the cut-off is not required or not set, or is today or later. Add it to a filter's $and. */
function notPastCutoff(field) {
  return { $or: [{ cutoffRequired: false }, { [field]: null }, { [field]: { $gte: todayStart() } }] };
}

/** The cut-off date of a loaded master, whichever field it uses (null = none, including "Cut-off Required: No"). */
function cutoffOf(master) {
  if (master?.cutoffRequired === false) return null;
  return master?.futureBookingCutOffDate ?? master?.bookingCutoffDate ?? null;
}

/** True when the master has a cut-off and its last day is before today (Singapore time). */
function cutoffPassed(master) {
  const cutoff = cutoffOf(master);
  return !!cutoff && new Date(cutoff) < todayStart();
}

module.exports = { notPastCutoff, cutoffOf, cutoffPassed };
