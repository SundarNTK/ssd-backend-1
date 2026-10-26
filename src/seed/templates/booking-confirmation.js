/**
 * The one Booking Confirmation email. It carries the basics only - who, which booking, what was booked, the total and
 * what is paid - and points to the attached PDF for everything else (devotees, deities, GST per line, every payment).
 * Every section is optional: a booking with only an item shows only Items; one with a service and an event shows those
 * two. Values come from common/booking-email/build-data.js, already formatted, so this stays plain Handlebars.
 *
 * Inner message only - the logo, card and font come from the shared shell (common/mailer/base-template.html).
 * The marker below lets a deploy replace an older, never-edited copy of this default (see seed/seedEmailTemplates.js).
 */
const MARKER = "ssd-template:booking-confirmation:v3";

const MAROON = "#7c1527";
const INK = "#2b1a1f";
const MUTED = "#7a6a60";
const LINE = "#efe3e5";

const TH = `style="padding:8px 4px;border-bottom:1px solid ${LINE};color:${MUTED};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;"`;
const TD = `style="padding:11px 4px;border-bottom:1px solid ${LINE};font-size:14px;color:${INK};vertical-align:top;"`;
const SECTION = `style="margin:28px 0 6px;font-size:13px;font-weight:700;color:${MAROON};text-transform:uppercase;letter-spacing:0.08em;"`;
const NOTE = `style="display:block;margin-top:2px;font-size:12px;font-weight:400;color:${MUTED};"`;

/** One bookable section (Items / Services / General Items): a name, quantity and amount per row. */
const lineSection = (flag, list, heading) => `
{{#if ${flag}}}
<p ${SECTION}>${heading}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
  <tr>
    <th align="left" ${TH}>Name</th>
    <th align="center" ${TH} width="60">Qty</th>
    <th align="right" ${TH} width="110">Amount</th>
  </tr>
  {{#each ${list}}}
  <tr>
    <td ${TD}><strong>{{name}}</strong>{{#if session}}<span ${NOTE}>Session: {{session}}</span>{{/if}}</td>
    <td align="center" ${TD}>{{quantity}}</td>
    <td align="right" ${TD}>{{lineTotal}}</td>
  </tr>
  {{/each}}
</table>
{{/if}}`;

const detail = (label, value) =>
  `<td valign="top" style="padding:6px 0;width:50%;font-size:13.5px;color:${INK};"><span style="display:block;font-size:11px;font-weight:600;color:${MUTED};text-transform:uppercase;letter-spacing:0.06em;">${label}</span>${value}</td>`;

const htmlContent = `<!-- ${MARKER} -->
<h1 style="margin:0 0 18px;font-size:24px;font-weight:700;line-height:1.25;color:${MAROON};">Booking confirmed</h1>
<p style="margin:0 0 14px;font-size:15px;">Dear <strong>{{name}}</strong>,</p>
<p style="margin:0 0 20px;">Thank you for your booking at {{templeName}}. Here is a quick summary. <strong>More details are in the attached PDF receipt.</strong></p>

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#faf4f5;border:1px solid ${LINE};border-radius:10px;border-collapse:separate;">
  <tr>
    <td style="padding:18px 20px 6px;">
      <span style="display:block;font-size:11px;font-weight:600;color:${MUTED};text-transform:uppercase;letter-spacing:0.08em;">Booking number</span>
      <span style="display:inline-block;margin-top:2px;font-size:22px;font-weight:700;color:${MAROON};">{{bookingNumber}}</span>
      {{#if isPaid}}<span style="display:inline-block;margin-left:10px;padding:3px 10px;border-radius:999px;background:#e3f4ec;color:#1f7a5a;font-size:12px;font-weight:700;vertical-align:middle;">{{paymentStatusLabel}}</span>{{else}}<span style="display:inline-block;margin-left:10px;padding:3px 10px;border-radius:999px;background:#fdf0d5;color:#9a6700;font-size:12px;font-weight:700;vertical-align:middle;">{{paymentStatusLabel}}</span>{{/if}}
    </td>
  </tr>
  <tr>
    <td style="padding:6px 20px 14px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
        <tr>
          ${detail("Order number", "{{#if orderNumber}}{{orderNumber}}{{else}}-{{/if}}")}
          ${detail("Booked on", "{{bookedOn}}")}
        </tr>
        {{#if receiptNumbers}}
        <tr>
          <td colspan="2" valign="top" style="padding:6px 0;font-size:13.5px;color:${INK};"><span style="display:block;font-size:11px;font-weight:600;color:${MUTED};text-transform:uppercase;letter-spacing:0.06em;">Receipt number(s)</span>{{receiptNumbers}}</td>
        </tr>
        {{/if}}
      </table>
    </td>
  </tr>
</table>
${lineSection("hasItems", "items", "Items")}
${lineSection("hasServices", "services", "Services")}
${lineSection("hasGeneralItems", "generalItems", "General items")}
{{#if hasEvents}}
<p ${SECTION}>Events</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
  <tr>
    <th align="left" ${TH}>Event</th>
    <th align="center" ${TH} width="60">Seats</th>
    <th align="right" ${TH} width="110">Amount</th>
  </tr>
  {{#each events}}
  <tr>
    <td ${TD}><strong>{{name}}</strong>{{#if slot}}<span ${NOTE}>{{slot}}</span>{{/if}}</td>
    <td align="center" ${TD}>{{seats}}</td>
    <td align="right" ${TD}>{{lineTotal}}</td>
  </tr>
  {{/each}}
</table>
{{/if}}

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:22px;border-collapse:separate;border:1px solid ${LINE};border-radius:10px;">
  <tr>
    <td style="padding:12px 16px;font-size:14px;color:${INK};">Total</td>
    <td align="right" style="padding:12px 16px;font-size:16px;font-weight:700;color:${INK};">{{grandTotal}}</td>
  </tr>
  <tr>
    <td style="padding:0 16px 12px;font-size:14px;color:${INK};">Amount paid</td>
    <td align="right" style="padding:0 16px 12px;font-size:14px;color:${INK};">{{amountPaid}}</td>
  </tr>
  {{#if hasBalance}}
  <tr>
    <td style="padding:10px 16px;background:#fbeaec;border-top:1px solid ${LINE};font-size:14px;font-weight:700;color:#b3273f;border-radius:0 0 0 10px;">Balance due</td>
    <td align="right" style="padding:10px 16px;background:#fbeaec;border-top:1px solid ${LINE};font-size:15px;font-weight:700;color:#b3273f;border-radius:0 0 10px 0;">{{balanceAmount}}</td>
  </tr>
  {{/if}}
</table>

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:22px;background:#fff8e8;border:1px solid #f0dca8;border-radius:10px;border-collapse:separate;">
  <tr>
    <td style="padding:14px 16px;font-size:13.5px;line-height:1.55;color:#5c4a1f;">
      <strong>Your full receipt is attached.</strong> The PDF (<strong>Booking-{{bookingNumber}}.pdf</strong>) has all the details: devotee names, deities, session and event timings, GST on each line, and every payment received.
    </td>
  </tr>
</table>

<p style="margin:26px 0 6px;">May the divine blessings of Lord Siva and Goddess Durga be with you and your family always.</p>
<p style="margin:0;color:${MUTED};font-size:12.5px;">Questions about this booking? Contact the temple office and quote your booking number.</p>`;

module.exports = {
  name: "Booking Confirmation",
  event: "BOOKING_CONFIRMATION",
  subject: "Your booking {{bookingNumber}} — {{templeName}}",
  htmlContent,
  marker: MARKER,
};
