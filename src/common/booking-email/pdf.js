/**
 * The booking receipt PDF attached to the Booking Confirmation email: everything the email only summarises -
 * references, customer, every line with its session / slot / deities / devotees and GST, the totals and each
 * payment. Built with pdfkit; Noto Sans (Latin) and Noto Sans Tamil are bundled (the @fontsource packages) so Tamil
 * devotee names print correctly.
 */
const path = require("path");
const PDFDocument = require("pdfkit");

const fontFile = (pkg, name) => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "files", name);
const FONTS = {
  latin: fontFile("@fontsource/noto-sans", "noto-sans-latin-400-normal.woff"),
  latinBold: fontFile("@fontsource/noto-sans", "noto-sans-latin-700-normal.woff"),
  tamil: fontFile("@fontsource/noto-sans-tamil", "noto-sans-tamil-tamil-400-normal.woff"),
  tamilBold: fontFile("@fontsource/noto-sans-tamil", "noto-sans-tamil-tamil-700-normal.woff"),
};

const MAROON = "#7c1527";
const GOLD = "#c1851a";
const INK = "#2b1a1f";
const MUTED = "#6b6258";
const RULE = "#e3d3d6";
const TINT = "#f7efef";

const TAMIL = /[஀-௿]/;

/** Splits text into runs of Tamil / non-Tamil so each run can be drawn with the font that has its letters. */
function runsOf(text) {
  const runs = [];
  for (const ch of String(text ?? "")) {
    const tamil = TAMIL.test(ch);
    const last = runs[runs.length - 1];
    if (last && last.tamil === tamil) last.text += ch;
    else runs.push({ tamil, text: ch });
  }
  return runs;
}

function useFont(doc, tamil, bold) {
  doc.font(tamil ? (bold ? "tamilBold" : "tamil") : bold ? "latinBold" : "latin");
}

/** Width of mixed Latin / Tamil text in the current size. */
function widthOf(doc, text, bold) {
  return runsOf(text).reduce((sum, r) => {
    useFont(doc, r.tamil, bold);
    return sum + doc.widthOfString(r.text);
  }, 0);
}

/**
 * Draws mixed-script text at (x, y) within `width`, wrapping on spaces. Returns the height used. pdfkit wraps one
 * font at a time, so wrapping is done here, word by word, measuring each word in its own font.
 */
function drawText(doc, text, x, y, { width, size = 9, bold = false, color = INK, align = "left" } = {}) {
  doc.fontSize(size).fillColor(color);
  const lineHeight = size * 1.35;
  const words = String(text ?? "").split(/(\s+)/).filter((w) => w !== "");
  const lines = [[]];
  let lineWidth = 0;
  for (const word of words) {
    const w = widthOf(doc, word, bold);
    if (/^\s+$/.test(word)) {
      if (lines[lines.length - 1].length) {
        lines[lines.length - 1].push(word);
        lineWidth += w;
      }
      continue;
    }
    if (lineWidth + w > width && lines[lines.length - 1].length) {
      lines.push([]);
      lineWidth = 0;
    }
    lines[lines.length - 1].push(word);
    lineWidth += w;
  }
  lines.forEach((parts, i) => {
    const line = parts.join("").replace(/\s+$/, "");
    const lw = widthOf(doc, line, bold);
    let cx = align === "right" ? x + width - lw : align === "center" ? x + (width - lw) / 2 : x;
    for (const r of runsOf(line)) {
      useFont(doc, r.tamil, bold);
      doc.text(r.text, cx, y + i * lineHeight, { lineBreak: false });
      cx += doc.widthOfString(r.text);
    }
  });
  return lines.length * lineHeight;
}

function measure(doc, text, { width, size = 9, bold = false }) {
  doc.fontSize(size);
  // Same wrapping as drawText, without drawing.
  const words = String(text ?? "").split(/(\s+)/).filter((w) => w !== "");
  let count = 1;
  let lineWidth = 0;
  let any = false;
  for (const word of words) {
    const w = widthOf(doc, word, bold);
    if (/^\s+$/.test(word)) {
      if (any) lineWidth += w;
      continue;
    }
    if (lineWidth + w > width && any) {
      count += 1;
      lineWidth = 0;
    }
    lineWidth += w;
    any = true;
  }
  return count * size * 1.35;
}

/**
 * @param {ReturnType<import("./build-data").buildPdfModel>} model
 * @returns {Promise<Buffer>}
 */
function buildBookingPdf(model) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true, info: { Title: `Booking ${model.summary.bookingNumber}`, Author: model.temple.name } });
    for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, file);
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 40;
    const right = doc.page.width - 40;
    const contentWidth = right - left;
    const bottom = doc.page.height - 60;
    let y = 40;

    const ensure = (needed) => {
      if (y + needed > bottom) {
        doc.addPage();
        y = 40;
      }
    };
    const rule = (color = RULE, at = y) => doc.moveTo(left, at).lineTo(right, at).lineWidth(0.7).strokeColor(color).stroke();
    const heading = (text) => {
      ensure(40);
      y += 8;
      y += drawText(doc, text, left, y, { width: contentWidth, size: 12, bold: true, color: MAROON }) + 3;
      rule(GOLD);
      y += 6;
    };

    // ── Header: logo, title and address, all centred ──
    const centre = { width: contentWidth, align: "center" };
    let logoDrawn = false;
    if (model.temple.logo) {
      try {
        const img = doc.openImage(model.temple.logo);
        const scale = Math.min(190 / img.width, 62 / img.height, 1.5);
        const w = img.width * scale;
        const h = img.height * scale;
        doc.image(model.temple.logo, left + (contentWidth - w) / 2, y, { width: w, height: h });
        y += h + 8;
        logoDrawn = true;
      } catch {
        // An unreadable image falls back to the name below.
      }
    }
    if (!logoDrawn) {
      y += drawText(doc, model.temple.name, left, y, { ...centre, size: 18, bold: true, color: MAROON }) + 2;
      if (model.temple.tamilName) y += drawText(doc, model.temple.tamilName, left, y, { ...centre, size: 11, color: MAROON }) + 2;
    }
    y += drawText(doc, "BOOKING CONFIRMATION RECEIPT", left, y, { ...centre, size: 13, bold: true, color: MAROON }) + 3;
    if (model.temple.address) y += drawText(doc, model.temple.address, left, y, { ...centre, size: 8, color: MUTED });
    if (model.temple.gstNumber) y += drawText(doc, `GST Reg. No.: ${model.temple.gstNumber}`, left, y, { ...centre, size: 8, color: MUTED });
    y += 8;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(1.2).strokeColor(MAROON).stroke();
    y += 12;

    // ── References + customer, two columns ──
    const colW = (contentWidth - 20) / 2;
    const pairs = (x, rows) => {
      let cy = y;
      for (const [label, value] of rows) {
        if (!value) continue;
        drawText(doc, label.toUpperCase(), x, cy, { width: 90, size: 7, bold: true, color: MUTED });
        cy += drawText(doc, value, x + 92, cy - 1, { width: colW - 92, size: 9, bold: true }) + 2;
      }
      return cy - y;
    };
    const leftH = pairs(left, [
      ["Booking no.", model.summary.bookingNumber],
      ["Order no.", model.summary.orderNumber],
      ["Receipt no.", model.summary.receiptNumbers],
      ["Booked on", model.summary.bookedOn],
      ["Booked via", model.summary.portalLabel],
      ["Booked by", model.bookedBy],
      ["Payment status", model.summary.paymentStatusLabel],
    ]);
    const rightH = pairs(left + colW + 20, [
      ["Customer", model.customer.name],
      ["Customer code", model.customer.code],
      ["Mobile", model.customer.mobile],
      ["Email", model.customer.email],
    ]);
    y += Math.max(leftH, rightH) + 4;
    if (model.remarks) {
      y += drawText(doc, `Remarks: ${model.remarks}`, left, y, { width: contentWidth, size: 8.5, color: MUTED }) + 2;
    }

    // ── Line sections ──
    const cols = { desc: left + 4, qty: left + 290, unit: left + 322, gst: left + 382, total: right - 4 };
    const descW = 275;
    for (const section of model.sections) {
      heading(section.title);
      // column heads
      ensure(20);
      doc.rect(left, y - 2, contentWidth, 15).fill(TINT);
      drawText(doc, section.key === "Event" ? "EVENT" : "DESCRIPTION", cols.desc, y + 1, { width: descW, size: 7, bold: true, color: MAROON });
      drawText(doc, section.key === "Event" ? "SEATS" : "QTY", cols.qty, y + 1, { width: 30, size: 7, bold: true, color: MAROON, align: "right" });
      drawText(doc, "UNIT PRICE", cols.unit, y + 1, { width: 56, size: 7, bold: true, color: MAROON, align: "right" });
      drawText(doc, "GST INCLUDED", cols.gst, y + 1, { width: 76, size: 7, bold: true, color: MAROON, align: "right" });
      drawText(doc, "AMOUNT", right - 70, y + 1, { width: 66, size: 7, bold: true, color: MAROON, align: "right" });
      y += 18;

      for (const l of section.lines) {
        const details = [
          l.code ? `Code: ${l.code}` : "",
          l.session ? `Session: ${l.session}` : "",
          l.slot ? `Slot: ${l.slot}` : "",
          l.deities.length ? `Deities: ${l.deities.join(", ")}` : "",
          l.devotees.length ? `Devotees: ${l.devotees.join(", ")}` : "",
        ].filter(Boolean);
        const nameH = measure(doc, l.name, { width: descW, size: 9.5, bold: true });
        const detailH = details.reduce((sum, d) => sum + measure(doc, d, { width: descW, size: 8 }), 0);
        ensure(nameH + detailH + 10);
        drawText(doc, l.name, cols.desc, y, { width: descW, size: 9.5, bold: true });
        drawText(doc, String(l.quantity), cols.qty, y, { width: 30, size: 9, align: "right" });
        drawText(doc, l.unitPrice, cols.unit, y, { width: 56, size: 9, align: "right" });
        drawText(doc, l.gst, cols.gst, y, { width: 76, size: 8, align: "right", color: MUTED });
        drawText(doc, l.lineTotal, right - 70, y, { width: 66, size: 9.5, bold: true, align: "right" });
        let dy = y + nameH;
        for (const d of details) dy += drawText(doc, d, cols.desc + 6, dy, { width: descW - 6, size: 8, color: MUTED });
        y = dy + 4;
        rule(RULE, y - 1);
        y += 3;
      }
    }

    // ── Totals ──
    ensure(110);
    y += 8;
    const totalsX = right - 220;
    const totalRow = (label, value, { bold = false, color = INK } = {}) => {
      drawText(doc, label, totalsX, y, { width: 120, size: 9.5, bold, color });
      drawText(doc, value, totalsX + 120, y, { width: 100, size: 9.5, bold, color, align: "right" });
      y += 15;
    };
    totalRow("Subtotal (before GST)", model.summary.subtotal);
    totalRow("GST", model.summary.gstAmount);
    doc.moveTo(totalsX, y).lineTo(right, y).lineWidth(0.7).strokeColor(MAROON).stroke();
    y += 4;
    totalRow("Total", model.summary.grandTotal, { bold: true });
    totalRow("Amount paid", model.summary.amountPaid);
    if (model.summary.hasBalance) totalRow("Balance due", model.summary.balanceAmount, { bold: true, color: "#b3273f" });

    // ── Payments ──
    if (model.payments.length) {
      heading("Payments received");
      ensure(20);
      doc.rect(left, y - 2, contentWidth, 15).fill(TINT);
      drawText(doc, "RECEIPT NO.", left + 4, y + 1, { width: 150, size: 7, bold: true, color: MAROON });
      drawText(doc, "DATE", left + 170, y + 1, { width: 150, size: 7, bold: true, color: MAROON });
      drawText(doc, "MODE", left + 330, y + 1, { width: 90, size: 7, bold: true, color: MAROON });
      drawText(doc, "AMOUNT", right - 90, y + 1, { width: 86, size: 7, bold: true, color: MAROON, align: "right" });
      y += 18;
      for (const p of model.payments) {
        ensure(18);
        drawText(doc, p.receiptNo, left + 4, y, { width: 160, size: 9 });
        drawText(doc, p.date, left + 170, y, { width: 155, size: 9 });
        drawText(doc, p.mode, left + 330, y, { width: 90, size: 9 });
        drawText(doc, p.amount, right - 90, y, { width: 86, size: 9, bold: true, align: "right" });
        y += 14;
        rule(RULE, y - 2);
      }
    }

    // ── Contact us ──
    const contactRows = [
      ["Address", model.temple.address],
      ["Phone", model.temple.phone],
      ["Email", model.temple.email],
    ].filter(([, v]) => v);
    if (contactRows.length) {
      ensure(30 + contactRows.length * 14);
      y += 14;
      doc.roundedRect(left, y, contentWidth, 22 + contactRows.length * 14, 4).fill(TINT);
      drawText(doc, "CONTACT US", left + 12, y + 8, { width: 200, size: 8, bold: true, color: MAROON });
      drawText(doc, `Questions about this booking? Quote ${model.summary.bookingNumber}.`, left + 150, y + 8, { width: contentWidth - 162, size: 8, color: MUTED, align: "right" });
      let cy = y + 24;
      for (const [label, value] of contactRows) {
        drawText(doc, label, left + 12, cy, { width: 60, size: 8.5, bold: true, color: MUTED });
        drawText(doc, value, left + 72, cy, { width: contentWidth - 84, size: 8.5 });
        cy += 14;
      }
      y += 22 + contactRows.length * 14;
    }

    // ── Footer on every page ──
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      doc.page.margins.bottom = 0; // otherwise text this low would push pdfkit onto a new page
      rule(RULE, doc.page.height - 48);
      drawText(doc, "This is a computer-generated receipt and does not need a signature.", left, doc.page.height - 42, { width: contentWidth - 80, size: 7.5, color: MUTED });
      drawText(doc, `Page ${i + 1} of ${range.count}`, right - 80, doc.page.height - 42, { width: 80, size: 7.5, color: MUTED, align: "right" });
    }
    doc.end();
  });
}

module.exports = { buildBookingPdf };
