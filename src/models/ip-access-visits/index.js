const mongoose = require("mongoose");

/**
 * Who opened (or tried to open) the admin and POS sites — the history shown on
 * Administration > Access Control. It is kept in the database, so it survives
 * a server restart.
 *
 * One row per address, per site, per result, per DAY (Singapore time), updated
 * as that address keeps visiting, rather than one row per page file: opening a
 * single admin page asks the check route for dozens of files, and storing each
 * would fill the database with noise. The row says "this address was seen on
 * this site, first at … and last at …".
 *
 * result:
 *   allowed      the visit was let through (on the list, always-allowed, or the
 *                restriction was off)
 *   would-block  report-only mode: it was let through but would have been
 *                refused under "only the listed addresses"
 *   blocked      refused
 *
 * Old rows are removed automatically after IP_ACCESS_VISIT_RETENTION_DAYS (the
 * TTL index below), so the collection stays small.
 */
const IP_ACCESS_VISIT_RESULTS = ["allowed", "would-block", "blocked"];
const IP_ACCESS_VISIT_RETENTION_DAYS = 365;

const ipAccessVisitSchema = new mongoose.Schema({
  day: { type: String, required: true }, // YYYY-MM-DD, Singapore time
  ip: { type: String, required: true },
  host: { type: String, default: "" },
  result: { type: String, enum: IP_ACCESS_VISIT_RESULTS, required: true },
  reason: { type: String, default: "" },
  firstSeenAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
});

ipAccessVisitSchema.index({ day: 1, ip: 1, host: 1, result: 1 }, { unique: true });
// Serves "newest first" and removes rows older than the retention period.
ipAccessVisitSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: IP_ACCESS_VISIT_RETENTION_DAYS * 24 * 60 * 60 });

module.exports = {
  IpAccessVisit: mongoose.model("IpAccessVisit", ipAccessVisitSchema, "ip_access_visits"),
  IP_ACCESS_VISIT_RESULTS,
  IP_ACCESS_VISIT_RETENTION_DAYS,
};
