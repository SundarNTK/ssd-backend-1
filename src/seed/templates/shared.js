/**
 * Building blocks shared by the default email templates, so every message has the same look: a maroon headline,
 * body text in the shell's ink colour, a maroon call-to-action button and a soft gold note box.
 */
const MAROON = "#7c1527";
const MUTED = "#7a6a60";

const heading = (text) => `<h1 style="margin:0 0 18px;font-size:24px;font-weight:700;line-height:1.25;color:${MAROON};">${text}</h1>`;

/** Replaced by the shared call-to-action style when sent (see common/mailer/render-email.js). */
const button = (href, label) =>
  `<div align="center" style="margin:28px 0;text-align:center;"><a href="${href}" target="_blank" style="background-color:${MAROON};color:#ffffff;display:inline-block;font-family:Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;line-height:20px;text-align:center;text-decoration:none;padding:15px 40px;border-radius:10px;">${label}</a></div>`;

/** A soft gold box for the small print that matters (how long a link lasts, what to do if the button fails). */
const note = (html) =>
  `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:6px 0 22px;background:#fff8e8;border:1px solid #f0dca8;border-radius:10px;border-collapse:separate;"><tr><td style="padding:14px 16px;font-size:13px;line-height:1.6;color:#5c4a1f;">${html}</td></tr></table>`;

/** The link written out, for mail apps where the button does not show. */
const plainLink = (href) => `<a href="${href}" style="color:${MAROON};word-break:break-all;">${href}</a>`;

const blessing = `<p style="margin:26px 0 8px;">May the divine blessings of Lord Siva and Goddess Durga be with you and your family always.</p>`;
const small = (text) => `<p style="margin:0;font-size:12.5px;color:${MUTED};">${text}</p>`;

module.exports = { MAROON, MUTED, heading, button, note, plainLink, blessing, small };
