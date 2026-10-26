/**
 * Booking Confirmation email - sent only when someone clicks "Send Email" on a Transactions screen (never
 * automatically). The email carries the basics (booking / order / receipt numbers, what was booked, payment summary)
 * and the full receipt as a PDF attachment.
 *
 *   POST /bookings/:id/send-email   { email? }   - email defaults to the customer's; send one to override it
 */
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");
const sendTemplatedEmail = require("../../utilities/helpers/send-templated-email");
const { ensureDefaultEmailTemplates } = require("../../seed/seedEmailTemplates");
const { loadBooking } = require("../../common/booking-email/load-booking");
const { buildEmailData, buildPdfModel } = require("../../common/booking-email/build-data");
const { buildBookingPdf } = require("../../common/booking-email/pdf");
const { loadLogo } = require("../../common/booking-email/logo");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sendBookingEmail(req, res) {
  try {
    const loaded = await loadBooking(req.params.id);
    const { booking } = loaded;
    if (booking.bookingStatus !== "confirmed") throw "Only a confirmed booking can be emailed.";

    const typed = String(req.body?.email || "").trim().toLowerCase();
    if (typed && !EMAIL_RE.test(typed)) throw "Enter a valid email address.";
    const to = typed || String(loaded.recipient || "").toLowerCase();
    if (!to) throw "This customer has no email address on file. Enter an email address to send the booking to.";

    // The template is created at server start; this covers an entity added since, and is a no-op when it exists.
    if (loaded.entityId) await ensureDefaultEmailTemplates(loaded.entityId);

    const pdfModel = buildPdfModel(loaded);
    pdfModel.temple.logo = await loadLogo(pdfModel.temple.logoUrl);
    const pdf = await buildBookingPdf(pdfModel);
    const result = await sendTemplatedEmail("BOOKING_CONFIRMATION", loaded.entityId, to, buildEmailData(loaded), {
      attachments: [{ filename: `Booking-${booking.bookingNumber}.pdf`, content: pdf, contentType: "application/pdf" }],
    });

    await loaded.model
      .updateOne({ _id: booking._id }, { $push: { emailLog: { at: new Date(), to, by: req.auth?.userId ?? null, byName: req.auth?.user?.name ?? "" } } })
      .catch((err) => console.warn(">>> booking email: could not log the send:", err.message));

    return responseHandler({
      res,
      response: { sentTo: to, bookingNumber: booking.bookingNumber, dryRun: Boolean(result?.dryRun) },
      successMessage: result?.dryRun ? `Email prepared for ${to} (test mode - not actually sent).` : `Booking email sent to ${to}.`,
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

module.exports = { sendBookingEmail };
