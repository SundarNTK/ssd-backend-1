/**
 * POST /payments/paynow/icn-response
 *
 * DBS's PayNow Instant Credit Notification (ICN) webhook — the actual
 * "this PayNow payment succeeded" signal, arriving asynchronously and
 * completely separately from QR generation (../generate-qr). Modeled on
 * HEB's own Payment-Service handler
 * (D:\PROJECTS\HEB\Payment-Service\source\controllers\paynow\icn-response),
 * with one deliberate difference: HEB's current code reads a local sample
 * file instead of the live request body (a leftover from testing) — this
 * reads the real incoming request, since that's the whole point of a
 * webhook.
 *
 * Mounted unauthenticated (see controllers/payments/index.js) — DBS calls
 * this directly, it never carries this app's own auth token. What stands in
 * for auth is the PGP layer (decrypt-response.js): the message must be
 * encrypted to our key AND signed by DBS. Only then is it parsed
 * (parse-icn.js) and matched to the pending payment (process-icn.js).
 *
 * Only runs when PayNow is switched on (PAYNOW_MODE, ../mode.js). On a
 * server where it is off the route answers with an error and decrypts
 * nothing.
 *
 * `customerReference` in the decrypted payload is exactly the `referenceId`
 * generate-qr embedded in the QR as the bill reference — that's the field
 * the shared confirmation dispatcher (controllers/payments/dispatch) uses
 * to route this settlement back to the right origin module (POS today).
 * Idempotency (a duplicate ICN for an already-settled reference) is handled
 * inside that dispatch target, not here — see controllers/pos-orders'
 * confirmPosPayment().
 */

const { responseHandler, exceptionHandler } = require("../../../../utilities/handlers");
const { getPaynowMode } = require("../mode");
const decryptIcnResponse = require("./decrypt-response");
const { processDecryptedIcn } = require("./process-icn");

/**
 * DBS's exact request shape for this webhook isn't confirmed yet (no API
 * doc on file — see docs/paynow-integration.md's ask-list) — HEB's own
 * source suggests a JSON body with the armored PGP text under a `data`
 * field (`req.body.data`), but a PGP message is also commonly posted as
 * raw text/plain. This accepts either shape rather than assuming one:
 *   - `{ "data": "-----BEGIN PGP MESSAGE-----..." }` (parsed JSON body)
 *   - the raw armored text as the entire body (string)
 *   - a JSON-shaped STRING body (e.g. if this route's body parser is
 *     configured as text/plain but DBS still sends JSON) containing `data`
 */
function extractArmoredMessage(req) {
  const body = req.body;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed?.data === "string") return parsed.data;
      } catch {
        // not JSON after all — fall through and treat it as the armored text itself
      }
    }
    return trimmed || null;
  }
  if (body && typeof body === "object" && typeof body.data === "string") {
    return body.data;
  }
  return null;
}

async function icnResponse(req, res) {
  try {
    if (getPaynowMode() === "disabled") {
      return exceptionHandler({ res, error: "PayNow is not enabled on this server.", statusCode: 503 });
    }

    const armoredMessage = extractArmoredMessage(req);
    if (!armoredMessage) throw "No PayNow ICN payload found in the request.";

    // Decrypts AND requires a valid DBS signature — throws otherwise.
    const decryptedJson = await decryptIcnResponse(armoredMessage);

    const result = await processDecryptedIcn(decryptedJson, { source: "dbs" });

    if (result.status === "pending") {
      return responseHandler({
        res,
        response: result,
        successMessage: "ICN received — transaction not yet completed.",
      });
    }
    return responseHandler({
      res,
      response: result,
      successMessage: result.alreadyProcessed ? "ICN received — already processed." : "Payment confirmed from PayNow ICN.",
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

module.exports = icnResponse;
module.exports.extractArmoredMessage = extractArmoredMessage;
