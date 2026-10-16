const openpgp = require("openpgp");
const fs = require("fs");
const { resolveKeyPaths } = require("../keys");

/**
 * Decrypts + verifies one DBS PayNow ICN (Instant Credit Notification)
 * message — the same OpenPGP decrypt/verify HEB's Payment-Service does
 * (D:\PROJECTS\HEB\Payment-Service\source\controllers\paynow\icn-response\decrypt-resposne.js),
 * just taking the armored text directly (already read off the live
 * request) instead of reading it from a file first.
 *
 * @param {string} armoredMessage  the raw "-----BEGIN PGP MESSAGE-----...” text
 * @returns {Promise<string>} the decrypted JSON string
 * @throws {string} when the message is unsigned or its signature does not verify
 */
async function decryptIcnResponse(armoredMessage) {
  const { publicKeyPath, privateKeyPath } = resolveKeyPaths();

  if (!fs.existsSync(publicKeyPath) || !fs.existsSync(privateKeyPath)) {
    throw `PayNow DBS key material not found (expected at ${publicKeyPath} / ${privateKeyPath}) — see docs/paynow-integration.md.`;
  }

  const publicKeyFile = fs.readFileSync(publicKeyPath, "utf8");
  const privateKeyFile = fs.readFileSync(privateKeyPath, "utf8");

  const publicKey = await openpgp.readKey({ armoredKey: publicKeyFile });
  const privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyFile });
  const message = await openpgp.readMessage({ armoredMessage });

  const { data: decrypted, signatures } = await openpgp.decrypt({
    message,
    verificationKeys: publicKey,
    decryptionKeys: privateKey,
  });

  // openpgp.decrypt() does NOT fail on a bad or missing signature — it only
  // reports it through `signatures[].verified`, which must be awaited.
  // Decrypting needs nothing but OUR public key, which is not secret, so
  // without this check anyone could encrypt a forged "payment received"
  // message and have it accepted. The message must carry a signature that
  // verifies against DBS's public key.
  if (!Array.isArray(signatures) || signatures.length === 0) {
    throw "PayNow ICN rejected: the message is not signed.";
  }
  try {
    await Promise.any(signatures.map((signature) => signature.verified));
  } catch {
    throw "PayNow ICN rejected: the signature could not be verified against DBS's public key.";
  }

  return decrypted;
}

module.exports = decryptIcnResponse;
