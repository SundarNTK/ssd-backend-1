/**
 * The decision "may this visitor open the admin / POS site?", shared by the
 * check Nginx makes on every visit (controllers/access-check) and by the
 * Access Control screen's own safeguards (controllers/ip-access).
 *
 * Order of precedence, strongest first, so the way back in never depends on
 * the database or on anyone having saved the list correctly:
 *
 *   1. IP_ACCESS_FORCE_OFF=true            -> allowed (emergency switch)
 *   2. IP_ACCESS_ALWAYS_ALLOWED matches    -> allowed (set on the server)
 *   3. mode "off" (allow all addresses)    -> allowed
 *   4. address is on the saved list        -> allowed
 *   5. mode "report"                       -> allowed, and recorded as "would be blocked"
 *   6. mode "enforce"                      -> NOT allowed
 *
 * Steps 1 and 2 never need the database to decide, so they still work if it is
 * down. Anything else that cannot be decided (the database fails) throws, and
 * the caller answers with an error: the restriction fails closed, not open.
 *
 * Every decision is also written to the access history (models/ip-access-
 * visits) — in the background, at most once a minute per address and site, and
 * never allowed to slow down or change the decision: if the history cannot be
 * written, the visit is still decided exactly the same way.
 */
const env = require("../../config/env");
const { IpAccessEntry } = require("../../models/ip-access-entries");
const { IpAccessSetting } = require("../../models/ip-access-settings");
const { IpAccessVisit } = require("../../models/ip-access-visits");
const { parseEntry, buildMatcher, normalizeIp } = require("./ip-access");

/** The list and mode are held in memory this long; any change made on screen clears it at once. */
const CACHE_MS = 30 * 1000;
/** A deliberately small list: this is a temple's few locations, not a firewall. */
const MAX_ENTRIES = 100;
/** The same address/site/result is written to the history at most this often. */
const HISTORY_WRITE_EVERY_MS = 60 * 1000;
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

let cache = null;
const lastWritten = new Map();

/** Server-side always-allowed list, parsed once per distinct env value. */
let alwaysCache = { raw: null, entries: [], matcher: () => false };
function alwaysAllowed() {
  const raw = env.IP_ACCESS_ALWAYS_ALLOWED || "";
  if (alwaysCache.raw === raw) return alwaysCache;

  const entries = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const parsed = parseEntry(part, { allowPrivate: true, minPrefix: 8 });
    if (parsed.ok) entries.push(parsed.value);
    else console.warn(`>>> [ip-access] IP_ACCESS_ALWAYS_ALLOWED: ignoring "${part.slice(0, 50)}" - ${parsed.error}`);
  }
  alwaysCache = { raw, entries, matcher: buildMatcher(entries) };
  return alwaysCache;
}

async function loadState() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;

  const [setting, rows] = await Promise.all([
    IpAccessSetting.findOne({}).lean(),
    IpAccessEntry.find({ isDeleted: false, status: 1 }).select("ip").lean(),
  ]);
  const entries = rows.map((r) => r.ip);
  cache = {
    at: Date.now(),
    mode: setting?.mode || "off",
    entries,
    listMatch: buildMatcher(entries),
  };
  return cache;
}

function invalidate() {
  cache = null;
}

/** The mode that actually applies, once the emergency switch is considered. */
function effectiveMode(storedMode) {
  return env.IP_ACCESS_FORCE_OFF ? "off" : storedMode;
}

/**
 * Writes one line of access history, in the background. Never throws and is
 * never awaited by the decision; a failure is logged and the visit carries on.
 */
function noteVisit({ ip, host, result, reason }) {
  const now = Date.now();
  const day = new Date(now + SGT_OFFSET_MS).toISOString().slice(0, 10);
  const key = `${day}|${ip}|${host}|${result}`;
  if (now - (lastWritten.get(key) || 0) < HISTORY_WRITE_EVERY_MS) return;
  lastWritten.set(key, now);
  if (lastWritten.size > 5000) lastWritten.clear();

  if (result !== "allowed") {
    console.warn(`>>> [ip-access] ${result === "blocked" ? "BLOCKED" : "WOULD BLOCK"} ${ip} -> ${host || "unknown host"}`);
  }

  const at = new Date(now);
  try {
    Promise.resolve(
      IpAccessVisit.updateOne(
        { day, ip, host, result },
        { $set: { reason, lastSeenAt: at }, $setOnInsert: { firstSeenAt: at } },
        { upsert: true }
      )
    ).catch((error) => console.error(">>> [ip-access] could not write the access history:", error.message));
  } catch (error) {
    console.error(">>> [ip-access] could not write the access history:", error.message);
  }
}

async function evaluate(ip) {
  if (env.IP_ACCESS_FORCE_OFF) return { allowed: true, reason: "force-off", result: "allowed" };
  if (alwaysAllowed().matcher(ip)) return { allowed: true, reason: "always-allowed", result: "allowed" };

  const state = await loadState();
  if (state.mode === "off") return { allowed: true, reason: "mode-off", result: "allowed" };
  if (state.listMatch(ip)) return { allowed: true, reason: "listed", result: "allowed" };
  if (state.mode === "report") return { allowed: true, reason: "report-only", result: "would-block" };
  return { allowed: false, reason: "not-listed", result: "blocked" };
}

/**
 * @param {string} rawIp  the visitor's address as resolved by express (req.ip)
 * @param {{ host?: string }} [context]
 * @returns {Promise<{ allowed: boolean, reason: string, result: string }>}
 */
async function decide(rawIp, { host } = {}) {
  const ip = normalizeIp(rawIp);
  const outcome = await evaluate(ip);
  noteVisit({ ip: ip || "unknown", host: host || "", result: outcome.result, reason: outcome.reason });
  return outcome;
}

module.exports = {
  MAX_ENTRIES,
  decide,
  loadState,
  invalidate,
  effectiveMode,
  alwaysAllowed,
};
