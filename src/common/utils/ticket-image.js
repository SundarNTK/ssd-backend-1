/**
 * The picture a ticket prints under an item / service / general item / event line.
 *
 * Two switches must both be on, plus the record needs its own Ticket Image (a separate upload on the master,
 * not the card picture):
 *   - Print Split Setting master -> "Print image on ticket" = Yes (the global switch), and
 *   - the offering's own master -> "Print image on ticket" = Yes.
 * Otherwise nothing is sent and the ticket prints exactly as it always has.
 *
 * Only a full http(s) address is sent (the printer service downloads it); a relative path such as
 * the bundled sample-event artwork is skipped. Cloudinary pictures are asked for at ticket width as
 * PNG, so the printer service downloads a small file it can always decode.
 */
const TICKET_IMAGE_WIDTH = 480;

function ticketImageUrl(doc, printImageOn) {
  if (!printImageOn || !doc || doc.printImage !== true) return null;
  const url = String(doc.ticketImage || "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  if (/res\.cloudinary\.com/i.test(url) && url.includes("/image/upload/") && !/\/upload\/[a-z]{1,3}_/.test(url)) {
    return url.replace("/image/upload/", `/image/upload/w_${TICKET_IMAGE_WIDTH},c_limit,f_png/`);
  }
  return url;
}

module.exports = { ticketImageUrl };
