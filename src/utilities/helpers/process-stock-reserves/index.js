/**
 * Scheduler for Stock Reserves (see common/utils/stock-reserve).
 *
 * Runs
 *  - once at start-up, which also catches up any session day the server slept through,
 *  - at the start of every day in Singapore (00:00:05 SGT), and
 *  - every 15 minutes as a safety net (retries failed rows, takes over abandoned locks).
 * Each run handles every reserve whose session date is today OR EARLIER and that is not processed yet, never a future
 * date, and is idempotent - extra runs change nothing.
 */
const { processDueReserves } = require("../../../common/utils/stock-reserve");

const SG_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds from `now` to just after the next midnight in Singapore. */
function msUntilNextSingaporeMidnight(now = Date.now()) {
  const sgNow = now + SG_OFFSET_MS;
  const nextMidnight = (Math.floor(sgNow / DAY_MS) + 1) * DAY_MS;
  return nextMidnight - sgNow + 5000;
}

async function runOnce(label) {
  try {
    const r = await processDueReserves();
    if (r.due > 0) {
      console.log(`>>> [stock-reserve] ${label}: ${r.due} due, ${r.processed} processed (${r.shortages} with a shortage), ${r.failed} failed, ${r.skipped} skipped`);
    }
    return r;
  } catch (err) {
    console.error(`>>> [stock-reserve] ${label} run failed:`, err);
    return null;
  }
}

function startStockReserveJob() {
  void runOnce("start-up");

  const scheduleMidnight = () => {
    const timer = setTimeout(async () => {
      await runOnce("start of day");
      scheduleMidnight();
    }, msUntilNextSingaporeMidnight());
    if (timer.unref) timer.unref();
  };
  scheduleMidnight();

  const safety = setInterval(() => void runOnce("safety net"), 15 * 60 * 1000);
  if (safety.unref) safety.unref();
  console.log(">>> [stock-reserve] Job scheduled: start of each day (Singapore) + every 15 min safety net");
}

module.exports = { startStockReserveJob, msUntilNextSingaporeMidnight };
