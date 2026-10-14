/**
 * The Future Booking Cut-off Date of an Item / Service / Event: the last day it can be booked. Once that day has
 * passed (Singapore time) the record is no longer offered in Admin Booking or the POS, and a booking that still
 * names it is refused. No cut-off date = no limit.
 *
 * The field is `futureBookingCutOffDate` on Items and Events, `bookingCutoffDate` on Services.
 */
const { todayStart } = require("./event-seats");

/** Mongo clause: the cut-off is not set, or is today or later. Add it to a filter's $and. */
function notPastCutoff(field) {
  return { $or: [{ [field]: null }, { [field]: { $gte: todayStart() } }] };
}

/** The cut-off date of a loaded master, whichever field it uses (null = none). */
function cutoffOf(master) {
  return master?.futureBookingCutOffDate ?? master?.bookingCutoffDate ?? null;
}

module.exports = { notPastCutoff, cutoffOf };
