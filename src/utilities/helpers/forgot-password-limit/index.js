/**
 * Forgot password: at most FORGOT_PASSWORD_MAX_PER_HOUR (default 3) reset emails per email address per hour, so the
 * form cannot be used to flood someone's inbox. Counted per ADDRESS (not per network), so many people on one internet
 * connection never affect each other. Requests are kept in the password_reset_requests collection, which deletes its
 * own rows after a day, so the limit holds across restarts.
 */
const mongoose = require("mongoose");
const env = require("../../../config/env");
const { EmailDeliveryError } = require("../../../common/mailer/transport");

const requestSchema = new mongoose.Schema({ email: { type: String, required: true }, at: { type: Date, default: Date.now } }, { versionKey: false });
requestSchema.index({ email: 1, at: -1 });
requestSchema.index({ at: 1 }, { expireAfterSeconds: 24 * 60 * 60 });
const PasswordResetRequest = mongoose.models.PasswordResetRequest || mongoose.model("PasswordResetRequest", requestSchema, "password_reset_requests");

const HOUR_MS = 60 * 60 * 1000;

/** Throws a 429 (plain message, safe to show) when this address already had its reset emails for the hour. */
async function assertResetAllowed(email, now = Date.now()) {
  const count = await PasswordResetRequest.countDocuments({ email: String(email).trim().toLowerCase(), at: { $gte: new Date(now - HOUR_MS) } });
  if (count >= env.FORGOT_PASSWORD_MAX_PER_HOUR) {
    throw new EmailDeliveryError(
      `A password reset link was already sent to this account ${env.FORGOT_PASSWORD_MAX_PER_HOUR} times in the last hour. Please check your email (and spam folder), or try again in an hour.`,
      { status: 429 }
    );
  }
}

/** Counts one reset email (call it once the email has been sent). */
async function recordResetRequest(email) {
  await PasswordResetRequest.create({ email: String(email).trim().toLowerCase() }).catch((err) =>
    console.warn(">>> forgot-password: could not record the request:", err.message)
  );
}

module.exports = { assertResetAllowed, recordResetRequest, PasswordResetRequest };
