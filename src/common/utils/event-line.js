/**
 * Event cart lines - the third kind of thing a POS/Admin cart can hold, next
 * to Items and Services. Kept in one module so the booking summary, both
 * createOrder implementations, the seat holds and the ticket printer all
 * apply exactly the same rules.
 *
 * What an Event line is:
 *   - Priced per booking (Event.salePrice, GST-inclusive like every other
 *     master), never per deity - effectiveQuantity() always returns 1 for it.
 *   - Tied to one slot when the event needs slots (isSlotRequired), chosen by
 *     `slotKey`.
 *   - Carries the deities picked from the event's own deity mapping, and -
 *     when the event asks for family members - the named devotees.
 *   - Takes SEATS from its slot: exactly one seat per booking, however many
 *     deities or family members it names. The seat is held
 *     from "add to cart" on and turn into booked seats when the booking is
 *     confirmed - see common/utils/event-seats.js for how that is done.
 */
const Event = require("../../models/events");
const EventSeatHold = require("../../models/event-seat-holds");
const { slotKeyOf, todayStart, seatsLeftOf, slotHasStarted } = require("./event-seats");

/** Legacy events (saved before the General Ledger field): gstClassification -> the GST Master "type". */
const GST_TYPE_BY_CLASSIFICATION = {
  APPLICABLE: "Standard Rated",
  EXEMPTED: "Exempt",
  OUT_OF_SCOPE: "Out of Scope",
};

/** One booking takes one seat on its slot - family members and deities do not add seats. */
// eslint-disable-next-line no-unused-vars
function seatsFor(_event, _devotees) {
  return 1;
}

/**
 * Validates one Event cart line against the live Event master and returns
 * everything the summary/order writers need. Throws a plain string on any
 * rule a cashier has to fix (caught by exceptionHandler, shown as a toast).
 *
 * @param {{ refId, slotKey?, holdId?, deities?, devotees? }} line
 * @param {{ portal: "pos" | "admin" }} opts
 */
async function resolveEventLine(line, { portal }) {
  const filter = Event.notDeletedFilter({ _id: line.refId, status: 1, endDate: { $gte: todayStart() } });
  if (portal === "admin") filter.adminBookingVisibility = { $ne: false };
  else filter.posVisibility = true;

  const event = await Event.findOne(filter).select(
    "name code salePrice gstClassification generalLedger deityMapping isSlotRequired slotDetails isFamilyMembersRequired maxFamilyMembers"
  ).populate("generalLedger", "gstType");
  if (!event) throw "An event in the cart is no longer available.";

  // ── slot ──────────────────────────────────────────────────────────────
  // Every event is booked into a slot.
  if (!line.slotKey) throw `Choose a slot for "${event.name}".`;
  const slot = event.slotDetails.find((s) => s.status === 1 && slotKeyOf(s) === line.slotKey && !slotHasStarted(s));
  if (!slot) throw `The selected slot for "${event.name}" is no longer available.`;

  // ── deities ───────────────────────────────────────────────────────────
  // An event with no deities mapped does not need one (nothing to choose); one that has deities needs at least one picked.
  const mapped = event.deityMapping.map(String);
  const deities = mapped.length === 0 ? [] : line.deities || [];
  if (mapped.length > 0) {
    if (deities.length === 0) throw `Select at least one deity for "${event.name}".`;
    if (deities.some((d) => !mapped.includes(String(d)))) {
      throw `A selected deity does not belong to "${event.name}".`;
    }
  }

  // ── devotees ──────────────────────────────────────────────────────────
  let devotees = line.devotees || [];
  if (event.isFamilyMembersRequired) {
    // Devotee details are optional; when given they are capped below.
    if (devotees.length > event.maxFamilyMembers) {
      throw `"${event.name}" allows at most ${event.maxFamilyMembers} family member(s).`;
    }
  } else {
    devotees = [];
  }

  const seats = seatsFor(event, devotees);

  // Seats this cart line already holds are not "taken from" itself, so they
  // are added back to what the slot shows as free.
  let ownHeld = 0;
  if (slot && line.holdId) {
    const own = await EventSeatHold.findOne({
      _id: line.holdId,
      status: "active",
      eventId: event._id,
      slotKey: line.slotKey,
      expiresAt: { $gt: new Date() },
    }).select("seats");
    ownHeld = own?.seats ?? 0;
  }
  const seatsLeft = slot ? seatsLeftOf({ ...slot.toObject(), heldSeats: Math.max(0, (slot.heldSeats || 0) - ownHeld) }) : Infinity;

  return {
    event,
    name: event.name,
    code: event.code,
    unitPrice: event.salePrice,
    // Like an Item or Service: the General Ledger's GST Type decides the GST. Events not yet
    // given a General Ledger fall back to their old GST classification.
    gstType: event.generalLedger?.gstType ?? GST_TYPE_BY_CLASSIFICATION[event.gstClassification] ?? null,
    generalLedgerId: event.generalLedger?._id ?? null,
    deities,
    devotees,
    seats,
    seatsLeft,
    seatsExceeded: seats > seatsLeft,
    holdId: line.holdId ?? null,
    eventSlot: slot
      ? {
          slotKey: slotKeyOf(slot),
          slotName: slot.slotName,
          date: slot.date,
          startTime: slot.startTime,
          endTime: slot.endTime,
        }
      : null,
  };
}

module.exports = {
  slotKeyOf,
  todayStart,
  seatsFor,
  resolveEventLine,
  GST_TYPE_BY_CLASSIFICATION,
};
