const env = require("../../../config/env");
const { User } = require("../../../models/users");
const { generateRawToken, hashToken } = require("../../../common/utils/token");
const { USER_TYPES } = require("../../constants/user-types");
const sendTemplatedEmail = require("../send-templated-email");
const findActiveEntityByCode = require("../find-active-entity-by-code");

/**
 * Sends an account that never got its password set a fresh activation email.
 *
 * A new single-use link replaces the old one (the old link stops working - there is only one token per account), and
 * like the first one it never times out. If the email cannot be sent, the previous link is put back so the person
 * is not left with a dead one.
 *
 * Devotee accounts get the customer-portal link, staff accounts the admin one - the same split the first email uses.
 * Throws a plain message when there is nothing to resend.
 *
 * @param {import("mongoose").Document} user a User document
 * @returns {Promise<{ email: string, dryRun: boolean }>}
 */
async function resendActivation(user) {
  if (!user) throw "Account not found.";
  if (user.passwordSetAt) {
    throw "This account has already set its password. If they cannot sign in, ask them to use Forgot password.";
  }
  if (user.status !== 1) throw "This account is inactive. Make it active first, then resend the activation email.";

  const entity = await findActiveEntityByCode(env.DEFAULT_ENTITY_CODE);
  const entityId = user.getDefaultEntityAssignment?.()?.entity || entity?._id;
  if (!entityId) throw "No active entity is configured.";

  const previous = await User.findById(user._id).select("+activationTokenHash activationTokenExpiresAt");
  const rawToken = generateRawToken();
  await User.updateOne({ _id: user._id }, { $set: { activationTokenHash: hashToken(rawToken), activationTokenExpiresAt: null } });

  const isCustomer = user.userType === USER_TYPES.CUSTOMER;
  const activationUrl = `${isCustomer ? env.CUSTOMER_APP_URL : env.ADMIN_APP_URL}${isCustomer ? "/customer" : "/admin"}/activate/${rawToken}`;
  try {
    const result = await sendTemplatedEmail("ACCOUNT_ACTIVATION", entityId, user.email, { name: user.name, activationUrl });
    return { email: user.email, dryRun: Boolean(result?.dryRun) };
  } catch (err) {
    await User.updateOne(
      { _id: user._id },
      { $set: { activationTokenHash: previous?.activationTokenHash ?? null, activationTokenExpiresAt: previous?.activationTokenExpiresAt ?? null } }
    ).catch(() => {});
    throw err;
  }
}

module.exports = resendActivation;
