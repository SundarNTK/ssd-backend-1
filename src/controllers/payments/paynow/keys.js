/**
 * Where the PayNow PGP key files live. Shared by the ICN decoder
 * (icn-response/decrypt-response.js) and the startup check
 * (config-validation.js) so both look in exactly the same place.
 *
 *   PAYNOW_PUBLIC_KEY_PATH  → DBS's public key; used to VERIFY their signature
 *   PAYNOW_PRIVATE_KEY_PATH → the temple's private key; used to DECRYPT
 *
 * The files are never committed (see .gitignore) and the production ones
 * belong in a protected folder on the server, mounted into the container.
 */
const path = require("path");
const env = require("../../../config/env");

const resolveKeyPath = (configured) => (path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured));

function resolveKeyPaths() {
  return {
    publicKeyPath: resolveKeyPath(env.PAYNOW_PUBLIC_KEY_PATH),
    privateKeyPath: resolveKeyPath(env.PAYNOW_PRIVATE_KEY_PATH),
  };
}

module.exports = { resolveKeyPaths };
