/**
 * Access Control — the allow list for the admin and POS sites. Managed only
 * by the System Admin (SUPER_ADMIN user type), from Administration > Access
 * Control. Mounted at /access-control behind authGuard + adminOnly (see
 * routes/index.js); the super-admin rule below is enforced here on the server,
 * so hiding the menu is never the only protection.
 *
 *   GET    /                 the whole screen's data
 *   POST   /entries          add an address or small range
 *   DELETE /entries/:id      remove one
 *   PUT    /mode             off | report | enforce
 *
 * What the list actually does is decided per visit in
 * common/utils/ip-access-service (called by Nginx through controllers/
 * access-check). This file only edits the list and guards the editor against
 * locking itself out:
 *   - "enforce" is refused unless the caller's own address is already allowed;
 *   - removing the entry that keeps the caller in is refused while enforcing;
 *   - private/LAN addresses, ranges wider than /24, duplicates and an
 *     over-long list are refused (common/utils/ip-access parseEntry()).
 * Every change is attributed (createdBy / updatedBy on the records) and logged.
 */
const express = require("express");
const mongoose = require("mongoose");
const env = require("../../config/env");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");
const validateBody = require("../../common/middleware/validate");
const { isSuperAdmin } = require("../../common/utils/escalation");
const { parseEntry, buildMatcher, normalizeIp, MIN_PREFIX } = require("../../common/utils/ip-access");
const ipAccess = require("../../common/utils/ip-access-service");
const { IpAccessEntry } = require("../../models/ip-access-entries");
const { IpAccessSetting } = require("../../models/ip-access-settings");
const { IpAccessVisit } = require("../../models/ip-access-visits");
const { addSchema, modeSchema } = require("./request-objects");

function mustBeSuperAdmin(req, res, next) {
  if (isSuperAdmin(req)) return next();
  return exceptionHandler({
    res,
    error: "Access Control is restricted to the system administrator.",
    statusCode: 403,
  });
}

const fail = (res, error) => exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });

const who = (req) => req.auth?.userId || "unknown";

async function currentMode() {
  const setting = await IpAccessSetting.findOne({}).lean();
  return setting?.mode || "off";
}

/** How many lines of access history the screen is sent, newest first. */
const HISTORY_LIMIT = 200;

/** Everything the screen shows, built fresh from the database. */
async function buildState(req) {
  const [storedMode, rows, visits] = await Promise.all([
    currentMode(),
    IpAccessEntry.find({ isDeleted: false }).sort({ createdAt: 1 }).lean(),
    IpAccessVisit.find({}).sort({ lastSeenAt: -1 }).limit(HISTORY_LIMIT).lean(),
  ]);
  const always = ipAccess.alwaysAllowed();
  const yourAddress = normalizeIp(req.ip);
  const onList = buildMatcher(rows.map((r) => r.ip));
  const yourAddressAllowed = always.matcher(yourAddress) || onList(yourAddress);

  return {
    mode: storedMode,
    effectiveMode: ipAccess.effectiveMode(storedMode),
    forceOff: env.IP_ACCESS_FORCE_OFF,
    yourAddress,
    yourAddressAllowed,
    alwaysAllowed: always.entries,
    entries: rows.map((r) => ({
      _id: String(r._id),
      ip: r.ip,
      label: r.label || "",
      addedBy: r.createdByInfo?.name || "",
      addedAt: r.createdAt,
    })),
    history: visits.map((v) => ({
      ip: v.ip,
      host: v.host || "",
      result: v.result,
      firstSeenAt: v.firstSeenAt,
      lastSeenAt: v.lastSeenAt,
      // Offer "Add" only for a public address that is not already on the list.
      canAdd: parseEntry(v.ip).ok && !onList(v.ip),
    })),
    limits: { maxEntries: ipAccess.MAX_ENTRIES, minPrefix: MIN_PREFIX },
  };
}

async function getState(req, res) {
  try {
    return responseHandler({ res, response: await buildState(req) });
  } catch (error) {
    return fail(res, error);
  }
}

async function addEntry(req, res) {
  try {
    const parsed = parseEntry(req.body.ip);
    if (!parsed.ok) throw parsed.error;

    if ((await IpAccessEntry.countDocuments({ isDeleted: false })) >= ipAccess.MAX_ENTRIES) {
      throw `The list is full (${ipAccess.MAX_ENTRIES} entries). Remove one that is no longer needed first.`;
    }
    if (await IpAccessEntry.findOne({ ip: parsed.value, isDeleted: false }).lean()) {
      throw `${parsed.value} is already on the list.`;
    }

    await IpAccessEntry.create({ ip: parsed.value, label: req.body.label || "", createdBy: req.auth.userId });
    ipAccess.invalidate();
    console.log(`>>> [ip-access] ${who(req)} added ${parsed.value} ("${req.body.label || ""}")`);

    return responseHandler({ res, response: await buildState(req), successMessage: "Address added." });
  } catch (error) {
    return fail(res, error);
  }
}

async function removeEntry(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw "That list entry does not exist.";

    const rows = await IpAccessEntry.find({ isDeleted: false }).lean();
    const entry = rows.find((r) => String(r._id) === id);
    if (!entry) throw "That list entry does not exist.";

    // While enforcing, never let the caller remove the entry that keeps them in.
    const mode = ipAccess.effectiveMode(await currentMode());
    if (mode === "enforce") {
      const you = normalizeIp(req.ip);
      const stillAllowed =
        ipAccess.alwaysAllowed().matcher(you) || buildMatcher(rows.filter((r) => String(r._id) !== id).map((r) => r.ip))(you);
      if (!stillAllowed) {
        throw `Removing ${entry.ip} would lock you out: your current address (${you || "unknown"}) is allowed only by this entry. Add another entry for it first, or switch the restriction to "off" before removing this one.`;
      }
    }

    await IpAccessEntry.findByIdAndUpdate(id, { isDeleted: true, updatedBy: req.auth.userId });
    ipAccess.invalidate();
    console.log(`>>> [ip-access] ${who(req)} removed ${entry.ip}`);

    return responseHandler({ res, response: await buildState(req), successMessage: "Address removed." });
  } catch (error) {
    return fail(res, error);
  }
}

async function setMode(req, res) {
  try {
    const { mode } = req.body;

    if (mode === "enforce") {
      const rows = await IpAccessEntry.find({ isDeleted: false }).select("ip").lean();
      const you = normalizeIp(req.ip);
      const allowedNow = ipAccess.alwaysAllowed().matcher(you) || buildMatcher(rows.map((r) => r.ip))(you);
      if (!allowedNow) {
        throw `Your current address (${you || "unknown"}) is not on the list, so turning enforcement on would lock you out of the admin site. Add it first (use "Add this address"), or turn on "report" to see what would be blocked.`;
      }
    }

    await IpAccessSetting.findOneAndUpdate({}, { mode, updatedBy: req.auth.userId }, { new: true, upsert: true, setDefaultsOnInsert: true });
    ipAccess.invalidate();
    console.log(`>>> [ip-access] ${who(req)} set the restriction to "${mode}"`);

    return responseHandler({ res, response: await buildState(req), successMessage: `Restriction set to "${mode}".` });
  } catch (error) {
    return fail(res, error);
  }
}

const router = express.Router();
router.use(mustBeSuperAdmin);
router.get("/", getState);
router.post("/entries", validateBody(addSchema), addEntry);
router.delete("/entries/:id", removeEntry);
router.put("/mode", validateBody(modeSchema), setMode);

module.exports = router;
module.exports.mustBeSuperAdmin = mustBeSuperAdmin;
module.exports.getState = getState;
module.exports.addEntry = addEntry;
module.exports.removeEntry = removeEntry;
module.exports.setMode = setMode;
