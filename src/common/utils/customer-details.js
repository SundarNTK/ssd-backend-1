const { isPlaceholderEmail, randomPlaceholderEmail } = require("./customer-email");

/**
 * The customer details stored on an order / booking: what was typed at the desk when given, otherwise a snapshot of
 * the customer profile it was booked under.
 *
 * The email is never borrowed from anyone else. When the customer has none, the booking carries an invalid random
 * address ("noemail.<random>@no-email.local", which can never receive mail and is shown as empty) - in particular it
 * is never the signed-in staff member's own email, even when the booking was made under their profile.
 */
function customerDetailsFor(customer, typed) {
  const t = typed || null;
  const real = (value) => {
    const v = String(value || "").trim();
    return v && !isPlaceholderEmail(v) ? v : "";
  };
  // Typed at the desk: only what was typed counts. Otherwise the customer's own profile: its real email, or the
  // placeholder it already carries; a random placeholder when it has neither.
  const profile = String(customer?.email || "").trim();
  const email = t ? real(t.email) || randomPlaceholderEmail() : real(profile) || profile || randomPlaceholderEmail();
  return {
    name: String((t && t.name) || customer?.name || "").trim(),
    mobileNumber: String((t && t.mobileNumber) || customer?.mobileNumber || "").trim(),
    email,
  };
}

module.exports = { customerDetailsFor };
