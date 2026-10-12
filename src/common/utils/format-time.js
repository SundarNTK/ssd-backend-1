/** "20:00" -> "8:00 PM" (anything that isn't an HH:MM string is returned as it came). */
function to12Hour(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? "").trim());
  if (!m) return String(hhmm ?? "");
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

module.exports = { to12Hour };
