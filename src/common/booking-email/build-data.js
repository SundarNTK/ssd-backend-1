/**
 * Turns a loaded booking into (a) the values the Booking Confirmation email template prints and (b) the grouped,
 * fully detailed view the PDF prints. Pure functions - no database - so they are easy to test.
 *
 * Money and dates are formatted here (Singapore dollars and Singapore time) so the template needs no helpers.
 */
const { contactEmail } = require("./load-booking");

const TIME_ZONE = "Asia/Singapore";

const money = (n) => `S$ ${Number(n || 0).toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dateTime = (value) =>
  value ? new Date(value).toLocaleString("en-SG", { timeZone: TIME_ZONE, day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "";

const dateOnly = (value) => {
  if (!value) return "";
  // A bare "YYYY-MM-DD" is a calendar day already (Singapore): format it without shifting it across a time zone.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(`${value}T00:00:00+08:00`) : new Date(value);
  return d.toLocaleDateString("en-SG", { timeZone: TIME_ZONE, day: "2-digit", month: "short", year: "numeric" });
};

const SESSION_LABEL = { AM: "Morning", PM: "Evening" };
const sessionText = (line) => {
  if (!line.sessionDate) return "";
  const half = line.session ? ` (${SESSION_LABEL[line.session] || line.session})` : "";
  return `${dateOnly(line.sessionDate)}${half}`;
};

/** "14:00" -> "2:00 PM", "00:30" -> "12:30 AM". A time that is not 24-hour HH:MM (already "6:00 PM") is left as it is. */
const time12 = (value) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return String(value || "");
  const hour = Number(m[1]);
  if (hour > 23) return String(value);
  return `${hour % 12 || 12}:${m[2]} ${hour < 12 ? "AM" : "PM"}`;
};

const slotText = (line) => {
  const s = line.eventSlot;
  if (!s) return "";
  const time = s.startTime ? `${time12(s.startTime)}${s.endTime ? ` - ${time12(s.endTime)}` : ""}` : "";
  return [s.slotName, s.date ? dateOnly(s.date) : "", time].filter(Boolean).join(" · ");
};

/** Which section of the email / PDF a booking line belongs to. */
const SECTIONS = [
  { key: "Item", flag: "hasItems", list: "items", title: "Items" },
  { key: "Service", flag: "hasServices", list: "services", title: "Services" },
  { key: "GeneralItem", flag: "hasGeneralItems", list: "generalItems", title: "General Items" },
  { key: "Event", flag: "hasEvents", list: "events", title: "Events" },
];

/** "15 Tank Road, #03-01, Singapore 238065" from the entity's address parts. */
function formatAddress(a) {
  if (!a) return "";
  const street = [a.block, a.street].filter(Boolean).join(" ");
  const place = [a.country, a.pincode].filter(Boolean).join(" ");
  return [street, a.unit, place].filter(Boolean).join(", ");
}

const PAYMENT_STATUS = { paid: "Paid", partial: "Partially paid", pending: "Pending" };
const PORTAL_LABEL = { pos: "POS counter", admin: "Admin Panel", customer: "Customer Portal" };

const sumPaid = (transactions) => +transactions.reduce((sum, t) => sum + (Number(t.amount) || 0), 0).toFixed(2);

/** The booking's lines split by type, in a fixed order, skipping the types it has none of. */
function groupLines(lines) {
  return SECTIONS.map((section) => ({ ...section, lines: (lines || []).filter((l) => l.refType === section.key) })).filter((s) => s.lines.length > 0);
}

function buildSummary({ booking, transactions, order, entity }) {
  const amountPaid = sumPaid(transactions);
  const balance = +(Number(booking.grandTotal || 0) - amountPaid).toFixed(2);
  return {
    bookingNumber: booking.bookingNumber,
    orderNumber: order?.orderNumber || "",
    receiptNumbers: transactions.map((t) => t.receiptNo).filter(Boolean).join(", "),
    bookedOn: dateTime(booking.bookedAt),
    paymentStatus: booking.paymentStatus,
    paymentStatusLabel: PAYMENT_STATUS[booking.paymentStatus] || booking.paymentStatus,
    isPaid: booking.paymentStatus === "paid",
    portalLabel: PORTAL_LABEL[booking.portal] || "",
    subtotal: money(booking.subtotal),
    gstAmount: money(booking.gstAmount),
    grandTotal: money(booking.grandTotal),
    amountPaid: money(amountPaid),
    balanceAmount: money(Math.max(0, balance)),
    hasBalance: balance > 0.005,
    templeName: entity?.templeName || entity?.name || "Sri Siva Durga Temple",
  };
}

/** What the Booking Confirmation template prints: the basics only. Everything detailed lives in the PDF. */
function buildEmailData(loaded) {
  const { booking, transactions, customer } = loaded;
  const data = {
    name: booking.customerDetails?.name || customer?.name || "Devotee",
    ...buildSummary(loaded),
    hasPayments: transactions.length > 0,
    payments: transactions.map((t) => ({
      receiptNo: t.receiptNo,
      mode: t.paymentModeName,
      date: dateTime(t.transactionDate),
      amount: money(t.amount),
    })),
  };

  for (const section of SECTIONS) {
    const lines = (booking.lines || []).filter((l) => l.refType === section.key);
    data[section.flag] = lines.length > 0;
    data[section.list] = lines.map((l) =>
      section.key === "Event"
        ? { name: l.name, seats: l.seats ?? l.quantity, slot: slotText(l), lineTotal: money(l.lineTotal) }
        : { name: l.name, quantity: l.quantity, session: sessionText(l), lineTotal: money(l.lineTotal) }
    );
  }
  return data;
}

/** The detailed, grouped view the PDF prints. */
function buildPdfModel(loaded) {
  const { booking, transactions, customer, entity } = loaded;
  const summary = buildSummary(loaded);
  const lineView = (l) => ({
    name: l.name,
    code: l.code,
    quantity: l.refType === "Event" ? (l.seats ?? l.quantity) : l.quantity,
    unitPrice: money(l.unitPrice),
    gst: l.gstRate ? `${l.gstRate}% (${money(l.gstAmount)})` : "-",
    lineTotal: money(l.lineTotal),
    session: sessionText(l),
    slot: slotText(l),
    deities: (l.deities || []).map((d) => d.name).filter(Boolean),
    devotees: (l.devotees || []).map((d) => (d.nakshatra ? `${d.name} (${d.nakshatra})` : d.name)),
  });

  return {
    summary,
    temple: {
      name: entity?.templeName || entity?.name || "Sri Siva Durga Temple",
      tamilName: entity?.templeTamilName || "",
      address: formatAddress(entity?.address),
      phone: entity?.mobileNumber || "",
      email: entity?.email || "",
      logoUrl: entity?.logoUrl || "",
      gstNumber: entity?.gstNumber || "",
    },
    customer: {
      name: booking.customerDetails?.name || customer?.name || "",
      code: customer?.customerCode || "",
      mobile: booking.customerDetails?.mobileNumber || customer?.mobileNumber || "",
      email: contactEmail(booking, customer),
    },
    remarks: booking.remarks || "",
    bookedBy: booking.bookedBy?.name || booking.bookedByInfo?.name || "",
    sections: groupLines(booking.lines).map((s) => ({ title: s.title, key: s.key, lines: s.lines.map(lineView) })),
    payments: transactions.map((t) => ({ receiptNo: t.receiptNo, mode: t.paymentModeName, date: dateTime(t.transactionDate), amount: money(t.amount) })),
  };
}

module.exports = { time12, buildEmailData, buildPdfModel, money, dateTime, dateOnly, sumPaid };
