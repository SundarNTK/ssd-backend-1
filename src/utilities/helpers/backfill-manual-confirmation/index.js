const { PosTransaction } = require("../../../models/pos-transactions");
const { PosBooking } = require("../../../models/pos-bookings");

/**
 * Sets the "manually confirmed" flags on payments that were confirmed by hand before the flags existed: a transaction
 * with confirmation details becomes isManuallyConfirmed, and its booking hasManualConfirmation. Idempotent and cheap
 * (it only touches rows still missing the flag), so it runs on every server start. Never throws.
 */
async function backfillManualConfirmationFlags() {
  try {
    const tx = await PosTransaction.updateMany(
      { manualConfirmationDetails: { $ne: null }, isManuallyConfirmed: { $ne: true } },
      { $set: { isManuallyConfirmed: true } }
    );
    const bookingIds = await PosTransaction.distinct("bookingId", { isManuallyConfirmed: true, bookingId: { $ne: null } });
    const bookings = bookingIds.length
      ? await PosBooking.updateMany({ _id: { $in: bookingIds }, hasManualConfirmation: { $ne: true } }, { $set: { hasManualConfirmation: true } })
      : { modifiedCount: 0 };
    if (tx.modifiedCount || bookings.modifiedCount) {
      console.log(`>>> manual-confirmation flags backfilled (${tx.modifiedCount} payments, ${bookings.modifiedCount} bookings)`);
    }
    return { payments: tx.modifiedCount, bookings: bookings.modifiedCount };
  } catch (err) {
    console.error(">>> could not backfill the manual-confirmation flags:", err.message);
    return { payments: 0, bookings: 0 };
  }
}

module.exports = { backfillManualConfirmationFlags };
