const express = require("express");

// Payment capture/reconciliation — mounted at /payments (see
// routes/index.js), UNAUTHENTICATED at the router-mount level on purpose:
// the ICN webhook below is called directly by DBS, which never carries this
// app's own auth token. Routes that DO need an operator logged in
// (generate-qr, triggered by the POS counter mid-checkout) apply
// authGuard/adminOnly themselves, right here, the same mixed-router pattern
// controllers/auth already uses for its public + protected routes together.
const authGuard = require("../../common/middleware/auth-guard");
const adminOnly = require("../../common/middleware/admin-only");
const requirePermission = require("../../common/middleware/require-permission");

const generatePaynowQr = require("./paynow/generate-qr");
const icnResponse = require("./paynow/icn-response");
const mockPaynowConfirm = require("./paynow/mock-confirm");
const netsCallback = require("./nets/callback");

const router = express.Router();

router.get("/health", (req, res) => res.json({ ok: true, service: "SSD-Backend", module: "payments" }));

// ── PayNow QR generation — operator-triggered, same permission the POS
// counter's own order-creation route already requires ──────────────────
router.post(
  "/paynow/generate-qr",
  authGuard,
  adminOnly,
  requirePermission("admin-booking", "fullAccess"),
  generatePaynowQr
);

// ── PayNow ICN webhook — public, called by DBS ──────────────────────────
// A PGP-armored payload isn't JSON, so this route gets its own text body
// parser layered in front of the app-wide express.json() (see
// icn-response's own extractArmoredMessage() for exactly what shapes this
// tolerates) — scoped to this one route so every other /payments route
// keeps the app's normal JSON body parsing untouched.
router.post("/paynow/icn-response", express.text({ type: () => true, limit: "1mb" }), icnResponse);

// ── PayNow mock confirmation — development mode ONLY ───────────────────
// Stands in for DBS's ICN so the booking flow, duplicate/expired/wrong-
// amount handling and the confirmation screens can be exercised without a
// real PayNow connection. Refuses to do anything unless PAYNOW_MODE is
// "development" (see paynow/mock-confirm.js), and needs a signed-in staff
// member with the same permission as generating a QR.
router.post(
  "/paynow/mock/icn",
  authGuard,
  adminOnly,
  requirePermission("admin-booking", "fullAccess"),
  mockPaynowConfirm
);

// ── NETS callback — public, called by the local Nets-Service EXE ───────
// Not admin-JWT-gated (the EXE holds no such session) — a shared-secret
// header stands in for auth here instead. See controllers/payments/nets/
// callback's own module comment for the full HEB-equivalence rationale.
router.post("/nets/callback", netsCallback);

module.exports = router;
