/**
 * Session rule for Item / Service / Event masters.
 *
 * A master with `sessionRequired` is booked for one DAY (the session date): by default today, or any later day
 * up to and including its Future Booking Cut-off Date. Once the cut-off day has passed the session is over and the
 * offering can no longer be booked. Dates are Singapore calendar days ("YYYY-MM-DD"). `recurringRequired` is
 * only a flag on the master for now - it does not change booking.
 */
const { cutoffOf } = require("./booking-cutoff");

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today in Singapore as "YYYY-MM-DD". */
function templeToday(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** A stored Date (UTC midnight of the chosen day) as "YYYY-MM-DD". */
function dayOf(date) {
  if (!date) return null;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Validates the session day of ONE cart line against its master and returns the day to store
 * ("YYYY-MM-DD"), or null when the master has no session rule. Throws a plain string a cashier can act on.
 */
function resolveSessionDate(master, line, now = Date.now()) {
  if (!master || master.sessionRequired !== true) return null;
  const today = templeToday(now);
  const cutoff = dayOf(cutoffOf(master));
  if (cutoff && cutoff < today) throw `The session has ended for "${master.name}".`;

  const chosen = line?.sessionDate ? String(line.sessionDate).slice(0, 10) : today;
  if (!DAY.test(chosen) || Number.isNaN(Date.parse(`${chosen}T00:00:00Z`))) {
    throw `Choose a valid session date for "${master.name}".`;
  }
  if (cutoff && chosen > cutoff) throw `The session for "${master.name}" ends on ${cutoff}; choose a date up to then.`;
  return chosen;
}

/**
 * Validates the AM / PM choice of ONE cart line against its master and returns it, or null when the master has no
 * session rule (or no sessions listed - older records). A single available session is picked automatically.
 */
function resolveSession(master, line) {
  if (!master || master.sessionRequired !== true) return null;
  const available = Array.isArray(master.availableSessions) ? master.availableSessions : [];
  if (!available.length) return null;
  const chosen = line?.session ? String(line.session).toUpperCase() : available.length === 1 ? available[0] : "";
  if (!chosen) throw `Choose a session (${available.join(" / ")}) for "${master.name}".`;
  if (!available.includes(chosen)) throw `"${master.name}" is not available in the ${chosen} session.`;
  return chosen;
}

module.exports = { templeToday, dayOf, resolveSessionDate, resolveSession };
