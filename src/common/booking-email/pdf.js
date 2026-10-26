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

// ── Simple vector assets, drawn straight into the PDF (no image files) ─────────────────────────────────────────

/** Line icons on a 24x24 grid, as drawing steps: an SVG path, a rectangle or a circle. */
const ICONS = {
  calendar: [{ rect: [3, 4.5, 18, 17, 2.5] }, { p: "M16 2.5v4M8 2.5v4M3 10.5h18" }],
  user: [{ circle: [12, 7.5, 4] }, { p: "M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" }],
  bag: [{ p: "M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0" }],
  card: [{ rect: [1.5, 4.5, 21, 15, 2.5] }, { p: "M1.5 10h21M5 15.5h5" }],
  pin: [{ p: "M20 10c0 6.5-8 12.5-8 12.5S4 16.5 4 10a8 8 0 0 1 16 0z" }, { circle: [12, 10, 3] }],
  check: [{ p: "M20 6 9 17l-5-5" }],
  phone: [{ p: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" }],
  mail: [{ rect: [2, 4.5, 20, 15, 2.5] }, { p: "M22 7 12 13.5 2 7" }],
  star: [{ p: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8l-6.2 3.3L7 14.2 2 9.3l6.9-1L12 2z" }],
  list: [{ p: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" }],
  heart: [{ p: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z" }],
};
const SECTION_ICON = { Item: "bag", Service: "list", GeneralItem: "heart", Event: "star" };

function icon(doc, name, x, y, size, color, lineWidth = 2) {
  doc.save();
  doc.translate(x, y).scale(size / 24);
  doc.lineWidth(lineWidth).strokeColor(color).lineCap("round").lineJoin("round");
  for (const step of ICONS[name] || []) {
    if (step.p) doc.path(step.p).stroke();
    else if (step.rect) doc.roundedRect(...step.rect).stroke();
    else if (step.circle) doc.circle(...step.circle).stroke();
  }
  doc.restore();
}

/** A simple gopuram (temple tower) silhouette, built from stacked tiers. Used faintly behind the header title. */
function gopuram(doc, cx, baseY, scale, color, opacity) {
  doc.save();
  doc.fillColor(color).fillOpacity(opacity);
  const tiers = [
    { w: 74, h: 12 },
    { w: 64, h: 12 },
    { w: 54, h: 12 },
    { w: 44, h: 12 },
    { w: 34, h: 12 },
    { w: 24, h: 12 },
  ];
  let y = baseY;
  doc.rect(cx - 42 * scale, y - 10 * scale, 84 * scale, 10 * scale).fill();
  y -= 10 * scale;
  for (const t of tiers) {
    const w = t.w * scale;
    const h = t.h * scale;
    doc.rect(cx - w / 2, y - h, w, h).fill();
    // a small step on each tier, so it reads as a tower rather than a block
    doc.rect(cx - w / 2 - 3 * scale, y - 2.5 * scale, w + 6 * scale, 2.5 * scale).fill();
    y -= h;
  }
  doc.moveTo(cx - 9 * scale, y).lineTo(cx, y - 16 * scale).lineTo(cx + 9 * scale, y).fill();
  doc.circle(cx, y - 19 * scale, 2.2 * scale).fill();
  doc.restore();
}

/** One curl of the footer ornament; dir is -1 (left) or 1 (right). */
function curl(doc, x, y, dir, color) {
  doc.save();
  doc.lineWidth(0.9).strokeColor(color).lineCap("round");
  doc.moveTo(x, y).bezierCurveTo(x + dir * 7, y - 7, x + dir * 15, y + 7, x + dir * 24, y).stroke();
  doc.moveTo(x + dir * 24, y).bezierCurveTo(x + dir * 28, y - 4, x + dir * 31, y - 1, x + dir * 29, y + 2).stroke();
  doc.circle(x + dir * 34, y, 1.4).fill(color);
  doc.restore();
}

const CREAM = "#fbf6ee";
const CARD_BG = "#fcf9f3";
const CARD_LINE = "#eadfcd";
const GOLD_LINE = "#d9a93c";
const GOLD_SOFT = "#e9cf94";

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

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const left = 40;
    const right = pageW - 40;
    const contentWidth = right - left;
    const bottom = pageH - 76;
    let y = 40;

    // The warm cream page, painted on every page before anything else.
    const paintBackground = () => doc.rect(0, 0, pageW, pageH).fill(CREAM);
    paintBackground();
    doc.on("pageAdded", paintBackground);

    const ensure = (needed) => {
      if (y + needed > bottom) {
        doc.addPage();
        y = 40;
      }
    };
    const rule = (color = RULE, at = y) => doc.moveTo(left, at).lineTo(right, at).lineWidth(0.7).strokeColor(color).stroke();

    // Maroon gradient, as on the Admin Panel's headers and table heads.
    const maroonGradient = (x, gy, w, h) => {
      const g = doc.linearGradient(x, gy, x + w, gy + h);
      g.stop(0, "#5a0e1c").stop(0.55, MAROON).stop(1, "#932239");
      return g;
    };
    const maroonFill = (x, fy, w, h, radius = 0) => doc.roundedRect(x, fy, w, h, radius).fill(maroonGradient(x, fy, w, h));

    const tableHead = (labels) => {
      ensure(26);
      maroonFill(left, y - 3, contentWidth, 20, 6);
      for (const l of labels) drawText(doc, l.text, l.x, y + 1.5, { width: l.width, size: 7.2, bold: true, color: "#ffffff", align: l.align || "left" });
      y += 24;
    };
    const heading = (text, iconName) => {
      ensure(104); // the heading, the column heads and at least the first row stay together
      y += 12;
      icon(doc, iconName, left + 1, y - 1, 16, MAROON, 1.9);
      const titleW = widthOf(doc.fontSize(13.5), text.toUpperCase(), true);
      drawText(doc, text.toUpperCase(), left + 24, y, { width: contentWidth - 24, size: 13.5, bold: true, color: MAROON });
      y += 21;
      doc.rect(left, y, 24 + titleW, 2.4).fill(MAROON);
      doc.rect(left + 24 + titleW, y + 0.7, contentWidth - 24 - titleW, 0.9).fill(GOLD_SOFT);
      y += 12;
    };

    // ── Header ──
    // Left: logo (or the temple name), the address and the contact details.
    const leftW = 270;
    let ly = 28;
    let logoDrawn = false;
    if (model.temple.logo) {
      try {
        const img = doc.openImage(model.temple.logo);
        const scale = Math.min(200 / img.width, 62 / img.height, 1.6);
        doc.image(model.temple.logo, left, ly, { width: img.width * scale, height: img.height * scale });
        ly += img.height * scale + 12;
        logoDrawn = true;
      } catch {
        // An unreadable image falls back to the name below.
      }
    }
    if (!logoDrawn) {
      ly += drawText(doc, model.temple.name, left, ly, { width: leftW, size: 17, bold: true, color: MAROON }) + 2;
      if (model.temple.tamilName) ly += drawText(doc, model.temple.tamilName, left, ly, { width: leftW, size: 10.5, color: MAROON }) + 6;
    }
    if (model.temple.address) {
      icon(doc, "pin", left, ly - 1, 13, MAROON, 2);
      ly += drawText(doc, model.temple.address, left + 19, ly, { width: leftW - 19, size: 9.5 }) + 3;
    }
    let contactX = left;
    if (model.temple.phone) {
      icon(doc, "phone", contactX, ly, 10.5, MUTED, 2);
      drawText(doc, model.temple.phone, contactX + 15, ly + 0.5, { width: 110, size: 8.3, color: MUTED });
      contactX += 15 + widthOf(doc.fontSize(8.3), model.temple.phone, false) + 14;
    }
    if (model.temple.email) {
      icon(doc, "mail", contactX, ly, 10.5, MUTED, 2);
      drawText(doc, model.temple.email, contactX + 15, ly + 0.5, { width: 170, size: 8.3, color: MUTED });
    }
    if (model.temple.phone || model.temple.email) ly += 14;
    // Where the header ends: below the left column, and never shorter than the title panel needs.
    const headBottom = Math.max(ly + 6, 136);
    const panelBottom = headBottom - 8;

    // Right: the slanted maroon panel with the title, a faint temple tower and the thank-you line.
    const px = 330;
    doc.save();
    doc.path(`M ${px - 15} 0 L ${px - 1} 0 L ${px + 20} ${panelBottom - 22} L ${px + 11} ${panelBottom - 19} Z`).fill(GOLD_LINE); // the gold sliver along the slant
    const panel = `M ${px} 0 L ${pageW} 0 L ${pageW} ${panelBottom} L ${px + 52} ${panelBottom} Q ${px + 28} ${panelBottom} ${px + 21} ${panelBottom - 22} Z`;
    doc.path(panel).fill(maroonGradient(px, 0, pageW - px, panelBottom));
    doc.restore();
    doc.save();
    doc.path(panel).clip();
    gopuram(doc, pageW - 40, panelBottom - 2, 0.95, "#ffffff", 0.09);
    gopuram(doc, pageW - 100, panelBottom - 2, 0.6, "#ffffff", 0.07);
    doc.restore();
    const tx = px + 36;
    const tw = pageW - tx - 28;
    const titleH = drawText(doc, "BOOKING CONFIRMATION RECEIPT", tx, 26, { width: tw, size: 15, bold: true, color: "#ffffff" });
    doc.rect(tx, 26 + titleH + 7, 32, 2.6).fill(GOLD_LINE);
    drawText(doc, "Your booking has been successfully confirmed. Thank you for choosing " + model.temple.name + ".", tx, 26 + titleH + 19, { width: tw, size: 8.4, color: "#f3dde0" });

    y = headBottom;
    doc.rect(0, y, pageW, 2.6).fill(GOLD_LINE);
    y += 20;

    // ── Booking details (left) and customer contact details (right), as two cards with maroon heads ──
    const gap = 16;
    const cardW = (contentWidth - gap) / 2;
    const labelW = 76;
    const colonX = 12 + labelW;
    const valueX = colonX + 12;
    const rowsOf = (rows) => rows.filter(([, v]) => v);
    const rowHeight = (value) => Math.max(14, measure(doc, value, { width: cardW - valueX - 12, size: 9.5, bold: true }));
    const cardHeight = (rows) => 44 + rowsOf(rows).reduce((sum, [, v]) => sum + rowHeight(v) + 6, 0) + 4;
    const card = (x, cy0, title, iconName, rows, h, pill) => {
      doc.roundedRect(x, cy0, cardW, h, 9).fillAndStroke(CARD_BG, CARD_LINE);
      const g = maroonGradient(x, cy0, cardW, 32);
      doc.roundedRect(x, cy0, cardW, 32, 9).fill(g);
      doc.rect(x, cy0 + 16, cardW, 16).fill(g); // square the head's lower corners
      icon(doc, iconName, x + 12, cy0 + 7, 17, "#ffffff", 1.8);
      drawText(doc, title.toUpperCase(), x + 36, cy0 + 10, { width: pill ? cardW - 150 : cardW - 50, size: 10.5, bold: true, color: "#ffffff" });
      if (pill) {
        const tw2 = widthOf(doc.fontSize(7.8), pill.text, true);
        const pw = tw2 + 28;
        doc.roundedRect(x + cardW - 12 - pw, cy0 + 8, pw, 17, 8.5).fill(pill.bg);
        icon(doc, "check", x + cardW - 12 - pw + 8, cy0 + 12.5, 8.5, "#ffffff", 3.4);
        drawText(doc, pill.text, x + cardW - 12 - pw + 19, cy0 + 12, { width: tw2 + 4, size: 7.8, bold: true, color: "#ffffff" });
      }
      let ry = cy0 + 44;
      for (const [label, value] of rowsOf(rows)) {
        drawText(doc, label.toUpperCase(), x + 12, ry + 1.5, { width: labelW, size: 7, bold: true, color: MUTED });
        drawText(doc, ":", x + colonX, ry, { width: 8, size: 9.5, color: MUTED });
        // A long unbroken value (an email address) is made a little smaller rather than running out of the card.
        const avail = cardW - valueX - 12;
        const natural = widthOf(doc.fontSize(9.5), value, true);
        const size = natural > avail && !/\s/.test(value) ? Math.max(7, (9.5 * avail) / natural) : 9.5;
        ry += rowHeight(value) > 14 ? drawText(doc, value, x + valueX, ry, { width: avail, size: 9.5, bold: true }) + 6 : (drawText(doc, value, x + valueX, ry + (9.5 - size) / 2, { width: avail + 2, size, bold: true }), 20);
      }
    };
    const bookingRows = [
      ["Booking no.", model.summary.bookingNumber],
      ["Order no.", model.summary.orderNumber],
      ["Receipt no.", model.summary.receiptNumbers],
      ["Booked on", model.summary.bookedOn],
      ["Booked via", model.summary.portalLabel],
      ["Booked by", model.bookedBy],
    ];
    const customerRows = [
      ["Name", model.customer.name],
      ["Customer code", model.customer.code],
      ["Mobile", model.customer.mobile],
      ["Email", model.customer.email],
    ];
    const cardsH = Math.max(cardHeight(bookingRows), cardHeight(customerRows));
    ensure(cardsH + 10);
    const paid = model.summary.paymentStatus === "paid";
    card(left, y, "Booking details", "calendar", bookingRows, cardsH, { text: model.summary.paymentStatusLabel.toUpperCase(), bg: paid ? "#1f9d55" : "#c98a0b" });
    card(left + cardW + gap, y, "Customer contact details", "user", customerRows, cardsH);
    y += cardsH + 10;
    if (model.remarks) {
      y += drawText(doc, `Remarks: ${model.remarks}`, left, y, { width: contentWidth, size: 8.8, color: MUTED }) + 4;
    }

    // ── Line sections ──
    const cols = { desc: left + 12, qty: left + 264, unit: left + 296, gst: left + 356 };
    const descW = 246;
    for (const section of model.sections) {
      heading(section.title, SECTION_ICON[section.key] || "list");
      tableHead([
        { text: section.key === "Event" ? "EVENT" : "DESCRIPTION", x: cols.desc, width: descW },
        { text: section.key === "Event" ? "SEATS" : "QTY", x: cols.qty, width: 30, align: "right" },
        { text: "UNIT PRICE", x: cols.unit, width: 54, align: "right" },
        { text: "GST INCLUDED", x: cols.gst, width: 74, align: "right" },
        { text: "AMOUNT", x: right - 80, width: 68, align: "right" },
      ]);

      section.lines.forEach((l) => {
        const details = [
          l.code ? `Code: ${l.code}` : "",
          l.session ? `Session: ${l.session}` : "",
          l.slot ? `Slot: ${l.slot}` : "",
          l.deities.length ? `Deities: ${l.deities.join(", ")}` : "",
          l.devotees.length ? `Devotees: ${l.devotees.join(", ")}` : "",
        ].filter(Boolean);
        const nameH = measure(doc, l.name, { width: descW, size: 10.5, bold: true });
        const detailH = details.reduce((sum, d) => sum + measure(doc, d, { width: descW - 8, size: 8.2 }), 0);
        const rowH = nameH + detailH + 10;
        ensure(rowH + 4);
        drawText(doc, l.name, cols.desc, y, { width: descW, size: 10.5, bold: true, color: MAROON });
        drawText(doc, String(l.quantity), cols.qty, y + 1, { width: 30, size: 9.5, align: "right" });
        drawText(doc, l.unitPrice, cols.unit, y + 1, { width: 54, size: 9.5, align: "right" });
        drawText(doc, l.gst, cols.gst, y + 1, { width: 74, size: 8.3, align: "right", color: MUTED });
        drawText(doc, l.lineTotal, right - 80, y, { width: 68, size: 10, bold: true, align: "right", color: MAROON });
        let dy = y + nameH;
        for (const d of details) dy += drawText(doc, d, cols.desc + 8, dy, { width: descW - 8, size: 8.2, color: MUTED });
        y += rowH;
        rule("#e7dcc9", y - 4);
      });
    }

    // ── Totals ──
    ensure(130);
    y += 12;
    const totalsW = 240;
    const totalsX = right - totalsW;
    const boxTop = y;
    const hasBalance = model.summary.hasBalance;
    const boxH = 18 + 2 * 17 + 34 + 17 + (hasBalance ? 27 : 0) + 6;
    doc.roundedRect(totalsX, boxTop, totalsW, boxH, 9).fillAndStroke(CARD_BG, CARD_LINE);
    y += 12;
    const plainRow = (label, value) => {
      drawText(doc, label, totalsX + 14, y, { width: 130, size: 9.5, color: INK });
      drawText(doc, value, totalsX + 14 + 130, y, { width: totalsW - 28 - 130, size: 9.5, color: INK, align: "right" });
      y += 17;
    };
    plainRow("Subtotal (before GST)", model.summary.subtotal);
    plainRow("GST", model.summary.gstAmount);
    y += 3;
    maroonFill(totalsX + 2, y - 3, totalsW - 4, 27, 7);
    drawText(doc, "TOTAL", totalsX + 16, y + 4.5, { width: 100, size: 11, bold: true, color: "#ffffff" });
    drawText(doc, model.summary.grandTotal, totalsX + 16 + 90, y + 3, { width: totalsW - 32 - 90, size: 13, bold: true, color: "#ffffff", align: "right" });
    y += 33;
    plainRow("Amount paid", model.summary.amountPaid);
    if (hasBalance) {
      y += 1;
      doc.roundedRect(totalsX + 2, y - 3, totalsW - 4, 24, 7).fill("#f9e4e7");
      drawText(doc, "BALANCE DUE", totalsX + 16, y + 3.5, { width: 110, size: 9, bold: true, color: "#b3273f" });
      drawText(doc, model.summary.balanceAmount, totalsX + 16 + 100, y + 2.5, { width: totalsW - 32 - 100, size: 11, bold: true, color: "#b3273f", align: "right" });
      y += 26;
    }
    y = boxTop + boxH + 4;

    // ── Payments ──
    if (model.payments.length) {
      heading("Payments received", "card");
      tableHead([
        { text: "RECEIPT NO.", x: left + 12, width: 150 },
        { text: "DATE", x: left + 176, width: 150 },
        { text: "MODE", x: left + 340, width: 90 },
        { text: "AMOUNT", x: right - 100, width: 88, align: "right" },
      ]);
      model.payments.forEach((p) => {
        ensure(22);
        drawText(doc, p.receiptNo, left + 12, y, { width: 160, size: 9.5 });
        drawText(doc, p.date, left + 176, y, { width: 155, size: 9.5 });
        drawText(doc, p.mode, left + 340, y, { width: 90, size: 9.5 });
        drawText(doc, p.amount, right - 100, y, { width: 88, size: 9.8, bold: true, align: "right", color: MAROON });
        y += 20;
        rule("#e7dcc9", y - 4);
      });
    }

    // ── Footer on every page: the temple's name between two ornaments ──
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      doc.page.margins.bottom = 0; // otherwise text this low would push pdfkit onto a new page
      const fy = pageH - 50;
      const label = model.temple.name.toUpperCase();
      doc.font("latin").fontSize(8.5);
      const lw = doc.widthOfString(label, { characterSpacing: 3 });
      const cx = pageW / 2;
      doc.fillColor("#a67c2e").text(label, cx - lw / 2, fy - 4, { characterSpacing: 3, lineBreak: false });
      const oL = cx - lw / 2 - 12;
      const oR = cx + lw / 2 + 12;
      curl(doc, oL, fy, -1, GOLD_LINE);
      curl(doc, oR, fy, 1, GOLD_LINE);
      doc.moveTo(left, fy).lineTo(oL - 40, fy).lineWidth(0.8).strokeColor(MAROON).stroke();
      doc.moveTo(oR + 40, fy).lineTo(right, fy).lineWidth(0.8).strokeColor(MAROON).stroke();
      drawText(doc, "This is a computer-generated receipt and does not need a signature.", left, pageH - 30, { width: contentWidth - 70, size: 7, color: MUTED });
      drawText(doc, `Page ${i + 1} of ${range.count}`, right - 70, pageH - 30, { width: 70, size: 7, color: MUTED, align: "right" });
    }
    doc.end();
  });
}

module.exports = { buildBookingPdf };
