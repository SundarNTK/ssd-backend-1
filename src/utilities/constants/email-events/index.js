/**
 * Events the platform actually sends. A mapping for anything else would
 * never fire, so the Email Template Mapping screen offers only this list.
 * `placeholders` are the Handlebars tokens sendTemplatedEmail passes in
 * `data` for that event — the editor shows them so the message can be
 * written without guessing the names.
 */
const EMAIL_EVENTS = [
  {
    key: "ACCOUNT_ACTIVATION",
    label: "Account Activation",
    description: "Sent when a new account is created and still needs a password.",
    placeholders: [
      { token: "name", label: "Recipient name" },
      { token: "activationUrl", label: "Set-password link" },
    ],
  },
  {
    key: "PASSWORD_RESET",
    label: "Password Reset",
    description: "Sent when someone asks to reset their password.",
    placeholders: [
      { token: "name", label: "Recipient name" },
      { token: "resetUrl", label: "Reset-password link" },
      { token: "expiresInMinutes", label: "Link expiry, in minutes" },
    ],
  },
  {
    key: "BOOKING_CONFIRMATION",
    label: "Booking Confirmation",
    description: "Sent from the Transactions screens (Send Email) with the full booking receipt attached as a PDF. It is never sent automatically.",
    placeholders: [
      { token: "name", label: "Customer name" },
      { token: "bookingNumber", label: "Booking number" },
      { token: "orderNumber", label: "Order number" },
      { token: "receiptNumbers", label: "Receipt number(s)" },
      { token: "bookedOn", label: "Booking date and time" },
      { token: "paymentStatusLabel", label: "Paid / Partially paid / Pending" },
      { token: "subtotal", label: "Subtotal" },
      { token: "gstAmount", label: "GST" },
      { token: "grandTotal", label: "Total" },
      { token: "amountPaid", label: "Amount paid" },
      { token: "balanceAmount", label: "Balance due" },
      { token: "hasItems / items", label: "Items booked (name, quantity, amount, session)" },
      { token: "hasServices / services", label: "Services booked" },
      { token: "hasGeneralItems / generalItems", label: "General items booked" },
      { token: "hasEvents / events", label: "Events booked (slot, seats, amount)" },
      { token: "hasPayments / payments", label: "Payments received (receipt, mode, amount, date)" },
      { token: "templeName", label: "Temple name" },
    ],
  },
];

const EMAIL_EVENT_KEYS = EMAIL_EVENTS.map((event) => event.key);

module.exports = { EMAIL_EVENTS, EMAIL_EVENT_KEYS };
