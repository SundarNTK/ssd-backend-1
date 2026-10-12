/**
 * Event slot seats - the one place seats are held, booked and released.
 *
 * A slot's seat position lives ON the Event record, in two counters:
 *
 *   bookedSeats - seats of confirmed bookings
 *   heldSeats   - seats temporarily held by carts / pending orders
 *
 *   seats left  = totalSeats - bookedSeats - heldSeats
 *
 * Every change to those counters is ONE conditional update of the Event
 * document (a MongoDB pipeline update whose filter also checks the capacity).
 * MongoDB applies a single-document update atomically, so when two terminals
 * ask for the last seat in the same millisecond the database serialises them:
 * the first one matches and takes the seat, the second finds no room, matches
 * nothing and is refused. There is no read-then-write gap, no lock, and no
 * transaction needed.
 *
 * Seat life cycle (EventSeatHold documents track who holds what):
 *
 *   add to cart        -> holdSeats      heldSeats  += n           (can be refused)
 *   remove / edit      -> releaseSeats   heldSeats  -= n
 *   booking confirmed  -> confirmSeats   heldSeats  -= n, bookedSeats += n  (one update)
 *   hold times out     -> releaseSeats   heldSeats  -= n           (cleanup job)
 *
 * A slot with totalSeats 0 has no seat limit: nothing is ever refused, and
 * only confirmed seats are counted.
 */
const mongoose = require("mongoose");
const Event = require("../../models/events");
const EventSeatHold = require("../../models/event-seat-holds");

/**
 * A cart's hold lives this long unless the POS keeps refreshing it (it does,
 * every 3 minutes, while the cart is open). Short on purpose: if a terminal
 * dies without letting go, its seats are back within minutes.
 */
const CART_HOLD_TTL_MS = 10 * 60 * 1000;
/** Once checkout starts, the hold follows the order's own 30-minute window. */
const ORDER_HOLD_TTL_MS = 30 * 60 * 1000;

const toObjectId = (id) => (typeof id === "string" ? mongoose.Types.ObjectId.createFromHexString(id) : id);

/** Slots have no _id, so name + day + start time is their identity. */
function slotKeyOf(slot) {
  const day = new Date(slot.date).toISOString().slice(0, 10);
  return `${slot.slotName}|${day}|${slot.startTime}`;
}

/** Start of today's calendar day in Singapore, as the UTC midnight event dates are stored at. */
function todayStart() {
  const sgDay = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return new Date(`${sgDay}T00:00:00.000Z`);
}

/**
 * True once the slot's start time (Singapore) has been reached. A slot is only
 * bookable before it begins, so one that is under way or over is treated as gone.
 * `slot.date` is the stored UTC-midnight calendar day, `startTime` is "HH:MM".
 */
function slotHasStarted(slot, now = Date.now()) {
  const day = new Date(slot.date).toISOString().slice(0, 10);
  const [h, m] = String(slot.startTime || "00:00").split(":").map((n) => Number(n) || 0);
  const start = Date.parse(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+08:00`);
  return Number.isFinite(start) ? start <= now : true;
}

// ─── aggregation fragments (the same key rule as slotKeyOf, evaluated in MongoDB) ───

/** `$$v` is the slot variable inside a $map / $filter. */
const keyExpr = (v) => ({
  $concat: [`$$${v}.slotName`, "|", { $dateToString: { format: "%Y-%m-%d", date: `$$${v}.date` } }, "|", `$$${v}.startTime`],
});
const bookedExpr = (v) => ({ $ifNull: [`$$${v}.bookedSeats`, 0] });
const heldExpr = (v) => ({ $ifNull: [`$$${v}.heldSeats`, 0] });

/** Rewrites one slot (found by key) with `patch`, leaving every other slot untouched. */
function patchSlotStage(slotKey, patch) {
  return {
    $set: {
      slotDetails: {
        $map: {
          input: "$slotDetails",
          as: "s",
          in: { $cond: [{ $eq: [keyExpr("s"), slotKey] }, { $mergeObjects: ["$$s", patch] }, "$$s"] },
        },
      },
    },
  };
}

function baseFilter(eventId, { posOnly }) {
  const filter = { _id: toObjectId(eventId), isDeleted: false, status: 1, endDate: { $gte: todayStart() } };
  // POS holds need the POS flag; the Admin Panel's need the Admin Booking one.
  if (posOnly) filter.posVisibility = true;
  else filter.adminBookingVisibility = { $ne: false };
  return filter;
}

// ─── the atomic operations ───────────────────────────────────────────────────

/**
 * Takes `seats` of the slot's free seats, or takes nothing. One conditional
 * update: it only matches while the slot is active, still in the future and
 * has room, so a lost race simply matches zero documents.
 *
 * @returns {Promise<boolean>} true when the seats were taken
 */
async function tryHoldSeats(eventId, slotKey, seats, { posOnly = false } = {}) {
  const filter = {
    ...baseFilter(eventId, { posOnly }),
    $expr: {
      $anyElementTrue: {
        $map: {
          input: "$slotDetails",
          as: "s",
          in: {
            $and: [
              { $eq: [keyExpr("s"), slotKey] },
              { $eq: ["$$s.status", 1] },
              // Still to start: its Singapore start time is later than now (an unreadable time counts as started).
              {
                $gt: [
                  {
                    $dateFromString: {
                      dateString: { $concat: [{ $dateToString: { format: "%Y-%m-%d", date: "$$s.date" } }, "T", "$$s.startTime", ":00"] },
                      timezone: "Asia/Singapore",
                      onError: new Date(0),
                      onNull: new Date(0),
                    },
                  },
                  "$$NOW",
                ],
              },
              {
                $or: [
                  { $eq: ["$$s.totalSeats", 0] },
                  { $lte: [{ $add: [bookedExpr("s"), heldExpr("s"), seats] }, "$$s.totalSeats"] },
                ],
              },
            ],
          },
        },
      },
    },
  };
  const result = await Event.collection.updateOne(filter, [
    patchSlotStage(slotKey, { heldSeats: { $add: [heldExpr("s"), seats] } }),
  ]);
  return result.matchedCount === 1;
}

/** Gives held seats back (never below zero). */
async function releaseSeats(eventId, slotKey, seats) {
  await Event.collection.updateOne({ _id: toObjectId(eventId) }, [
    patchSlotStage(slotKey, { heldSeats: { $max: [0, { $subtract: [heldExpr("s"), seats] }] } }),
  ]);
}

/** Held seats become booked seats - in one update, so "seats left" never moves. */
async function confirmSeats(eventId, slotKey, seats) {
  await Event.collection.updateOne({ _id: toObjectId(eventId) }, [
    patchSlotStage(slotKey, {
      heldSeats: { $max: [0, { $subtract: [heldExpr("s"), seats] }] },
      bookedSeats: { $add: [bookedExpr("s"), seats] },
    }),
  ]);
}

/** Books seats that were not held (a paid order whose hold had already lapsed). */
async function bookSeatsDirect(eventId, slotKey, seats) {
  await Event.collection.updateOne({ _id: toObjectId(eventId) }, [
    patchSlotStage(slotKey, { bookedSeats: { $add: [bookedExpr("s"), seats] } }),
  ]);
}

// ─── reading ────────────────────────────────────────────────────────────────

/** Seats still free on a slot (Infinity when it has no seat limit). */
function seatsLeftOf(slot) {
  if (!slot || !slot.totalSeats) return Infinity;
  return Math.max(0, slot.totalSeats - (slot.bookedSeats || 0) - (slot.heldSeats || 0));
}

async function describeShortage(eventId, slotKey) {
  const event = await Event.findOne({ _id: eventId }).select("name slotDetails");
  const slot = event?.slotDetails.find((s) => slotKeyOf(s) === slotKey);
  if (!slot) return "The selected slot is no longer available.";
  const left = seatsLeftOf(slot);
  return `Only ${left === Infinity ? 0 : left} seat(s) left on "${slot.slotName}" for "${event.name}".`;
}

// ─── holds ──────────────────────────────────────────────────────────────────

/**
 * Holds seats and records the hold. Throws a plain string (shown to the
 * cashier) when the slot cannot take them. Returns null for a slot with no
 * seat limit - there is nothing to hold.
 */
async function acquireHold({ eventId, slotKey, seats, ownerId = null, clientId = null, orderId = null, ttlMs = CART_HOLD_TTL_MS, posOnly = false }) {
  const event = await Event.findOne({ _id: eventId }).select("slotDetails");
  const slot = event?.slotDetails.find((s) => slotKeyOf(s) === slotKey);
  if (slot && !slot.totalSeats) return null;

  let taken = await tryHoldSeats(eventId, slotKey, seats, { posOnly });
  if (!taken) {
    // The slot may only look full because of holds that already ran out but
    // have not been swept yet - clear those and try once more.
    await sweepLapsedHolds(eventId, slotKey);
    taken = await tryHoldSeats(eventId, slotKey, seats, { posOnly });
  }
  if (!taken) throw await describeShortage(eventId, slotKey);

  try {
    return await EventSeatHold.create({
      eventId,
      slotKey,
      seats,
      ownerId,
      clientId,
      orderId,
      status: "active",
      expiresAt: new Date(Date.now() + ttlMs),
    });
  } catch (error) {
    // Could not record the hold - give the seats straight back.
    await releaseSeats(eventId, slotKey, seats);
    throw error;
  }
}

/** Expires this slot's lapsed holds right now (the cleanup job does the same for every slot on a timer). */
async function sweepLapsedHolds(eventId, slotKey) {
  const now = new Date();
  const lapsed = await EventSeatHold.find({ eventId, slotKey, status: "active", expiresAt: { $lte: now } });
  for (const hold of lapsed) {
    const claimed = await EventSeatHold.findOneAndUpdate(
      { _id: hold._id, status: "active", expiresAt: { $lte: now } },
      { $set: { status: "expired", releasedAt: now } }
    );
    if (claimed) await releaseSeats(claimed.eventId, claimed.slotKey, claimed.seats);
  }
}

/** Ends an active hold and returns its seats. Safe to call twice: only the first call does anything. */
async function releaseHold(holdId, status = "released") {
  const hold = await EventSeatHold.findOneAndUpdate(
    { _id: holdId, status: "active" },
    { $set: { status, releasedAt: new Date() } }
  );
  if (!hold) return false;
  await releaseSeats(hold.eventId, hold.slotKey, hold.seats);
  return true;
}

/**
 * Changes how many seats an existing cart hold covers (an edited cart line
 * that stays on the same slot). Only the DIFFERENCE is taken or given back,
 * so going from 3 to 5 seats needs 2 free seats, not 5. Returns the updated
 * hold, or throws a plain string when the extra seats are not available -
 * in which case the hold is left exactly as it was.
 */
async function resizeHold(hold, seats, { posOnly = false } = {}) {
  const delta = seats - hold.seats;
  if (delta > 0) {
    const taken = await tryHoldSeats(hold.eventId, hold.slotKey, delta, { posOnly });
    if (!taken) throw await describeShortage(hold.eventId, hold.slotKey);
  } else if (delta < 0) {
    await releaseSeats(hold.eventId, hold.slotKey, -delta);
  }

  const updated = await EventSeatHold.findOneAndUpdate(
    { _id: hold._id, status: "active", seats: hold.seats },
    { $set: { seats, expiresAt: new Date(Date.now() + CART_HOLD_TTL_MS) } },
    { returnDocument: "after" }
  );
  if (!updated) {
    // The hold was released / expired / changed while we were resizing: undo the counter change.
    if (delta > 0) await releaseSeats(hold.eventId, hold.slotKey, delta);
    else if (delta < 0) await tryHoldSeats(hold.eventId, hold.slotKey, -delta, { posOnly });
    throw "That seat hold is no longer active. Please add the event to the cart again.";
  }
  return updated;
}

/** Keeps an active hold alive. Returns the hold, or null when it is gone. */
function extendHold(holdId, ttlMs = CART_HOLD_TTL_MS) {
  return EventSeatHold.findOneAndUpdate(
    { _id: holdId, status: "active", expiresAt: { $gt: new Date() } },
    { $set: { expiresAt: new Date(Date.now() + ttlMs) } },
    { returnDocument: "after" }
  );
}

module.exports = {
  CART_HOLD_TTL_MS,
  ORDER_HOLD_TTL_MS,
  slotKeyOf,
  todayStart,
  slotHasStarted,
  seatsLeftOf,
  tryHoldSeats,
  releaseSeats,
  confirmSeats,
  bookSeatsDirect,
  acquireHold,
  releaseHold,
  extendHold,
  resizeHold,
  keyExpr,
  bookedExpr,
  heldExpr,
  toObjectId,
};
