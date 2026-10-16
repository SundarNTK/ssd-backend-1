# PayNow (DBS PayNow Corporate) Integration

Status: **code implemented, running on HEB's borrowed DBS credentials — NOT SAFE FOR PRODUCTION until swapped for SSD's own.** See [Current status & what's borrowed](#current-status--whats-borrowed) before doing anything with this beyond local dev/testing.

This mirrors HEB's own working Payment-Service implementation
(`D:\PROJECTS\HEB\Payment-Service\source\controllers\paynow`) as closely as
possible, adapted to SSD-Backend's single-entity POS flow
(`controllers/pos-orders`, `models/pos-orders` / `pos-bookings` /
`pos-transactions`).

## Modes, configuration and what is still open (October 2026)

> This section is the current design. Where the older sections further down
> talk about a `dummy` or `java` engine and a default of `dummy`, this
> replaces them: see "Modes" below.

### Modes — `PAYNOW_MODE`

| Mode | Set by | QR code | Confirmation | Real money |
|---|---|---|---|---|
| `development` | `PAYNOW_MODE=development`, or unset when `NODE_ENV` is not `production` | A mock QR: real amount and reference, but a fixed fake merchant (`SSD TEST - DO NOT PAY`, proxy `MOCKNOTAUEN`). The `PAYNOW_*` values are never used, so even a real UEN left in the environment cannot make a payable QR. | `POST /api/v1/payments/paynow/mock/icn` (staff login + `admin-booking` full access) runs the same code a real ICN would, for scenarios `success`, `pending`, `duplicate`, `wrong_amount`, `expired`, `cancelled`, `unknown_reference`. | No |
| `production` | `PAYNOW_MODE=production` | The real QR from the engine named in `PAYNOW_QR_ENGINE` (`jar` or `native`). | DBS's ICN only, after decrypt + signature check + parse + the pending-payment checks. The mock route refuses. | Yes |
| disabled | `PAYNOW_MODE` unset while `NODE_ENV=production` | None. QR requests and the ICN route refuse. | None | No |

A `PAYNOW_MODE` that is set to anything else is an error at startup, never a
silent default.

**Production never falls back.** If the jar fails or a value is missing, the
request fails with the reason and the pending payment is cancelled; it does
not produce a mock QR. At startup, in production mode the server checks
every required setting, that `PAYNOW_CREDENTIALS_ARE_SSD_OWN=true`, that both
key files exist and parse (the private key must not be passphrase
protected), and for `jar` that the jar and Java are present. If anything is
wrong the process **does not start** and prints the full list.

### What each part does

```
generate-qr/engines.js       the two ways to draw the QR: jar, native
generate-qr/build-payload.js builds the QR text (EMVCo/SGQR) for `native` and `development`
provider/                    one interface, three implementations (mock, live, disabled), chosen by mode.js
mode.js                      PAYNOW_MODE -> development | production | disabled
config-validation.js         the production settings check + startup gate
keys.js                      where the PGP key files are
icn-response/decrypt-response.js  decrypt with our private key AND require a valid DBS signature
icn-response/parse-icn.js    reads the decrypted JSON; decides settled / pending / unusable
icn-response/process-icn.js  routes it to the payment (dispatch.js) and logs the outcome
models/paynow-icn-logs       one row per ICN handled (settled, duplicate, pending, rejected)
mock-confirm.js              development-only stand-in for DBS
```

### The JAR file — what it is (checked, not assumed)

`public/Paynowsdk/dist/PayQRSDK.jar` is a 1.5 KB command-line wrapper
(`payqrsdk.PayQRSDK`, built with Ant on Java 8). It does one thing: it fills a
`com.dbs.sgqr.generator.io.PayNow` object from its arguments, calls
`QRGenerator.generateSGQR(...)`, and prints the QR image as base64. The real
work is in `lib/SGQRGenerator-1.6.jar`, which is **DBS's own library**
(`com/dbs/sgqr/generator/...`: `QRGenerator`, `PayNowHelper`,
`PayNowValidator`, `SGQRValidator`, `CrcUtil`, `ImageGenerator`, error-code
tables), bundled with ZXing for drawing the QR and a few unrelated libraries.

It builds the QR text, validates it against DBS's PayNow/SGQR rules, adds the
CRC checksum, and draws the image with the PayNow logo and colour. It does
**not** sign, encrypt or call the network. It is not involved in the ICN.

**Can Node.js replace it?** For the text, yes: `native` is the same format and
reproduces the jar's output exactly. This was checked by running the jar
(Java 26) with a fake merchant, decoding its QR, and comparing field by field
(`generate-qr/__tests__/jar-parity.test.js` keeps that result as a test). Two
real differences were found and are now settings, defaulting to what the jar
writes:

| Field | Spec wording | DBS jar | Setting |
|---|---|---|---|
| Tag 00, payload format indicator | `01` | `00` | `PAYNOW_PAYLOAD_FORMAT_INDICATOR` |
| Tag 26.04, proxy expiry | `YYYYMMDD` | `YYYYMMDDHHmmss` | `PAYNOW_PROXY_EXPIRY_FORMAT` |

What `native` does **not** do: the jar's validator (field rules and error
codes) and the logo/colour styling. Whether DBS requires the jar or accepts a
QR built to the standard is a question for the PayNow team; until they
answer, `jar` is the safe choice and `native` is ready if they allow it.
Using `jar` in the Docker image means adding a Java runtime to it.

### ICN decoding — same approach as HEB, with two additions

HEB's `decrypt-resposne.js` decrypts with our private key and passes DBS's
public key as `verificationKeys`, but **never checks the result**. In
openpgp, a bad or missing signature does not make `decrypt` fail; it must be
awaited from `signatures[].verified`. Without that check anyone holding our
(public) key could forge a "payment received" message. SSD now requires at
least one verified signature, otherwise the message is rejected
(`icn-response/__tests__/decrypt-response.test.js`, real generated keys).

After decrypting, `parse-icn.js` rules (fields follow HEB's handling of DBS's
messages; **not yet confirmed for SSD**):

- not JSON / not an object / no `txnInfo` / no `customerReference` -> rejected
- `customerReference` must look like a reference this system issues (13 upper-case letters/digits)
- `txnRefId` present -> `settled`; absent -> `pending` (nothing is confirmed)
- amount, if present, must be a positive number; currency, if present, must be SGD
- a `settled` message without an amount is rejected (it could not be checked)

Decoding is **not** proof of payment. A settled message is then checked
against the pending payment we created: it must exist, still be pending, not
be expired (15 minutes) or cancelled, and the amount must equal the fixed one.
A repeat of an already-paid payment is a no-op. Every ICN, accepted or
refused, is written to `paynow_icn_logs`.

### Status of each part

| Part | State |
|---|---|
| Mode switch, provider interface, mock QR, mock confirm | Done and tested |
| Production startup checks (settings, keys, Java) | Done and tested |
| QR text builder (`native`) vs the jar | Done; matches the jar exactly with the jar's two format choices |
| `jar` engine | Works with the jar in the repo (run with Java 26). Needs Java in the server image for production. |
| ICN decrypt + signature check | Done and tested with generated keys |
| ICN parsing, outcome handling, ICN log | Done and tested; **field names are HEB's, pending DBS** |
| Booking/payment update on confirmation | Existing `confirmPosPayment` (unchanged) |
| Real merchant values, keys, ICN URL registration | **Waiting for the PayNow team** |
| End-to-end test against DBS UAT | **Not possible until the above** |

### Pending from the PayNow team

1. The temple's UEN with any suffix, merchant name (<= 25 chars), city, category code, and confirmation of proxy type, fixed amount (`0`) and one-time QR (`12`).
2. Whether the jar is mandatory, or a standard-conforming QR is accepted; the jar itself if mandatory.
3. Tag 00 value (`00` vs `01`) and tag 26.04 format (`datetime` vs `date`); the maximum reference length (ours is 13).
4. Key exchange: the temple creates its key pair and gives DBS the public half; DBS's public key for UAT and for live; which file is which; **confirmation that every ICN is signed**.
5. ICN details: exact body (`{"data": "<PGP>"}` or raw), field names, how "completed" is signalled, the response DBS expects, retry and duplicate behaviour, source IPs.
6. UAT test method and sign-off, settlement reports, refund and expiry rules, fees and limits, support contact.

### Setting it up once the values arrive

1. Put the two key files on the server in a protected folder, mounted read-only into the container; never in git.
2. Set every `PAYNOW_*` value in `backend.env` (see `.env.example`), `PAYNOW_QR_ENGINE`, and `PAYNOW_CREDENTIALS_ARE_SSD_OWN=true`.
3. For `jar`: add a Java runtime to the Docker image.
4. Set `PAYNOW_MODE=production` and restart; the startup log must say `PayNow mode: production`.
5. Register `https://api.sivadurga.com/api/v1/payments/paynow/icn-response` with DBS; allow only DBS's IPs on that path in Nginx and keep rate limits on.
6. Test on DBS UAT, then live. Reconcile daily against DBS's report.

## How the whole flow works

PayNow QR payment is **two completely separate, asynchronous steps** — this
is the single most important thing to understand about it:

1. **QR generation** builds a QR code image AND fixes the amount that
   payment will confirm. This talks to DBS itself **only** if
   `PAYNOW_QR_ENGINE=java` (the certified path, see below) — either way, no
   network call happens for the QR image itself. What actually happens:
   `controllers/pos-orders`' `createPendingPayment()` resolves/validates the
   amount (the requested amount, or the full outstanding balance), cancels
   any earlier still-open QR for the same order, and writes a
   `pos_transactions` row with `paymentStatus: "pending"` and that amount —
   **fixed, from this point on** — before the QR image is even built
   (`buildPaynowQrForOrder`, `controllers/pos-orders/index.js`). Generating a
   QR is still not a payment (nothing is marked `"paid"` here, and a
   customer could generate ten QRs — each cancelling the last — and pay
   none of them).

   This runs from **two places**, sharing the same `buildPaynowQrForOrder`:
   - **The order's very first payment** — `POST /pos/booking/orders`
     (`controllers/pos-orders`' `createOrder`) builds the QR itself, right
     inside that same request, and returns it embedded as
     `paymentDetails: { amount, qr, engine }` in the order-create response.
     The POS counter never has to make a second call just to see a QR for a
     brand new PayNow order. If QR-building fails (config incomplete, a
     render error), the order itself is still created and returned —
     `paymentDetails` comes back `null` and `paymentDetailsError` names
     why, so the frontend can fall back to the standalone route below with
     the order's `referenceId` rather than losing the order (and its
     inventory hold) outright.
   - **A top-up against an already-confirmed booking** —
     `POST /payments/paynow/generate-qr` (`controllers/payments/paynow/
     generate-qr/index.js`) — there's no order-create response to embed a
     QR into at that point (BookingSuccessView's "Pay Again"), so this
     standalone route is still what the frontend calls directly.

2. **Payment confirmation** — either **DBS itself**, calling
   `POST /api/v1/payments/paynow/icn-response` with an encrypted "Instant
   Credit Notification" (ICN) once the customer actually scans and pays, OR
   an admin manually confirming the same pending payment from the **POS
   Order Confirmation** admin screen (`controllers/pos-order-confirmation`)
   when a real webhook can't reach this server (e.g. `localhost` in local
   dev). Both call the exact same `confirmPosPayment()` — genuinely the
   same code path, not two parallel ones — and **neither gets to choose a
   different amount than the one createPendingPayment() already fixed**;
   they can only confirm it, the same way a Cash cashier can't "confirm" a
   receipt for more than what was rung up. The admin screen's own form
   accordingly has no amount field at all — see that module's own comment
   and its reference, HEB's Admin-Frontend, which renders this amount
   read-only in every one of its own equivalent confirm screens.

```
POS counter                     SSD-Backend                          DBS
    |                                |                                 |
    |  POST .../generate-qr          |                                 |
    |------------------------------->|                                 |
    |          write pos_transactions "pending" (amount fixed here)    |
    |          cancel any earlier still-pending row for this order     |
    |            (runs PayQRSDK.jar locally, no network call)          |
    |  <-- QR image (base64 PNG) ----|                                 |
    |                                |                                 |
    |  [displays QR, customer scans it in their banking app]           |
    |                                |                                 |
    |                                |     customer pays  ------------>|
    |                                |                                 |
    |                                |<-- POST .../icn-response -------|
    |                                |   (PGP-encrypted ICN payload)    |
    |                                |         -- OR, if unreachable -- |
    |                                |<== admin manually confirms ==    |
    |                                |    (POS Order Confirmation screen)|
    |                                |                                 |
    |            decrypt + verify with DBS's key (webhook only)        |
    |            find the PENDING pos_transactions row by referenceId  |
    |            atomically claim it "paid" (idempotent — see below)   |
    |            first payment: write the pos_booking now               |
    |            top-up: recompute the booking's paymentStatus          |
    |                                |                                 |
    |  GET .../orders/:id/status (polled by the frontend)               |
    |------------------------------->|                                 |
    |  <-- "confirmed" ---------------|                                 |
```

The POS frontend never learns "payment succeeded" from the QR-generation
call — it has to poll `GET /pos/booking/orders/:id/status` (already built,
see `controllers/pos-orders`) until the ICN webhook has landed and flipped
the order to `confirmed`. This is exactly the same pattern Cash already
uses today, just with the confirmation arriving from DBS instead of
happening synchronously in the same request.

## What correlates a QR to a payment

Every QR is generated for one `pos_order`'s 13-character `referenceId`
(e.g. `POS8N7J3QNPS4` — see `common/utils/payment-reference.js`). That same
id is embedded **inside** the QR's data as the transaction reference
(`Event_Order_Ref_No`), and DBS echoes it straight back in the ICN payload
as `txnInfo.customerReference`. That's the only thread connecting "a QR was
scanned and paid" to "which order this was for" — there is no other
correlation mechanism. See `controllers/pos-orders`' `confirmPosPayment()`
for what happens once that id comes back:

1. Finds the order's one active `pos_transactions` row with
   `paymentStatus: "pending"` — `createPendingPayment()` guarantees there's
   never more than one at a time.
2. If a `gatewayReference` (`txnRefId`) already recorded on a `"paid"` row
   matches, this is a duplicate callback — returns immediately as a no-op.
3. If the pending row has passed its own `expiresAt` (15 minutes from
   generation), marks it `"expired"` and refuses — a fresh QR is needed.
4. If an `amount` was given (a real gateway reporting its own figure), it
   must match the pending row's fixed amount, or this throws — the
   confirmation can attest to the fixed amount, never change it.
5. Atomically claims the row (`findOneAndUpdate` guarded on
   `paymentStatus: "pending"`) — this is what makes a race between two
   near-simultaneous confirmations for the same row safe: whichever loses
   the atomic update sees it match nothing and reports back as already
   processed instead of double-confirming.
6. Resolves whether this is the order's first payment (still pending —
   writes the `pos_booking` now) or a top-up (already confirmed — just
   recomputes the booking's `paymentStatus` from every paid transaction).

The **POS Order Confirmation** admin screen
(`controllers/pos-order-confirmation`) is the manual stand-in for step 2
when no real DBS webhook reaches this server — it calls this exact same
`confirmPosPayment()`, just with an admin-entered `gatewayReference`
instead of one DBS supplied, and (deliberately) no amount input at all.

## What details a QR generation payload actually needs

`controllers/payments/paynow/generate-qr` builds the QR from these fields
(all currently read from `config/env.js`, sourced from `.env`):

| Field | What it is | Merchant-specific? |
|---|---|---|
| `PAYNOW_MERCHANT_CATEGORY_CODE` | DBS-assigned 4-digit MCC | Yes |
| `PAYNOW_TXN_CURRENCY` | ISO 4217 numeric currency code (`702` = SGD) | No — fixed for SG |
| `PAYNOW_COUNTRY_CODE` | `SG` | No — fixed for SG |
| `PAYNOW_MERCHANT_NAME` | Display name shown in the payer's banking app | Yes |
| `PAYNOW_MERCHANT_CITY` | `Singapore` | No |
| `PAYNOW_GLOBAL_UNIQUE_ID` | `SG.PAYNOW` — identifies the QR as following the SG PayNow scheme | No — spec constant |
| `PAYNOW_PROXY_TYPE` | What kind of proxy `PAYNOW_PROXY_VALUE` is (`2` = UEN) | Depends on registration type |
| `PAYNOW_PROXY_VALUE` | **The actual UEN/proxy DBS registered — this is what determines which bank account gets paid** | **Yes — the critical one** |
| `PAYNOW_EDITABLE_AMOUNT` | Whether the payer can change the amount (`1`/`0`) | Merchant choice |
| `PAYNOW_POINT_OF_INITIATION` | EMVCo static/dynamic QR flag | Merchant choice, usually fixed per integration |
| `PAYNOW_QR_COLOR_CODE` | Cosmetic QR accent color | Cosmetic only |
| the order's `referenceId` | Embedded as `Event_Order_Ref_No` | Generated per-order, not config |
| the order's amount | The `Total_Amount` argument | Resolved server-side from the order/booking, never trusted from the client |

The amount is **always resolved server-side** (`resolveOutstandingBalance()`
in `generate-qr/index.js`) from the `pos_order`/`pos_booking`'s own
`grandTotal` minus what's already been paid — the same principle
`createOrder`/`confirmOrder` already apply for Cash. An `amount` in the
request body is accepted only to request a **partial** payment (clamped to
the outstanding balance), never to inflate it.

## What the ICN webhook needs

`controllers/payments/paynow/icn-response` needs to **decrypt and verify**
DBS's notification before trusting anything in it — this is the actual
authentication mechanism for this endpoint (it's mounted unauthenticated;
only someone holding DBS's real signing key could produce a message our
key verifies). That needs:

- **Our own PGP private key** (to decrypt) — `public/Paynowsdk/dbs-paynow-private-SECRET.asc`
- **DBS's PGP public key** (to verify the signature) — `public/Paynowsdk/dbs-paynow-public-uat.asc` (or `-live.asc`)

Both are currently HEB's own keys, borrowed — see below.

## Current status & what's borrowed

Everything below is copied from HEB's own live `.env` / key files, exactly
as asked, so this code path can be exercised end-to-end before SSD's own
DBS paperwork is done. **None of it is safe to use for a real payment**:

- `PAYNOW_MERCHANT_NAME=HINDU ENDOWMENTS BOARD` and `PAYNOW_PROXY_VALUE=T08GB0016CH02`
  are HEB's own registered identity — if a real customer ever scanned a QR
  generated with these, **the money would go to HEB's bank account**, not
  SSD's, regardless of what the app or receipt says.
- The PGP key pair is HEB's own DBS-issued keys.
- `PAYNOW_CREDENTIALS_ARE_SSD_OWN=false` in `.env` reflects this.
  `assertPaynowConfigured()` (`generate-qr/render.js`) refuses to run the
  **`java` engine** at all if `NODE_ENV=production` while this stays
  `false` — this is the one safety net stopping a forgotten swap from
  silently going live on HEB's identity through DBS's actual certified
  pipeline. **Do not remove or bypass this check.** Flip
  `PAYNOW_CREDENTIALS_ARE_SSD_OWN` to `true` only once every value in the
  table above, and both key files, are genuinely SSD's own. The **`dummy`
  engine** (the default — see below) is deliberately exempt from this guard:
  it never talks to DBS's certified pipeline at all, so it's safe to run in
  any environment, including a Render deployment's `NODE_ENV=production`,
  purely to demo/test the POS flow end-to-end before SSD's own DBS
  onboarding is done.
- `MERCHANT_NAME` is left as HEB's real name (not relabelled "Sri Siva Durga
  Temple") deliberately — displaying SSD's name while the money still
  routes to HEB's account would be more actively misleading than leaving it
  honestly HEB-branded while this is admittedly a borrowed test setup.

### Two files still need to be placed manually

Copying HEB's key material was blocked by this session's safety
guardrails (copying a real private key across two different clients'
codebases is exactly the kind of action that should get a human's eyes on
it, not an agent's). You'll need to copy these three files yourself from
`D:\PROJECTS\HEB\Payment-Service\public\Paynowsdk\` into
`SSD-Backend\public\Paynowsdk\`, renaming as shown (the code already
expects these exact names):

| Source (HEB) | Destination (SSD-Backend) |
|---|---|
| `HebPayment_Private_SECRET.asc` | `dbs-paynow-private-SECRET.asc` |
| `HEBPaymentUAT_public.asc` | `dbs-paynow-public-uat.asc` |
| `HebPaymentLive_Public.asc` | `dbs-paynow-public-live.asc` (optional — UAT is the default, see `PAYNOW_PUBLIC_KEY_PATH`) |
| `sample-response.asc` | `sample-response.asc` (optional — a sample encrypted ICN payload, useful for a manual local decrypt test) |

These are already git-ignored in this repo (`.gitignore` —
`public/Paynowsdk/dbs-paynow-*.asc`), unlike HEB's own repo which does
track them — see the `.gitignore` comment for why that's a deliberate
difference. The QR SDK jar, its `lib/` dependencies, and `PayNow.png` are
**not** secret and are already copied + tracked normally.

### Also still needed: install the new dependency

`openpgp` was added to `package.json` but the actual install
(`pnpm install`) was also blocked by this session's guardrails (installing
a new package is treated the same way). Run `pnpm install` before starting
the server — until then, anything that touches the ICN webhook path will
fail with `Cannot find module 'openpgp'`.

## What to ask SSD's own DBS PayNow contact for

When SSD's own DBS PayNow Corporate onboarding happens, everything in the
table above needs SSD's own value. Concretely, ask DBS (or whichever bank
issues SSD's PayNow Corporate service) for:

1. **The PayNow proxy ID** DBS issues for SSD's registered UEN — this is
   the single most important item; it's what `PAYNOW_PROXY_VALUE` becomes,
   and it's what actually determines whose bank account gets paid.
2. **SSD's Merchant Category Code (MCC)**.
3. **The exact registered merchant/legal entity name** DBS has on file for
   SSD (goes into `PAYNOW_MERCHANT_NAME`, shown to every payer).
4. **The QR-generation SDK/library** DBS issues for SSD's own program —
   confirm it's the same `PayQRSDK.jar` (Java) HEB uses, or get whatever
   SSD's own is. This also means confirming **a Java runtime needs to be
   installed on whatever server runs SSD-Backend** (see
   `generate-qr/find-java.js`).
5. **The "Global Unique ID"** DBS issues (likely `SG.PAYNOW` again — this
   is a scheme constant, not merchant-specific, but confirm).
6. **Which point-of-initiation-method / editable-amount configuration**
   SSD is provisioned for (static vs. dynamic QR).
7. **ICN (Instant Credit Notification) webhook setup**:
   - the callback URL to register — currently
     `http://localhost:5003/api/v1/payments/paynow/icn-response` in dev
     (see `PAYNOW_ICN_RESPONSE_URL` in `.env`); this needs to become
     SSD-Backend's real public URL once deployed,
   - **DBS's own PGP public key** for SSD's environment (to verify their
     ICN signature),
   - instructions to **generate SSD's own PGP keypair** and register its
     public half with DBS (SSD's private key stays only on SSD-Backend's
     server, never sent to DBS),
   - whatever DBS puts in front of that webhook for authentication beyond
     the PGP signature itself (an API key, IP allow-list, mutual TLS —
     HEB's own reference code doesn't show one, worth asking explicitly).
8. **Separate UAT/sandbox credentials**, distinct from production, so this
   can be tested safely before it ever touches a real donor's payment.
9. If refunds matter: **a separate Refund API contract** — HEB's own
   reference implementation for this
   (`D:\PROJECTS\HEB\Payment-Service\source\controllers\refund`) is itself
   still a stub with the real DBS call commented out and a simulated
   response, so this hasn't actually been proven working even on HEB's
   side. **Not implemented for SSD at all yet** — out of scope for this
   phase.

## Files

- `src/controllers/payments/paynow/generate-qr/` — `index.js` (the standalone HTTP route, top-ups only), `render.js` (the facade `assertPaynowConfigured` / `renderQrImage`, shared with `controllers/pos-orders`' `buildPaynowQrForOrder` so a brand new order's first QR can be built in-process without a require cycle), `engines.js` (jar / native), `build-payload.js`, `find-java.js`; `../provider/` (mock / live / disabled) and `../mode.js` choose which runs
- `src/controllers/payments/paynow/icn-response/` — the webhook (`index.js`, `decrypt-response.js`)
- `src/controllers/payments/dispatch.js` — the shared prefix-routed confirmation dispatcher both this and future payment modes (NETS) call into
- `src/controllers/payments/index.js` — routes: `POST /paynow/generate-qr` (operator-authenticated), `POST /paynow/icn-response` (public)
- `src/config/env.js` — every `PAYNOW_*` field, all empty by default (no real values hardcoded in source — see that file's own comment)
- `public/Paynowsdk/` — the QR SDK jar + brand image (tracked in git) and the DBS key material (git-ignored, currently HEB's borrowed keys)

## What's NOT implemented yet

- Refunds.
- Anything beyond the single-entity case — `PAYNOW_PROXY_VALUE` etc. are
  one fixed value; if SSD ever has multiple outlets each needing their own
  DBS proxy, this needs the same kind of per-outlet switch HEB's own
  `generate-qr` has for its multiple temples (see that file's `Temple_ID`
  switch) — not built here since SSD is single-entity today.
- Server-side enforcement of the QR's real expiry — the QR is generated
  with a 1-year validity window (matching HEB's own reference code
  exactly), but nothing here currently checks that window server-side
  before honoring an ICN; DBS itself is presumably the actual enforcement
  point for an expired QR.
