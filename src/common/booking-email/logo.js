/**
 * The entity's logo as image bytes for the PDF. The logo is stored as a public https address (the image uploaded in
 * the Entity master), so it is fetched with a short timeout. pdfkit draws PNG and JPEG only, so a WebP logo (the Entity
 * master accepts WebP) is converted to PNG first. A missing logo, a failed download or an unreadable image returns
 * null and the PDF shows the temple name as text instead.
 */
const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 1024 * 1024;

const isPngOrJpeg = (b) => b.length > 4 && ((b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b[0] === 0xff && b[1] === 0xd8));

async function loadLogo(url) {
  const value = String(url || "").trim();
  if (!/^https:\/\//i.test(value)) return null;
  try {
    const res = await fetch(value, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
    if (isPngOrJpeg(bytes)) return bytes;
    // WebP (or any other format sharp can read) -> PNG, keeping transparency.
    return await require("sharp")(bytes).png().toBuffer();
  } catch {
    return null;
  }
}

module.exports = { loadLogo };
