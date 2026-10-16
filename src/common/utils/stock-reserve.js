/**
 * Stock Reserve - stock set aside for a future session date (see models/stock-reserves).
 *
 *   createReserve    written when a booking for a FUTURE session day is confirmed (instead of deducting stock now).
 *   processReserve   run for a reserve whose session day has arrived: deducts what is in stock, records any shortage.
 *   processDueReserves  the scheduler's pass over every reserve that is due (also recovers missed days and failures).
 *   fulfilDeficits   called when stock comes in: outstanding shortages are settled first, oldest session date first;
 *                    only what is left raises the available stock.
 *   cancelReserve    drops a reserve that has not taken any stock yet.
 *
 * Every step is one conditional claim + the stock change + the movement row in one transaction, and every movement has
 * a unique requestId, so a repeated cron run, a retry or two admins clicking at once can never deduct twice.
 */
const StockReserve = require("../../models/stock-reserves");
const InventoryAdjustment = require("../../models/inventory-adjustments");
const { REF_MODELS, trackedFilter, runInTransaction, deductSold } = require("./inventory-stock");
const { templeToday } = require("./session-rule");

const STALE_LOCK_MS = 10 * 60 * 1000;

/** True when `sessionDate` ("YYYY-MM-DD") is still ahead of today in Singapore. */
const isFutureSession = (sessionDate, now = Date.now()) => /^\d{4}-\d{2}-\d{2}$/.test(String(sessionDate || "")) && String(sessionDate) > templeToday(now);

const historyEntry = (event, quantity, message, extra = {}) => ({ at: new Date(), event, quantity, message, ...extra });

/**
 * Records a reserve. Safe to call twice for the same booking line: the second call finds the first (reserveKey is unique).
 */
async function createReserve(
  { refType, refId, name, code, sessionDate, bookedQuantity, stockQuantity, reductionFactor = 1, orderId = null, bookingNumber = null, reserveKey, lateConfirmation = false, userId = null },
  { session } = {}
) {
  // Look first: a duplicate-key error inside a transaction would abort the whole transaction.
  const existing = await StockReserve.findOne({ reserveKey }).session(session || null);
  if (existing) return existing;
  try {
    const [doc] = await StockReserve.create(
      [
        {
          refType,
          refId,
          name,
          code,
          sessionDate,
          bookedQuantity,
          stockQuantity,
          reductionFactor,
          orderId,
          bookingNumber,
          reserveKey,
          lateConfirmation,
          createdBy: userId,
          history: [historyEntry("created", stockQuantity, `Reserved ${stockQuantity} for session ${sessionDate}${bookingNumber ? ` (booking ${bookingNumber})` : ""}${lateConfirmation ? " - paid after the payment hold expired" : ""}`, { by: userId, source: "booking" })],
        },
      ],
      { session }
    );
    return doc;
  } catch (err) {
    if (err?.code === 11000) return StockReserve.findOne({ reserveKey }).session(session || null);
    throw err;
  }
}

/**
 * Processes ONE reserve whose session day has arrived (or that is being retried). Returns { skipped: true } when it is
 * not due, already processed, or being processed by someone else.
 *
 * @param {{ now?: number, userId?: any, source?: "scheduler" | "manual", force?: boolean }} opts
 *   `force` (manual "process now") may run a reserve before its date is reached - never used by the scheduler.
 */
async function processReserve(id, { now = Date.now(), userId = null, source = "scheduler", force = false } = {}) {
  const today = templeToday(now);
  const staleBefore = new Date(now - STALE_LOCK_MS);
  const dueClause = force ? {} : { sessionDate: { $lte: today } };

  // Claim: only one caller moves it to "processing". A lock left behind by a crashed run is taken over after a while.
  const claim = await StockReserve.findOneAndUpdate(
    {
      _id: id,
      ...dueClause,
      $or: [{ status: { $in: ["upcoming", "failed"] } }, { status: "processing", lockedAt: { $lt: staleBefore } }],
    },
    { $set: { status: "processing", lockedAt: new Date(now) }, $inc: { attempts: 1 } },
    { returnDocument: "after" }
  );
  if (!claim) return { skipped: true };

  try {
    return await runInTransaction(async (session) => {
      const Model = REF_MODELS[claim.refType];
      const master = await Model.findOne(trackedFilter(Model, claim.refType, claim.refId)).select("name currentStock reservedStock").session(session || null);

      // No longer tracked (inventory switched off, or the master was removed): nothing to deduct.
      if (!master) {
        await StockReserve.updateOne(
          { _id: claim._id },
          {
            $set: { status: "processed", processedAt: new Date(now), lockedAt: null, availableBefore: null, shortageQuantity: 0, lastError: "" },
            $push: { history: historyEntry("processed", 0, "Inventory is no longer tracked for this item - nothing deducted.", { by: userId, source }) },
          },
          { session }
        );
        return { processed: true, deducted: 0, shortage: 0 };
      }

      // Free stock = on hand minus what pending-payment holds are keeping for other orders.
      const availableBefore = Math.max(0, (master.currentStock ?? 0) - (master.reservedStock ?? 0));
      const required = claim.stockQuantity - claim.deductedQuantity;
      const { deducted, doc } = await deductSold(claim.refType, claim.refId, required, { limitToAvailable: true, session });
      const shortage = required - deducted;

      if (deducted > 0) {
        await InventoryAdjustment.create(
          [
            {
              refType: claim.refType,
              refId: claim.refId,
              inventoryType: "Stock Out",
              quantity: deducted,
              bookedQuantity: claim.bookedQuantity,
              reductionFactor: claim.reductionFactor,
              previousStock: doc.currentStock + deducted,
              balance: doc.currentStock,
              remarks: `Reserved for session ${claim.sessionDate}${claim.bookingNumber ? ` - booking ${claim.bookingNumber}` : ""} (${claim.bookedQuantity} booked x ${claim.reductionFactor} per unit)${shortage > 0 ? `; ${shortage} short` : ""}`,
              source: "Stock Reserve",
              requestId: `reserve:${claim._id}:process`,
              createdBy: userId,
            },
          ],
          { session }
        );
      }

      const status = shortage > 0 ? (claim.deductedQuantity + deducted > 0 ? "partial" : "shortage") : "processed";
      await StockReserve.updateOne(
        { _id: claim._id },
        {
          $set: { status, availableBefore, deductedQuantity: claim.deductedQuantity + deducted, shortageQuantity: shortage, processedAt: new Date(now), lockedAt: null, lastError: "" },
          $push: {
            history: historyEntry(
              shortage > 0 ? "shortage" : "processed",
              deducted,
              shortage > 0
                ? `Session date reached: ${required} needed, ${availableBefore} available - deducted ${deducted}, shortage ${shortage} recorded.`
                : `Session date reached: deducted ${deducted}.`,
              { by: userId, source }
            ),
          },
        },
        { session }
      );
      return { processed: true, deducted, shortage };
    });
  } catch (err) {
    // The transaction rolled back (or, without transactions, stopped part-way): park the row as failed so the next
    // run - or an admin's retry - picks it up. Nothing is deducted twice: the movement key is unique.
    await StockReserve.updateOne(
      { _id: claim._id },
      {
        $set: { status: "failed", lockedAt: null, lastError: String(err?.message || err).slice(0, 500) },
        $push: { history: historyEntry("failed", 0, `Processing failed: ${String(err?.message || err).slice(0, 300)}`, { by: userId, source }) },
      }
    ).catch(() => {});
    return { failed: true, error: String(err?.message || err) };
  }
}

/**
 * The scheduler's pass: every reserve whose session day is today or EARLIER (so a day the server missed is caught up
 * on the next run) and that has not been processed, plus failed ones and abandoned locks. Idempotent.
 */
async function processDueReserves({ now = Date.now(), limit = 500 } = {}) {
  const today = templeToday(now);
  const due = await StockReserve.find({
    sessionDate: { $lte: today },
    $or: [{ status: { $in: ["upcoming", "failed"] } }, { status: "processing", lockedAt: { $lt: new Date(now - STALE_LOCK_MS) } }],
  })
    .sort({ sessionDate: 1, createdAt: 1 })
    .limit(limit)
    .select("_id");

  const result = { due: due.length, processed: 0, shortages: 0, failed: 0, skipped: 0 };
  for (const row of due) {
    const r = await processReserve(row._id, { now, source: "scheduler" });
    if (r.skipped) result.skipped += 1;
    else if (r.failed) result.failed += 1;
    else {
      result.processed += 1;
      if (r.shortage > 0) result.shortages += 1;
    }
  }
  return result;
}

/**
 * Stock has just come in. Settle outstanding shortages for this item FIRST (oldest session date first); the caller has
 * already added `incoming` to physical stock, so each settlement takes its units back out, and only what is left over
 * stays as available stock. Returns the units used to settle shortages.
 */
async function fulfilDeficits({ refType, refId, incoming, session = null, userId = null }) {
  if (!(incoming > 0)) return 0;
  const open = await StockReserve.find({ refType, refId, status: { $in: ["partial", "shortage"] }, shortageQuantity: { $gt: 0 } })
    .sort({ sessionDate: 1, createdAt: 1 })
    .session(session);

  let left = incoming;
  let used = 0;
  for (const reserve of open) {
    if (left <= 0) break;
    const want = Math.min(left, reserve.shortageQuantity);
    // Settle the reserve first (guarded on the shortage still being what we read), then take the units out.
    const settled = await StockReserve.findOneAndUpdate(
      { _id: reserve._id, shortageQuantity: { $gte: want }, status: { $in: ["partial", "shortage"] } },
      { $inc: { shortageQuantity: -want, deductedQuantity: want, fulfilledQuantity: want } },
      { returnDocument: "before", session }
    );
    if (!settled) continue; // someone else settled it in the meantime

    const { deducted, doc } = await deductSold(refType, refId, want, { limitToAvailable: true, session });
    const remaining = settled.shortageQuantity - want;
    await StockReserve.updateOne(
      { _id: reserve._id },
      {
        $set: { status: remaining > 0 ? "partial" : "processed" },
        $push: { history: historyEntry("fulfilled", want, `New stock settled ${want} of the shortage${remaining > 0 ? ` (${remaining} still short)` : " - fully settled"}.`, { by: userId, source: "stock-in" }) },
      },
      { session }
    );
    if (deducted > 0) {
      await InventoryAdjustment.create(
        [
          {
            refType,
            refId,
            inventoryType: "Stock Out",
            quantity: deducted,
            bookedQuantity: reserve.bookedQuantity,
            reductionFactor: reserve.reductionFactor,
            previousStock: doc.currentStock + deducted,
            balance: doc.currentStock,
            remarks: `Shortage settled for session ${reserve.sessionDate}${reserve.bookingNumber ? ` - booking ${reserve.bookingNumber}` : ""}`,
            source: "Stock Reserve",
            requestId: `reserve:${reserve._id}:fulfil:${settled.fulfilledQuantity}`,
            createdBy: userId,
          },
        ],
        { session }
      );
    }
    left -= want;
    used += want;
  }
  return used;
}

/** Drops a reserve that has not taken any stock. Returns the reserve, or null when it can no longer be cancelled. */
async function cancelReserve(id, { reason = "Cancelled", userId = null } = {}) {
  return StockReserve.findOneAndUpdate(
    { _id: id, status: { $in: ["upcoming", "failed"] }, deductedQuantity: 0 },
    { $set: { status: "cancelled", lockedAt: null }, $push: { history: historyEntry("cancelled", 0, reason, { by: userId, source: "manual" }) } },
    { returnDocument: "after" }
  );
}

module.exports = { isFutureSession, createReserve, processReserve, processDueReserves, fulfilDeficits, cancelReserve, STALE_LOCK_MS };
