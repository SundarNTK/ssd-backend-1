/**
 * Session rule for Item / Service / Event masters.
 *
 * A master with `sessionRequired` is booked for one DAY (the session date): by default today, or any later day
 * up to and including its `sessionCutoffDate`. Once the cut-off day has passed the session is over and the
 * offering can no longer be booked. Dates are Singapore calendar days ("YYYY-MM-DD"). `recurringRequired` is
 * only a flag on the master for now - it does not change booking.
 */
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
  const cutoff = dayOf(master.sessionCutoffDate);
  if (cutoff && cutoff < today) throw `The session has ended for "${master.name}".`;

  const chosen = line?.sessionDate ? String(line.sessionDate).slice(0, 10) : today;
  if (!DAY.test(chosen) || Number.isNaN(Date.parse(`${chosen}T00:00:00Z`))) {
    throw `Choose a valid session date for "${master.name}".`;
  }
  if (chosen < today) throw `The session date for "${master.name}" cannot be in the past.`;
  if (cutoff && chosen > cutoff) throw `The session for "${master.name}" ends on ${cutoff}; choose a date up to then.`;
  return chosen;
}

module.exports = { templeToday, dayOf, resolveSessionDate };
