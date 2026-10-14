/**
 * The customer details stored on an order / booking: what was typed at the desk when given, otherwise a snapshot of
 * the customer profile it was booked under.
 */
function customerDetailsFor(customer, typed) {
  const t = typed || {};
  return {
    name: (t.name || customer?.name || "").trim(),
    mobileNumber: (t.mobileNumber || customer?.mobileNumber || "").trim(),
    email: (t.email || (customer?.email && !/@no-email\.local$/.test(customer.email) ? customer.email : "") || "").trim(),
  };
}

module.exports = { customerDetailsFor };
