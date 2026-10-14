/**
 * Release Expired Inventory Reservations
 *
 * Runs on a fixed interval (every 5 minutes by default) after the server
 * boots. Finds every InventoryReservation that is still "active" but whose
 * expiresAt has passed, marks it "expired", and cancels the parent Order
 * if all of its reservations have now lapsed.
 *
 * Releasing a reservation returns its units from reservedStock to the
 * available pool; physical stock (currentStock) only moves when a booking is
 * confirmed or an adjustment is made.
 *
 * Why a periodic job instead of a MongoDB TTL index that auto-deletes?
 *   - We need to update the parent Order's status when its reservations
 *     expire — a TTL delete gives us no hook for that.
 *   - We want an "expired" audit trail, not a vanished document.
 *   - TTL resolution is only approximate (±60s by MongoDB spec), and this
 *     job runs at a shorter interval anyway.
 *
 * Scheduling: called from server.js after the DB connection is ready.
 */

const InventoryReservation = require("../../../models/inventory-reservations");
const { releaseExpiredHolds } = require("../../../controllers/pos/inventory-reservation");
const EventSeatHold = require("../../../models/event-seat-holds");
const { releaseSeats } = require("../../../common/utils/event-seats");
const { Order } = require("../../../models/orders");
const { PosOrder } = require("../../../models/pos-orders");

// InventoryReservation.orderId carries no discriminator for which
// collection minted it — Admin Booking's Order and the POS counter's own
// PosOrder (see models/pos-orders) both place reservations the exact same
// way (see controllers/pos/inventory-reservation.js, shared by both). So a
// reservation's parent is looked up in both, in order; the first match
// wins. An id can't collide between them (each is its own ObjectId space),
// so at most one of these two lookups ever finds anything.
const ORDER_MODELS = [Order, PosOrder];

/**
 * Process one batch of expired reservations.
 *
 * @returns {Promise<{ released: number, ordersCancelled: number }>}
 */
async function releaseExpiredReservations() {
  const now = new Date();

  // Each lapsed hold is claimed (active -> expired) with a conditional update and only the winner gives its units
  // back, so a second job run - or a payment callback confirming the same hold at the same moment - never
  // releases the same quantity twice. See controllers/pos/inventory-reservation.
  const released = await releaseExpiredHolds(now);
  if (released.length === 0) return { released: 0, ordersCancelled: 0 };

  const expiredIds = released.map((r) => r._id);
  const affectedOrderIds = [...new Set(released.map((r) => String(r.orderId)))];

  // For each affected order: if it's still pending AND has no active
  // reservations left, mark it cancelled too
  let ordersCancelled = 0;
  for (const orderId of affectedOrderIds) {
    let OrderModel = null;
    for (const Model of ORDER_MODELS) {
      const match = await Model.findOne(Model.notDeletedFilter({ _id: orderId, orderStatus: "pending" })).select("_id");
      if (match) {
        OrderModel = Model;
        break;
      }
    }

    if (!OrderModel) continue; // already confirmed, cancelled, or not found in either collection

    // Check whether any reservation for this order is still active
    const stillActive = await InventoryReservation.countDocuments({
      orderId,
      status: "active",
      expiresAt: { $gt: now },
    });

    if (stillActive === 0) {
      await OrderModel.findByIdAndUpdate(orderId, { orderStatus: "cancelled" });
      ordersCancelled += 1;
    }
  }

  console.log(
    `>>> [reservation-cleanup] Released ${expiredIds.length} reservation(s), ` +
      `cancelled ${ordersCancelled} order(s) at ${now.toISOString()}`
  );

  return { released: expiredIds.length, ordersCancelled };
}

/**
 * Event seat holds that nobody confirmed in time. Each one is claimed
 * (active -> expired) with a conditional update before its seats are given
 * back, so a hold that is being confirmed or released at the same moment is
 * never counted twice. A pending order left with no live seats and no live
 * stock reservations is cancelled, like the stock job does.
 *
 * @returns {Promise<{ expired: number, ordersCancelled: number }>}
 */
async function releaseExpiredEventHolds() {
  const now = new Date();
  const lapsed = await EventSeatHold.find({ status: "active", expiresAt: { $lte: now } }).limit(500);
  if (lapsed.length === 0) return { expired: 0, ordersCancelled: 0 };

  let expired = 0;
  const orderIds = new Set();
  for (const hold of lapsed) {
    const claimed = await EventSeatHold.findOneAndUpdate(
      { _id: hold._id, status: "active", expiresAt: { $lte: now } },
      { $set: { status: "expired", releasedAt: now } }
    );
    if (!claimed) continue; // confirmed, released or extended in the meantime
    await releaseSeats(claimed.eventId, claimed.slotKey, claimed.seats);
    expired += 1;
    if (claimed.orderId) orderIds.add(String(claimed.orderId));
  }

  let ordersCancelled = 0;
  for (const orderId of orderIds) {
    const [reservations, holds] = await Promise.all([
      InventoryReservation.countDocuments({ orderId, status: "active", expiresAt: { $gt: now } }),
      EventSeatHold.countDocuments({ orderId, status: "active" }),
    ]);
    if (reservations > 0 || holds > 0) continue;
    for (const Model of ORDER_MODELS) {
      const cancelled = await Model.findOneAndUpdate(
        Model.notDeletedFilter({ _id: orderId, orderStatus: "pending" }),
        { orderStatus: "cancelled" }
      );
      if (cancelled) {
        ordersCancelled += 1;
        break;
      }
    }
  }

  if (expired > 0) {
    console.log(`>>> [event-holds-cleanup] Released ${expired} seat hold(s), cancelled ${ordersCancelled} order(s) at ${now.toISOString()}`);
  }
  return { expired, ordersCancelled };
}

/**
 * Start the periodic cleanup job.
 *
 * @param {number} [intervalMs=60_000] How often to run (default: every minute, so a hold that has lapsed is back on
 *   sale within about a minute of its 30 minutes ending)
 * @returns {NodeJS.Timeout} The interval handle — store it if you need to
 *   stop the job cleanly (e.g. in tests).
 */
function startReservationCleanupJob(intervalMs = 60 * 1000) {
  // Run once immediately on startup to catch any reservations that expired
  // while the server was down
  releaseExpiredReservations().catch((err) => {
    console.error(">>> [reservation-cleanup] Initial run failed:", err);
  });
  releaseExpiredEventHolds().catch((err) => {
    console.error(">>> [event-holds-cleanup] Initial run failed:", err);
  });

  const handle = setInterval(() => {
    releaseExpiredReservations().catch((err) => {
      console.error(">>> [reservation-cleanup] Interval run failed:", err);
    });
  }, intervalMs);

  // Seat holds are short (a cart's lasts 20 minutes), so they are swept every minute.
  const holdsHandle = setInterval(() => {
    releaseExpiredEventHolds().catch((err) => {
      console.error(">>> [event-holds-cleanup] Interval run failed:", err);
    });
  }, 60 * 1000);

  // Don't keep Node alive just for the cleanup job
  if (handle.unref) handle.unref();
  if (holdsHandle.unref) holdsHandle.unref();

  console.log(
    `>>> [reservation-cleanup] Job scheduled every ${intervalMs / 1000}s`
  );

  return handle;
}

module.exports = { releaseExpiredReservations, releaseExpiredEventHolds, startReservationCleanupJob };
