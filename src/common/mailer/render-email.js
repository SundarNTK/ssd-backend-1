const fs = require("fs");
const path = require("path");
const handlebars = require("handlebars");

const compiledShell = handlebars.compile(
  fs.readFileSync(path.join(__dirname, "base-template.html"), "utf8")
);

/**
 * Older saved messages still contain a full card and a baked-in logo.
 * That card is removed so the shared shell can add the entity logo.
 * A message that is already the shell is left as it is.
 */
function isAlreadyWrapped(html) {
  return String(html || "").includes("ssd-email-shell");
}

function peelToInner(html) {
  const value = String(html || "").trim();
  if (!value || isAlreadyWrapped(value)) return value;
  const legacy =
    /<!doctype html/i.test(value) ||
    /<html[\s>]/i.test(value) ||
    /font-family:\s*Georgia,serif;background:\s*#fbf6ea/i.test(value) ||
    (/<img\b/i.test(value) && /<h1\b/i.test(value) && /<table\b/i.test(value));
  if (!legacy) return value;

  const withoutImages = value.replace(/<img\b[^>]*>/gi, "");
  const start = withoutImages.search(/<h1\b/i);
  let inner = start === -1 ? withoutImages : withoutImages.slice(start);
  inner = inner.replace(/<p\b[^>]*>\s*Sri Siva Durga Temple\s*<\/p>/gi, "");
  inner = inner.replace(/(?:<\/td>\s*<\/tr>\s*<\/table>\s*){1,3}(?:<\/div>\s*)*(?:<\/body>\s*<\/html>\s*)?$/i, "");
  return inner.trim();
}

function buttonLink(href, label) {
  const url = String(href || "").replace(/"/g, "&quot;");
  const text = String(label || "Open").replace(/<[^>]+>/g, "").trim() || "Open";
  return (
    `<div align="center" style="margin:28px 0;text-align:center;">` +
    `<a href="${url}" target="_blank" style="background-color:#7c1527;color:#ffffff;display:inline-block;font-family:Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;line-height:20px;text-align:center;text-decoration:none;padding:15px 40px;border-radius:10px;border-bottom:3px solid #c1851a;">${text}</a>` +
    `</div>`
  );
}

/** Gmail drops gradient backgrounds and then the label is ordinary text with no obvious link. */
function solidifyButtons(html) {
  return String(html || "").replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs, label) => {
    const hrefMatch = attrs.match(/href\s*=\s*(['"])([\s\S]*?)\1/i);
    if (!hrefMatch) return full;
    const href = hrefMatch[2];
    if (!/^https?:\/\//i.test(href)) return full;
    const styled = /display\s*:\s*inline-block|background|padding\s*:/i.test(attrs);
    if (!styled) return full;
    return buttonLink(href, label);
  });
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<a\b[^>]*href\s*=\s*(['"])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, _q, href, label) => {
      const name = label.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      return name && name !== href ? `${name}\n${href}` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/h1>|<\/h2>|<\/div>|<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Puts the mapping's inner HTML into the standard email layout.
 * `body` is inserted raw (`{{{body}}}`) because it is already HTML.
 * The logo comes from the entity; this function does not look one up.
 */
function renderEmailHtml({ body, entityLogo = "", templeName = "Sri Siva Durga Temple", footerAddress = "", footerContact = "" }) {
  const raw = String(body || "");
  if (isAlreadyWrapped(raw)) return solidifyButtons(raw);
  return compiledShell({
    body: solidifyButtons(peelToInner(raw)),
    entityLogo: entityLogo || "",
    templeName: templeName || "Sri Siva Durga Temple",
    footerAddress,
    footerContact,
    year: new Date().getFullYear(),
  });
}

module.exports = { renderEmailHtml, isAlreadyWrapped, htmlToText };
