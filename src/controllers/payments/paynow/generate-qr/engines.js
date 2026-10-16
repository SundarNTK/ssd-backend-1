/**
 * The two ways to turn "merchant details + amount + reference" into a PayNow
 * QR image. Nothing here decides WHICH one runs or whether the details are
 * real — that is the provider's job (../provider), so this file can be used
 * by the live provider (real merchant values) and the mock provider (fake,
 * non-payable values) alike.
 *
 *   jar    — shells out to DBS's PayQRSDK.jar (a thin command-line wrapper
 *            around DBS's own com.dbs.sgqr.generator library). Needs a JRE
 *            and the jar under public/Paynowsdk/dist.
 *   native — builds the same payload in JS (build-payload.js) and draws it
 *            with the `qrcode` package. No Java. Its text output has been
 *            compared with the jar's, field by field and checksum included
 *            (see __tests__/jar-parity.test.js).
 */
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { execFile } = require("child_process");
const qrcode = require("qrcode");
const { findJavaExecutable } = require("./find-java");
const { buildPaynowQrPayload } = require("./build-payload");

/** YYYYMMDDHHmmss, in local time — matches the format the QR SDK expects. */
function formatSdkDateTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function runQrJar(javaPath, args) {
  const jarFilePath = path.join(__dirname, "../../../../../public/Paynowsdk/dist/");
  const jarPath = path.join(jarFilePath, "PayQRSDK.jar");

  if (!fs.existsSync(jarPath)) {
    throw "PayQRSDK.jar not found in public/Paynowsdk/dist/ — see docs/paynow-integration.md.";
  }

  return new Promise((resolve, reject) => {
    execFile(
      javaPath,
      ["-jar", jarPath, ...args],
      {
        cwd: jarFilePath,
        env: { ...process.env, PATH: process.env.PATH || process.env.Path || "" },
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`PayNow QR generation failed: ${stderr || error.message}`));
        const base64Image = stdout.trim();
        if (!base64Image) return reject(new Error("No output received from the PayNow QR generator."));
        resolve(base64Image);
      }
    );
  });
}

/**
 * @param {string} referenceId
 * @param {number} amount
 * @param {object} config  the merchant details, in config/env.js's PAYNOW_* names
 */
async function generateViaJar(referenceId, amount, config) {
  const javaPath = await findJavaExecutable();

  const id = crypto.randomUUID();
  const paynowBrandImagePath = path.join(__dirname, "../../../../../public/Paynowsdk/PayNow.png");
  const filename = `qr-${id}.png`;
  const expiryDate = formatSdkDateTime(new Date(Date.now() + (config.PAYNOW_PROXY_EXPIRY_DAYS || 365) * 24 * 60 * 60 * 1000));

  const args = [
    config.PAYNOW_MERCHANT_CATEGORY_CODE,
    config.PAYNOW_TXN_CURRENCY,
    config.PAYNOW_COUNTRY_CODE,
    config.PAYNOW_MERCHANT_NAME,
    config.PAYNOW_MERCHANT_CITY,
    config.PAYNOW_GLOBAL_UNIQUE_ID,
    config.PAYNOW_PROXY_TYPE,
    config.PAYNOW_PROXY_VALUE,
    config.PAYNOW_EDITABLE_AMOUNT,
    expiryDate,
    config.PAYNOW_POINT_OF_INITIATION,
    amount.toFixed(2),
    referenceId,
    config.PAYNOW_QR_COLOR_CODE,
    paynowBrandImagePath,
    filename,
    "/t",
  ];

  const base64Image = await runQrJar(javaPath, args);
  return `data:image/png;base64,${base64Image}`;
}

/** The QR text (not the image) for the native engine. Exported so tests can compare it with the jar's. */
function buildNativePayload(referenceId, amount, config) {
  return buildPaynowQrPayload({
    merchantCategoryCode: config.PAYNOW_MERCHANT_CATEGORY_CODE,
    currency: config.PAYNOW_TXN_CURRENCY,
    countryCode: config.PAYNOW_COUNTRY_CODE,
    merchantName: config.PAYNOW_MERCHANT_NAME,
    merchantCity: config.PAYNOW_MERCHANT_CITY,
    globalUniqueId: config.PAYNOW_GLOBAL_UNIQUE_ID,
    proxyType: config.PAYNOW_PROXY_TYPE,
    proxyValue: config.PAYNOW_PROXY_VALUE,
    editableAmount: config.PAYNOW_EDITABLE_AMOUNT,
    pointOfInitiation: config.PAYNOW_POINT_OF_INITIATION,
    payloadFormatIndicator: config.PAYNOW_PAYLOAD_FORMAT_INDICATOR,
    expiryFormat: config.PAYNOW_PROXY_EXPIRY_FORMAT,
    expiryDays: config.PAYNOW_PROXY_EXPIRY_DAYS,
    amount,
    referenceId,
  });
}

async function generateViaNative(referenceId, amount, config) {
  const payload = buildNativePayload(referenceId, amount, config);
  return qrcode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 2 });
}

module.exports = { generateViaJar, generateViaNative, buildNativePayload, runQrJar, formatSdkDateTime };
