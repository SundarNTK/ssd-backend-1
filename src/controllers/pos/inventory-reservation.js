/**
 * Inventory Reservation helpers - the booking side of the stock lifecycle, shared by the POS counter and the
 * Admin Booking page.
 *
 * Accounting model (one, used everywhere - see common/utils/inventory-stock.js):
 *
 *   physical  = currentStock         moved only by manual adjustments and by a CONFIRMED booking
 *   reserved  = reservedStock        units held by pending bookings
 *   bookable  = physical - reserved      (the threshold is only the low-stock alert level; it never blocks a sale)
 *
 * Lifecycle of one inventory line (an InventoryReservation row, status in brackets):
 *
 *   order created      reserveStock(): ONE conditional update takes the units into reservedStock only if they are
 *                      bookable, then the row is written [active, expiresAt = now + 30 min]. Two bookings racing for
 *                      the last units cannot both win.
 *   payment confirmed  consumeReservations(): the row is CLAIMED [active -> consumed] with a conditional update, then
 *                      the units leave physical stock and the reservation, and a "Stock Out" movement is logged - in
 *                      one transaction. A repeated confirmation finds the row already consumed and does nothing; the
 *                      movement's unique requestId is a second guard.
 *   cancelled / failed releaseReservation(): claims the row [active -> cancelled] then returns the units.
 *   30 min, unpaid     the expiry job does the same claim [active -> expired]. Claiming first makes the job, a late
 *                      callback and a second job run safe against each other: only the winner returns the units.
 *   paid AFTER expiry  consumeReservations() re-takes only what is genuinely free; whatever is gone is recorded as an
 *                      inventoryShortfall on the booking for manual follow-up - stock is never oversold.
 *
 * Everything is persisted, so a restart loses nothing: the job simply finds the expired rows.
 */

const InventoryReservation = require("../../models/inventory-reservations");
const InventoryAdjustment = require("../../models/inventory-adjustments");
const EventSeatHold = require("../../models/event-seat-holds");
const {
  ORDER_HOLD_TTL_MS,
  acquireHold,
  releaseHold,
  confirmSeats,
  bookSeatsDirect,
} = require("../../common/utils/event-seats");
const {
  REF_MODELS,
  inventoryFlag,
  thresholdField,
  toObjectId,
  runInTransaction,
  reserveStock,
  releaseReservedStock,
  deductSold,
} = require("../../common/utils/inventory-stock");

const RESERVATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Why a booking cannot reserve, as one message a cashier can act on. */
function shortageMessage(ref, refType) {
  const currentStock = ref.currentStock ?? 0;
  const reserved = ref.reservedStock ?? 0;
  if (currentStock <= 0 && reserved <= 0) {
    return `Inventory has not been initialized for "${ref.name}": no stock has been added yet. Add stock in Inventory Adjustment before booking it.`;
  }
  const bookable = Math.max(0, currentStock - reserved);
  return `Insufficient stock for "${ref.name}": only ${bookable} unit(s) available for booking (${currentStock} in stock, ${reserved} reserved by other bookings).`;
}

/**
 * Reserves `requestedQty` units of `refType:refId` for an order line - atomically - and writes the reservation row.
 * Returns the reservation, or null when inventory is not tracked for this item/service (nothing to reserve).
 * Throws a plain string on a business-rule failure (shown to the cashier).
 */
async function placeReservation(refType, refId, requestedQty, orderId, lineKey = null) {
  const Model = REF_MODELS[refType];
  const flag = inventoryFlag(refType);
  const tField = thresholdField(refType);

  const ref = await Model.findOne(Model.notDeletedFilter({ _id: refId, [flag]: true, status: 1 })).select(
    `name code currentStock reservedStock ${tField}`
  );
  if (!ref) return null; // inventory not applicable - the booking follows the existing flow

  // The check and the hold are one conditional update: it only succeeds while the units are still bookable.
  const held = await reserveStock(refType, refId, requestedQty);
  if (!held) {
    // Say why, with the numbers as they are right now.
    const fresh = await Model.findOne({ _id: refId }).select(`name currentStock reservedStock ${tField}`);
    throw shortageMessage(fresh || ref, refType);
  }

  try {
    return await InventoryReservation.create({
      orderId,
      lineKey,
      refType,
      refId,
      quantity: requestedQty,
      status: "active",
      expiresAt: new Date(Date.now() + RESERVATION_TTL_MS),
    });
  } catch (err) {
    await releaseReservedStock(refType, refId, requestedQty).catch(() => {});
    throw err;
  }
}

/**
 * Releases ONE hold: claims it (active -> `status`) with a conditional update and, only if this call won the claim,
 * returns its units to the pool. Safe to call any number of times, from the expiry job, a payment callback or a retry.
 * Returns true when this call released it.
 */
async function releaseReservation(reservation, status, reason) {
  const claimed = await InventoryReservation.findOneAndUpdate(
    { _id: reservation._id, status: "active" },
    { $set: { status, releasedAt: new Date(), releaseReason: reason } },
    { returnDocument: "after" }
  );
  if (!claimed) return false;
  await releaseReservedStock(claimed.refType, claimed.refId, claimed.quantity);
  return true;
}

/**
 * Attaches an Event line's seats to an order. The seats are normally already
 * held - the POS took the hold when the event went into the cart - so this
 * claims that hold for the order and pushes its expiry out to the order's
 * window. If the hold is missing (lapsed, or the cart never took one) the
 * seats are held now, atomically, and the whole order is refused with a plain
 * message when the slot cannot take them. A slot with no seat limit holds
 * nothing.
 */
async function placeEventReservation(line, orderId, ownerId = null, posOnly = false) {
  const slotKey = line.eventSlot?.slotKey;
  if (!slotKey) return null; // event without slots - nothing to hold

  const seats = line.seats || 1;
  if (line.holdId) {
    const claimed = await EventSeatHold.findOneAndUpdate(
      { _id: line.holdId, status: "active", eventId: line.refId, slotKey, seats, expiresAt: { $gt: new Date() } },
      { $set: { orderId, expiresAt: new Date(Date.now() + ORDER_HOLD_TTL_MS) } },
      { returnDocument: "after" }
    );
    if (claimed) return claimed;
    // The cart's hold no longer matches this line (seats changed, or it lapsed): let it go and take a fresh one.
    await releaseHold(line.holdId);
  }

  return acquireHold({ eventId: line.refId, slotKey, seats, ownerId, orderId, ttlMs: ORDER_HOLD_TTL_MS, posOnly });
}

/**
 * Place reservations for ALL inventory-applicable lines in a cart. If any line fails, everything already placed for
 * this order is released again (each release is its own safe claim) and the message is re-thrown.
 *
 * @returns {Array} reservation documents (null entries for lines that need none)
 */
async function placeReservationsForOrder(lines, orderId, options = {}) {
  const placed = [];
  try {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const r =
        line.refType === "Event"
          ? await placeEventReservation(line, orderId, options.ownerId, options.posOnly)
          : await placeReservation(line.refType, line.refId, line.quantity, orderId, i);
      placed.push(r);
    }
    return placed;
  } catch (err) {
    await releaseEventHoldsForOrder(orderId).catch(() => {});
    for (const r of placed) {
      if (r?.refType) await releaseReservation(r, "cancelled", "order could not be placed").catch(() => {});
    }
    throw err; // the controller surfaces the message
  }
}

/** The hold a line was reserved under: by its line position, else (older orders) by item and quantity. */
async function findLineReservation(orderId, line, lineKey, usedIds) {
  const byKey = await InventoryReservation.findOne({ orderId, lineKey });
  if (byKey) return byKey;
  const candidates = await InventoryReservation.find({
    orderId,
    refType: line.refType,
    refId: line.refId,
    quantity: line.quantity,
    lineKey: null,
  }).sort({ createdAt: 1 });
  return candidates.find((c) => !usedIds.has(String(c._id))) ?? null;
}

/**
 * A confirmed booking: turns each inventory line's reservation into a completed stock deduction, exactly once.
 *
 *  - active hold      claim -> deduct physical stock and release the hold -> log a "Stock Out" movement.
 *  - already consumed skipped (a duplicate payment callback or retried confirmation).
 *  - hold lapsed      (paid after the 30 minutes) re-take only the units that are still genuinely free; anything
 *                     missing is reported back as a shortfall - the sale is never allowed to drive stock below
 *                     zero or take units another booking holds.
 *
 * Each line is processed in its own transaction (when supported), so the claim, the stock change and the movement
 * row commit together or not at all.
 *
 * @returns {Promise<{ shortfalls: { refType, refId, name, quantity }[] }>}
 */
async function consumeReservations(orderId, lines, bookedByUserId, bookingNumber) {
  const shortfalls = [];
  const used = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.refType === "Event") {
      await countEventSeats(orderId, line, bookingNumber);
      continue;
    }
    const Model = REF_MODELS[line.refType];
    const tracked = await Model.findOne(Model.notDeletedFilter({ _id: line.refId, [inventoryFlag(line.refType)]: true })).select("name");
    if (!tracked) continue; // not inventory-applicable - nothing to do

    const reservation = await findLineReservation(orderId, line, i, used);
    if (!reservation) {
      // Tracked, but no hold was ever recorded (an order written before reservations existed): treat as a late sale.
      shortfalls.push(...(await consumeWithoutHold(line, tracked.name, orderId, i, bookingNumber, bookedByUserId)));
      continue;
    }
    used.add(String(reservation._id));
    if (reservation.status === "consumed") continue; // already confirmed once

    const result = await consumeOne(reservation, tracked.name, bookingNumber, bookedByUserId);
    if (result.shortfall > 0) shortfalls.push({ refType: line.refType, refId: line.refId, name: tracked.name, quantity: result.shortfall });
  }
  return { shortfalls };
}

async function consumeOne(reservation, name, bookingNumber, bookedByUserId) {
  // A few passes cover the narrow case where the hold changes state between our read and our claim.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await runInTransaction(async (session) => {
      const current = await InventoryReservation.findById(reservation._id).session(session || null);
      if (!current || current.status === "consumed") return { done: true, shortfall: 0 };
      const wasActive = current.status === "active";

      // Claim: only the caller that flips the row to "consumed" goes on to deduct, so the stock leaves once.
      const claimed = await InventoryReservation.findOneAndUpdate(
        { _id: current._id, status: current.status },
        {
          $set: {
            status: "consumed",
            confirmedAt: new Date(),
            releasedAt: new Date(),
            lateConfirmation: !wasActive,
            bookingNumber: bookingNumber ?? null,
          },
        },
        { returnDocument: "after", session }
      );
      if (!claimed) return { done: false };

      const { deducted, doc } = await deductSold(claimed.refType, claimed.refId, claimed.quantity, {
        releaseReserved: wasActive ? claimed.quantity : 0,
        limitToAvailable: !wasActive,
        session,
      });
      const shortfall = claimed.quantity - deducted;
      if (shortfall > 0) {
        await InventoryReservation.updateOne({ _id: claimed._id }, { $set: { shortfallQty: shortfall } }, { session });
      }
      if (deducted > 0) {
        await InventoryAdjustment.create(
          [
            {
              refType: claimed.refType,
              refId: claimed.refId,
              inventoryType: "Stock Out",
              quantity: deducted,
              previousStock: doc.currentStock + deducted,
              balance: doc.currentStock,
              remarks: `Booking ${bookingNumber}${wasActive ? "" : " (payment received after the reservation expired)"}`,
              source: "Booking",
              requestId: `consume:${claimed._id}`,
              createdBy: bookedByUserId ?? null,
            },
          ],
          { session }
        );
      }
      return { done: true, shortfall };
    });
    if (outcome.done) return outcome;
  }
  throw new Error(`Could not confirm the stock for "${name}" - please retry.`);
}

/** A tracked line with no hold row at all: deduct what is free, report the rest. Idempotent per order line. */
async function consumeWithoutHold(line, name, orderId, lineKey, bookingNumber, bookedByUserId) {
  const requestId = `consume:${orderId}:${lineKey}`;
  if (await InventoryAdjustment.exists({ requestId })) return [];
  return runInTransaction(async (session) => {
    const { deducted, doc } = await deductSold(line.refType, line.refId, line.quantity, { limitToAvailable: true, session });
    if (deducted > 0) {
      await InventoryAdjustment.create(
        [
          {
            refType: line.refType,
            refId: line.refId,
            inventoryType: "Stock Out",
            quantity: deducted,
            previousStock: doc.currentStock + deducted,
            balance: doc.currentStock,
            remarks: `Booking ${bookingNumber}`,
            source: "Booking",
            requestId,
            createdBy: bookedByUserId ?? null,
          },
        ],
        { session }
      );
    }
    const shortfall = line.quantity - deducted;
    return shortfall > 0 ? [{ refType: line.refType, refId: line.refId, name, quantity: shortfall }] : [];
  });
}

/**
 * Turns an Event line's held seats into booked seats - the Event counterpart
 * of the stock-out above. The order's hold is claimed (active -> consumed) so
 * it can only ever be counted once, then held -> booked happens in a single
 * atomic update. A paid order whose hold had already lapsed is booked
 * directly: the money is taken, so the booking is honoured.
 */
async function countEventSeats(orderId, line, bookingNumber = null) {
  const slotKey = line.eventSlot?.slotKey;
  if (!slotKey) return;
  const seats = line.seats || 1;

  const hold = await EventSeatHold.findOneAndUpdate(
    { orderId, eventId: line.refId, slotKey, seats, status: "active" },
    { $set: { status: "consumed", releasedAt: new Date(), bookingNumber } }
  );
  if (hold) {
    await confirmSeats(line.refId, slotKey, seats);
  } else {
    console.warn(`>>> [event-seats] order ${orderId}: no active hold for "${line.name}" ${slotKey}; booking ${seats} seat(s) directly`);
    await bookSeatsDirect(line.refId, slotKey, seats);
    // Keep the allocation history complete: record the seats that had no hold.
    await EventSeatHold.create({
      eventId: line.refId,
      slotKey,
      seats,
      orderId,
      bookingNumber,
      forced: true,
      status: "consumed",
      releasedAt: new Date(),
      expiresAt: new Date(),
    });
  }
}

/** Gives back every seat still held for an order (cancelled, failed or abandoned). */
async function releaseEventHoldsForOrder(orderId) {
  const holds = await EventSeatHold.find({ orderId, status: "active" }).select("_id");
  for (const h of holds) await releaseHold(h._id);
}

/** Immediately releases every active hold of an order (payment cancelled/failed, order abandoned, error rollback). */
async function cancelReservations(orderId, reason = "order cancelled") {
  await releaseEventHoldsForOrder(orderId);
  const active = await InventoryReservation.find({ orderId, status: "active" });
  for (const r of active) await releaseReservation(r, "cancelled", reason);
}

/**
 * Releases every hold whose 30 minutes are up. Each one is its own safe claim, so running this twice (or while a
 * payment callback confirms the same hold) never returns the same units twice. Returns the orderIds affected.
 */
async function releaseExpiredHolds(now = new Date(), limit = 500) {
  const lapsed = await InventoryReservation.find({ status: "active", expiresAt: { $lte: now } }).limit(limit);
  const released = [];
  for (const r of lapsed) {
    if (await releaseReservation(r, "expired", "reservation expired after 30 minutes")) released.push(r);
  }
  return released;
}

/**
 * Rebuilds every master's reservedStock from the reservation rows that are still active. Run once when the server
 * starts (before it takes traffic), so the counters are right after a deploy, a restore or a crash between a
 * reservation's two writes.
 */
async function reconcileReservedStock() {
  const totals = await InventoryReservation.aggregate([
    { $match: { status: "active" } },
    { $group: { _id: { refType: "$refType", refId: "$refId" }, total: { $sum: "$quantity" } } },
  ]);
  const byType = { Item: new Map(), Service: new Map(), GeneralItem: new Map() };
  for (const t of totals) byType[t._id.refType]?.set(String(t._id.refId), t.total);

  let fixed = 0;
  for (const [refType, Model] of Object.entries(REF_MODELS)) {
    const wanted = byType[refType];
    const rows = await Model.find({ $or: [{ reservedStock: { $gt: 0 } }, { reservedStock: { $exists: false } }, { _id: { $in: [...wanted.keys()].map(toObjectId) } }] }).select("reservedStock");
    for (const row of rows) {
      const expected = wanted.get(String(row._id)) ?? 0;
      if ((row.reservedStock ?? 0) !== expected || row.reservedStock === undefined) {
        await Model.updateOne({ _id: row._id }, { $set: { reservedStock: expected } });
        fixed += 1;
      }
    }
  }
  return { fixed };
}

/**
 * What can be booked right now for one master, WITHOUT writing anything. `availableQty` is what a new booking may
 * still reserve (physical - reserved).
 */
async function getAvailability(refType, refId) {
  const Model = REF_MODELS[refType];
  const flag = inventoryFlag(refType);
  const tField = thresholdField(refType);

  const ref = await Model.findOne(Model.notDeletedFilter({ _id: refId, status: 1 })).select(`${flag} currentStock reservedStock ${tField}`);
  if (!ref || !ref[flag]) {
    return { isInventoryApplicable: false, isApplicable: false, currentStock: 0, reservedQty: 0, availableQty: Infinity, threshold: 0 };
  }

  const currentStock = ref.currentStock ?? 0;
  const threshold = ref[tField] ?? 0;
  const reservedQty = ref.reservedStock ?? 0;
  return {
    isInventoryApplicable: true, isApplicable: true,
    currentStock,
    reservedQty,
    availableQty: Math.max(0, currentStock - reservedQty),
    threshold,
  };
}

/**
 * Batch version of getAvailability() for a listing page: the already-loaded documents carry everything needed
 * (currentStock, reservedStock, threshold, the inventory flag), so no extra queries are made.
 *
 * @returns {Promise<Map<string, {isInventoryApplicable, currentStock, reservedQty, availableQty, threshold}>>} keyed by String(ref._id)
 */
async function getAvailabilityBatch(refType, refs) {
  const flag = inventoryFlag(refType);
  const tField = thresholdField(refType);

  const result = new Map();
  for (const ref of refs) {
    if (!ref[flag]) {
      result.set(String(ref._id), { isInventoryApplicable: false, isApplicable: false, currentStock: 0, reservedQty: 0, availableQty: Infinity, threshold: 0 });
      continue;
    }
    const currentStock = ref.currentStock ?? 0;
    const threshold = ref[tField] ?? 0;
    const reservedQty = ref.reservedStock ?? 0;
    result.set(String(ref._id), {
      isInventoryApplicable: true, isApplicable: true,
      currentStock,
      reservedQty,
      availableQty: Math.max(0, currentStock - reservedQty),
      threshold,
    });
  }
  return result;
}

module.exports = {
  releaseEventHoldsForOrder,
  placeReservationsForOrder,
  consumeReservations,
  cancelReservations,
  releaseReservation,
  releaseExpiredHolds,
  reconcileReservedStock,
  getAvailability,
  getAvailabilityBatch,
  RESERVATION_TTL_MS,
};
