const express = require("express");
const requireTicketImage = require("../../common/middleware/require-ticket-image");
const requireSessionCutoff = require("../../common/middleware/require-session-cutoff");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { uploadEventImages, hydrateMultipartBody } = require("../../common/middleware/upload");
const makeCrudController = require("../../common/factories/crud-controller");
const { makeImportExportController } = require("../../common/factories/import-export-controller");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");

const Event = require("../../models/events");
const { createSchema, updateSchema } = require("./request-objects");
const { fields: importExportFields, validateRow, exportRow, exportPopulate, sampleRows } = require("./import-export-fields");

const POPULATE = [
  { path: "generalLedger", select: "name code gstType" },
  { path: "category", select: "name color" },
  { path: "subCategory", select: "name color" },
  // Admin-assigned display order (ties alphabetical) — see models/deities'
  // displayOrder field.
  { path: "deityMapping", select: "name", options: { sort: { displayOrder: 1, name: 1 } } },
];

/**
 * Business rules Joi can't express on its own: the date range has to make
 * sense, and — matching the reference screenshot's own hint text — every
 * slot's date has to fall inside that range once slots are required at all.
 */
function assertDatesValid({ dateType, eventDates, startDate, endDate, isSlotRequired, slotDetails }) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (end < start) throw "End date cannot be before the start date.";
  if (dateType === "MULTIPLE" && (!eventDates || eventDates.length === 0)) {
    throw "Select at least one event date.";
  }

  // Every event needs at least one slot (there is no "slot not required" any more).
  if (!slotDetails || slotDetails.length === 0) {
    throw "At least one slot is required.";
  }
  for (const slot of slotDetails) {
    const slotDate = new Date(slot.date);
    if (slotDate < start || slotDate > end) {
      throw `Slot "${slot.slotName}" date must be between the event's start and end date.`;
    }
  }
}

const { slotKeyOf, keyExpr, bookedExpr, heldExpr, toObjectId, slotHasStarted } = require("../../common/utils/event-seats");
const { buildUserSnapshot } = require("../../common/utils/entity-snapshot");
const { to12Hour } = require("../../common/utils/format-time");

const dayOf = (slot) => new Date(slot.date).toISOString().slice(0, 10);

/** An event "has bookings" once any of its slots has a confirmed booking. */
const eventHasBookings = (event) => (event.slotDetails || []).some((s) => (s.bookedSeats || 0) > 0);
const eventHasHolds = (event) => (event.slotDetails || []).some((s) => (s.heldSeats || 0) > 0);

/**
 * Seat counters belong to the server (see common/utils/event-seats.js): a new
 * slot starts at 0 and anything the form sends for them is ignored.
 */
function withZeroCounters(slotDetails) {
  return (slotDetails || []).map((s) => ({ ...s, bookedSeats: 0, heldSeats: 0 }));
}

/**
 * Slot editing rules, checked against the slots as they are right now.
 *
 *  - A slot with a confirmed booking is frozen: its name, date and times
 *    cannot change, it cannot be removed or made inactive, and its seat limit
 *    can only go UP (never below what is already sold).
 *  - A slot whose seats are being held by an open cart keeps its identity
 *    until those holds clear (a few minutes at most), so a hold can never be
 *    orphaned.
 *  - Any slot's seat limit must stay at or above booked + held seats.
 *
 * A slot needs at least 1 seat. Older slots saved with 0 can be given a real seat count at any time.
 */
function assertSlotChangesAllowed(existingSlots, incomingSlots) {
  const incomingByKey = new Map(incomingSlots.map((s) => [slotKeyOf(s), s]));

  for (const slot of existingSlots) {
    const booked = slot.bookedSeats || 0;
    const held = slot.heldSeats || 0;
    const incoming = incomingByKey.get(slotKeyOf(slot));
    const label = `"${slot.slotName}" on ${dayOf(slot)} at ${to12Hour(slot.startTime)}`;

    if (booked > 0) {
      if (!incoming || incoming.endTime !== slot.endTime) {
        throw `Slot ${label} already has ${booked} booked seat(s) - its name, date and time cannot be changed and it cannot be removed. You can only increase its seats.`;
      }
      // A booked slot may be switched Inactive (it then drops off every booking screen); its existing bookings stay as they are.
      // Seats can only go up. A slot saved with 0 seats (the old "no limit" setting) has nothing to
      // go below, so any seat count that covers what is already booked or held is accepted for it.
      if (incoming.totalSeats < slot.totalSeats) {
        throw `Slot ${label} has bookings, so its seats can only be increased (currently ${slot.totalSeats}).`;
      }
    } else if (held > 0 && (!incoming || incoming.endTime !== slot.endTime || incoming.status !== 1)) {
      throw `Slot ${label} has ${held} seat(s) held by open carts. Try again in a few minutes.`;
    }
  }

  for (const incoming of incomingSlots) {
    const existing = existingSlots.find((s) => slotKeyOf(s) === slotKeyOf(incoming));
    if (!existing) continue;
    const used = (existing.bookedSeats || 0) + (existing.heldSeats || 0);
    if (incoming.totalSeats < used) {
      throw `Slot "${incoming.slotName}" has ${used} seat(s) booked or held, so its seats cannot be set below that.`;
    }
  }
}

/**
 * Slot times: the end must be later than the start, and a slot that is new (or moved to another
 * date / start time) must still be in the future - today later on, or a later day. A slot left at
 * its saved date and start time is not re-checked, so an event can still be edited after the
 * date of an old slot has gone by.
 */
function assertSlotTimes(existingSlots, incomingSlots) {
  for (const slot of incomingSlots || []) {
    const label = `Slot "${slot.slotName}"`;
    if (String(slot.endTime) <= String(slot.startTime)) throw `${label}: the end time must be later than the start time.`;
    const unchanged = existingSlots.some((e) => dayOf(e) === dayOf(slot) && e.startTime === slot.startTime);
    if (!unchanged && slotHasStarted(slot)) throw `${label}: choose today (a start time still to come) or a future date.`;
  }
}

/** Two active slots on the same date cannot run at overlapping times (one may start when the other ends). */
function assertNoSlotOverlap(slots) {
  const active = (slots || []).filter((s) => (s.status ?? 1) === 1 && s.startTime && s.endTime);
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      if (dayOf(a) !== dayOf(b)) continue;
      if (String(a.startTime) < String(b.endTime) && String(b.startTime) < String(a.endTime)) {
        throw `Slot "${b.slotName}" (${b.startTime}-${b.endTime}) overlaps slot "${a.slotName}" (${a.startTime}-${a.endTime}) on ${dayOf(a)}.`;
      }
    }
  }
}

/** A slot field read from the CURRENT document inside a MongoDB expression (0 when the slot is gone). */
function slotFieldExpr(key, field) {
  return {
    $ifNull: [
      {
        $first: {
          $map: {
            input: { $filter: { input: "$slotDetails", as: "f", cond: { $eq: [keyExpr("f"), key] } } },
            as: "m",
            in: `$$m.${field}`,
          },
        },
      },
      0,
    ],
  };
}

const totalBookedExpr = { $sum: { $map: { input: "$slotDetails", as: "s", in: bookedExpr("s") } } };
const totalHeldExpr = { $sum: { $map: { input: "$slotDetails", as: "s", in: heldExpr("s") } } };

async function create(req, res) {
  try {
    req.body.isSlotRequired = true;
    assertDatesValid(req.body);
    assertSlotTimes([], req.body.slotDetails);
    assertNoSlotOverlap(req.body.slotDetails);
    req.body.slotDetails = withZeroCounters(req.body.slotDetails);
    const doc = await Event.create({ ...req.body, createdBy: req.auth?.userId || null });
    const populated = await doc.populate(POPULATE);
    return responseHandler({ res, response: populated, successMessage: "Created successfully.", statusCode: 201 });
  } catch (error) {
    if (error?.code === 11000) {
      return exceptionHandler({ res, error: "An event with this code already exists.", statusCode: 409 });
    }
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * Edits an event WITHOUT ever overwriting the live seat counters.
 *
 * The admin form sends back the whole slot list, but bookedSeats/heldSeats
 * change on their own whenever a cart holds or a booking confirms. Saving the
 * document the usual way would write the counters as they were when the form
 * was opened and silently erase seats sold in between. Instead the update is
 * ONE conditional pipeline update:
 *   - the new slot list is merged with the counters of the document AS IT IS
 *     AT WRITE TIME, so they are never overwritten, and
 *   - the update's filter re-checks the rules above against that same moment
 *     (a slot being changed still has nothing held, nothing booked changed
 *     under us, seat limits still cover booked + held).
 * If a booking lands between reading and writing the filter simply does not
 * match and the whole thing is re-read and re-checked (up to 3 times).
 */
async function update(req, res) {
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await Event.findOne(Event.notDeletedFilter({ _id: req.params.id }));
      if (!existing) throw "Event not found.";

      const existingSlots = existing.slotDetails.map((s) => s.toObject());
      const bookedAlready = eventHasBookings(existing);

      assertDatesValid({
        dateType: req.body.dateType ?? existing.dateType,
        eventDates: req.body.eventDates ?? existing.eventDates,
        startDate: req.body.startDate ?? existing.startDate,
        endDate: req.body.endDate ?? existing.endDate,
        slotDetails: req.body.slotDetails ?? existing.slotDetails,
      });

      if (req.body.status === 0 && bookedAlready) {
        throw "This event has bookings, so it cannot be made inactive.";
      }

      req.body.isSlotRequired = true;
      const incomingSlots = req.body.slotDetails;
      if (incomingSlots) {
        assertSlotChangesAllowed(existingSlots, incomingSlots);
        assertSlotTimes(existingSlots, incomingSlots);
        assertNoSlotOverlap(incomingSlots);
      }

      // Validate the whole proposed document the normal Mongoose way...
      const { slotDetails: _ignored, ...scalarBody } = req.body;
      existing.set(scalarBody);
      if (incomingSlots) existing.set("slotDetails", withZeroCounters(incomingSlots));
      await existing.validate();
      const proposed = existing.toObject({ depopulate: true });

      // ...then write it as one atomic update.
      const setDoc = {};
      for (const key of Object.keys(scalarBody)) setDoc[key] = { $literal: proposed[key] };
      setDoc.updatedBy = { $literal: req.auth?.userId ? toObjectId(String(req.auth.userId)) : null };
      if (req.auth?.userId) setDoc.updatedByInfo = { $literal: await buildUserSnapshot(req.auth.userId) };

      const guards = [];
      if (req.body.status === 0) guards.push({ $eq: [totalBookedExpr, 0] });

      if (incomingSlots) {
        const incomingKeys = new Set(proposed.slotDetails.map((s) => slotKeyOf(s)));
        for (const slot of existingSlots) {
          const key = slotKeyOf(slot);
          // No booking may have landed since we looked...
          guards.push({ $eq: [slotFieldExpr(key, "bookedSeats"), slot.bookedSeats || 0] });
          // ...and a slot that is being changed or removed must still have nothing held on it.
          const keeps = incomingKeys.has(key);
          if (!keeps) guards.push({ $eq: [slotFieldExpr(key, "heldSeats"), 0] });
        }
        for (const incoming of proposed.slotDetails) {
          if (incoming.totalSeats > 0) {
            const key = slotKeyOf(incoming);
            guards.push({ $lte: [{ $add: [slotFieldExpr(key, "bookedSeats"), slotFieldExpr(key, "heldSeats")] }, incoming.totalSeats] });
          }
        }

        setDoc.slotDetails = {
          $map: {
            input: { $literal: proposed.slotDetails },
            as: "n",
            in: {
              $let: {
                vars: { old: { $first: { $filter: { input: "$slotDetails", as: "o", cond: { $eq: [keyExpr("o"), keyExpr("n")] } } } } },
                in: { $mergeObjects: ["$$n", { bookedSeats: { $ifNull: ["$$old.bookedSeats", 0] }, heldSeats: { $ifNull: ["$$old.heldSeats", 0] } }] },
              },
            },
          },
        };
      }

      const filter = { _id: existing._id, isDeleted: false };
      if (guards.length) filter.$expr = { $and: guards };
      const result = await Event.collection.updateOne(filter, [{ $set: setDoc }]);
      if (result.matchedCount === 0) continue; // changed under us - re-read and re-check

      const fresh = await Event.findById(existing._id).populate(POPULATE);
      return responseHandler({ res, response: fresh, successMessage: "Updated successfully." });
    }
    throw "This event was just booked or changed by someone else. Please reopen it and try again.";
  } catch (error) {
    if (error?.code === 11000) {
      return exceptionHandler({ res, error: "An event with this code already exists.", statusCode: 409 });
    }
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 409 : undefined });
  }
}

/**
 * An event with bookings is part of the sales record and cannot be deleted
 * (nor one that carts are holding seats on right now). The check and the
 * delete are one conditional update, so a booking landing at the same moment
 * cannot slip past it.
 */
async function remove(req, res) {
  try {
    const existing = await Event.findOne(Event.notDeletedFilter({ _id: req.params.id }));
    if (!existing) throw "Event not found.";
    if (eventHasBookings(existing)) throw "This event has bookings, so it cannot be deleted.";

    const result = await Event.collection.updateOne(
      { _id: existing._id, isDeleted: false, $expr: { $and: [{ $eq: [totalBookedExpr, 0] }, { $eq: [totalHeldExpr, 0] }] } },
      [{ $set: { isDeleted: true, status: 0, updatedBy: { $literal: req.auth?.userId ? toObjectId(String(req.auth.userId)) : null } } }]
    );
    if (result.matchedCount === 0) {
      throw eventHasHolds(existing) || (await Event.findById(existing._id).then(eventHasHolds))
        ? "Seats on this event are being held by open carts right now. Try again in a few minutes."
        : "This event has bookings, so it cannot be deleted.";
    }
    return responseHandler({ res, successMessage: "Deleted successfully." });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 409 : undefined });
  }
}

/** The list carries a ready-made `hasBookings` flag so the screen can lock what must not be touched. */
const decorateEvents = async (docs) =>
  docs.map((doc) => ({ ...doc.toObject(), hasBookings: eventHasBookings(doc), hasHeldSeats: eventHasHolds(doc) }));

// Mounted at /masters — see routes/index.js (authGuard/adminOnly now applied
// once for the whole /masters group there, not per master).
const router = express.Router();

const crud = makeCrudController(Event, { searchFields: ["name", "code", "tamilName"], populate: POPULATE, decorateItems: decorateEvents });

router.get("/events", requirePermission("events", "view"), crud.list);
router.post(
  "/events",
  requirePermission("events", "fullAccess"),
  uploadEventImages,
  hydrateMultipartBody,
  validateBody(createSchema),
  requireTicketImage(Event),
  requireSessionCutoff(Event),
  create
);
router.put(
  "/events/:id",
  requirePermission("events", "edit"),
  uploadEventImages,
  hydrateMultipartBody,
  validateBody(updateSchema),
  requireTicketImage(Event),
  requireSessionCutoff(Event),
  update
);
router.delete("/events/:id", requirePermission("events", "fullAccess"), remove);

// Excel import/export — see common/factories/import-export-controller.js.
const importExport = makeImportExportController(Event, {
  entityLabel: "Event",
  sheetName: "Events",
  fields: importExportFields,
  validateRow,
  exportRow,
  exportPopulate,
  sampleRows,
  extraDefaults: { status: 1, image: null },
});

router.get("/events/export", requirePermission("events", "view"), importExport.exportList);
router.get("/events/import/template", requirePermission("events", "view"), importExport.downloadTemplate);
router.post("/events/import/validate", requirePermission("events", "fullAccess"), importExport.validateImport);
router.post("/events/import/commit", requirePermission("events", "fullAccess"), importExport.commitImport);

module.exports = router;
