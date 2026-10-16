const env = require("./config/env");
const connectDatabase = require("./config/database");
const app = require("./app");
const { startReservationCleanupJob } = require("./utilities/helpers/release-expired-reservations");
const { reconcileReservedStock } = require("./controllers/pos/inventory-reservation");
const { assertPaynowReadyAtStartup } = require("./controllers/payments/paynow/config-validation");

async function start() {
  // PayNow: a production-mode server that is missing any setting, key file or
  // (for the jar engine) Java refuses to start, instead of failing later in
  // front of a customer. Mock and off modes just log which one is active.
  console.log(`>>> ${await assertPaynowReadyAtStartup()}`);

  await connectDatabase();

  // Start the inventory-reservation expiry cleanup job.
  // Runs every minute — releases held stock for orders that were
  // abandoned without being confirmed (the 30-minute cart hold).
  // Must start AFTER the DB connection is ready so the Mongoose models
  // are initialised before the first query fires.
  // Re-derive every master's reserved-stock counter from the open reservation rows (restart / deploy / crash safety),
  // then start the expiry job - reservations live in the database, so nothing is lost when the server restarts.
  await reconcileReservedStock().then((r) => console.log(`>>> [inventory] reserved-stock reconciled (${r.fixed} corrected)`)).catch((e) => console.error(">>> [inventory] reconcile failed:", e));
  startReservationCleanupJob();

  // Explicit "0.0.0.0" — Render (and most PaaS hosts) route traffic to the
  // container's external interface, not just loopback, so the default host
  // Node picks when none is given isn't a safe assumption to rely on here.
  app.listen(env.PORT, "0.0.0.0", () => {
    console.log(`>>> SSD-Backend listening on http://localhost:${env.PORT}${env.API_PREFIX}`);
    if (env.DRY_RUN_NOTIFICATIONS) {
      console.log(">>> DRY_RUN_NOTIFICATIONS is ON — emails are logged, not sent. See src/common/mailer.");
    }
  });
}

start().catch((err) => {
  console.error(">>> SSD-Backend failed to start:", err);
  process.exit(1);
});