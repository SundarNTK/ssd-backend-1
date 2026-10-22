/**
 * GET /access/check — the question Nginx asks before it lets a visit reach the
 * admin or POS site ("auth_request"; see docs/ip-access-control.md).
 *
 * It answers with a bare status code and no body:
 *   200  the visit may go on
 *   403  this visitor's address is not allowed
 *   503  the answer could not be worked out (database trouble) — Nginx then
 *        refuses the visit, so a fault never silently opens the sites
 *
 * Whose address is checked: `req.ip`. Nginx's internal check location sets
 * X-Forwarded-For to the visitor's real connection address, replacing
 * anything the visitor sent, and the app trusts exactly one proxy hop
 * (app.set("trust proxy", 1)). If someone calls this route through the public
 * API site instead, Nginx appends their own real address and express takes
 * that one, so the route can only ever tell a caller about themselves.
 *
 * Mounted in app.js BEFORE the rate limiter and the request log: it is called
 * for every file of every admin/POS page load, and counting those against the
 * visitor's request budget (or logging each one) would be wrong.
 */
const express = require("express");
const { decide } = require("../../common/utils/ip-access-service");

async function check(req, res) {
  res.set("Cache-Control", "no-store");
  try {
    const host = String(req.get("x-original-host") || "").slice(0, 100);
    const { allowed } = await decide(req.ip, { host });
    return res.sendStatus(allowed ? 200 : 403);
  } catch (error) {
    console.error(">>> [ip-access] check could not be completed:", error.message);
    return res.sendStatus(503);
  }
}

const router = express.Router();
router.get("/check", check);

module.exports = router;
module.exports.check = check;
