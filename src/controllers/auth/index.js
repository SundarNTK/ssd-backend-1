const express = require("express");
const env = require("../../config/env");
const validateBody = require("../../common/middleware/validate");
const authGuard = require("../../common/middleware/auth-guard");
const { responseHandler, exceptionHandler } = require("../../utilities/handlers");
const { hashPassword, comparePassword, assertStrongPassword } = require("../../common/utils/password");
const { signSessionToken } = require("../../common/utils/jwt");
const { generateRawToken, hashToken, addMinutes } = require("../../common/utils/token");
const sendTemplatedEmail = require("../../utilities/helpers/send-templated-email");
const findActiveEntityByCode = require("../../utilities/helpers/find-active-entity-by-code");
const resolveMergedPermissions = require("../../utilities/helpers/resolve-merged-permissions");
const isCustomerProfileInactive = require("../../utilities/helpers/is-customer-profile-inactive");
const findActiveRoleByName = require("../../utilities/helpers/find-active-role-by-name");
const findActiveUserByEmail = require("../../utilities/helpers/find-active-user-by-email");
const findActiveUserByEmailOrMobile = require("../../utilities/helpers/find-active-user-by-email-or-mobile");
const findUserByActivationToken = require("../../utilities/helpers/find-user-by-activation-token");
const findUserByResetToken = require("../../utilities/helpers/find-user-by-reset-token");
const createPendingUser = require("../../utilities/helpers/create-pending-user");
const createCustomerProfile = require("../../utilities/helpers/create-customer-profile");
const isUserMobileTaken = require("../../utilities/helpers/is-user-mobile-taken");
const { Customer } = require("../../models/customers");
const rollbackCreatedUser = require("../../utilities/helpers/rollback-created-user");
const { User } = require("../../models/users");
const { USER_TYPES, isAdminPanelType } = require("../../utilities/constants/user-types");
const {
  loginSchema,
  activateSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  registerSchema,
  paginationCountSchema,
} = require("./request-objects");

async function login(req, res) {
  try {
    const { email, password } = req.body;

    const user = await findActiveUserByEmail(email);
    // Same message whether the email doesn't exist or the password is wrong —
    // never reveal which one it was. A *deactivated* or *access-expired*
    // account is a different situation on purpose: the person typed their
    // real password correctly and still can't get in, so "invalid password"
    // would be actively misleading rather than just unhelpful. Telling them
    // to contact an admin does mean the response now reveals the email
    // belongs to a real account — an accepted trade-off for an internal
    // staff/devotee system, not a public one.
    const genericError = "Invalid email or password.";

    if (!user) throw genericError;

    if (user.status !== 1) {
      throw "This account has been deactivated. Please contact your temple administrator.";
    }
    if (user.accessUpto && user.accessUpto.getTime() < Date.now()) {
      throw "Your access to this account has expired. Please contact your temple administrator.";
    }
    if (await isCustomerProfileInactive(user)) {
      throw "This account has been deactivated. Please contact your temple administrator.";
    }

    if (!user.passwordHash) {
      throw "This account hasn't set a password yet — please use the activation link sent to your email.";
    }

    const passwordMatches = await comparePassword(password, user.passwordHash);
    if (!passwordMatches) throw genericError;

    // Portal rules (checked after the password so they never reveal whether an email exists): staff may use
    // the Customer portal, a Customer may not use Admin or POS, and POS also needs the per-user POS access flag
    // (System Admin is never gated by it).
    const { portal } = req.body;
    if ((portal === "admin" || portal === "pos") && !isAdminPanelType(user.userType)) {
      throw portal === "pos" ? "This account doesn't have POS access." : "This account doesn't have Admin Panel access.";
    }
    if (portal === "pos" && user.userType !== USER_TYPES.SUPER_ADMIN && !user.posAccess) {
      throw "This account doesn't have POS access. Contact your administrator to enable it.";
    }

    user.lastLoginAt = new Date();
    await user.save();

    const defaultAssignment = user.getDefaultEntityAssignment();
    const permissions = await resolveMergedPermissions(defaultAssignment?.roles || []);
    const token = signSessionToken(user, permissions);

    // `permissions` goes back to the client so the Admin Panel can hide nav
    // and buttons the account can't use. It is a rendering hint only — every
    // route re-derives it server-side per request (auth-guard.js), so a
    // tampered copy in localStorage buys nothing but a broken-looking menu.
    return responseHandler({
      res,
      successMessage: "Signed in successfully.",
      response: { token, user: { ...user.toSessionUser(), permissions } },
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 401 : 500 });
  }
}

/**
 * Public — anyone can call this, so it only ever creates a CUSTOMER
 * account. Admin/System Admin accounts are never self-registered; those
 * come from an existing admin using the User Master, which reuses the same
 * createPendingUser() / createCustomerProfile() helpers this calls, just
 * with a different (permission-checked) caller and userType.
 *
 * Creates both records: the User (login identity) and the linked Customer
 * (booking profile — FSD §3.12's fields). If the Customer half fails after
 * the User was already created, the User is rolled back rather than left
 * as a login with no profile behind it.
 */
async function register(req, res) {
  let createdUser = null;
  // Set when this registration claims a walk-in profile, so a failure can put the profile back as it was.
  let claimed = null;
  let claimedBefore = null;
  try {
    const { name, email, mobileNumber, familyMembers } = req.body;

    const entity = await findActiveEntityByCode(env.DEFAULT_ENTITY_CODE);
    if (!entity) throw "Registration isn't available right now — no active entity is configured.";

    // A profile may already exist on this mobile: a walk-in added at the temple counter (maybe with no email). That
    // one is CLAIMED - the person keeps their customer code, family members and booking history - instead of getting
    // a second profile. A mobile that already belongs to a registered account is refused.
    const profile = await Customer.findOne(Customer.notDeletedFilter({ mobileNumber }));
    if (profile && (profile.isRegistered || profile.linkedUserId)) {
      throw "An account with this mobile number already exists. Please sign in.";
    }
    if (profile) {
      const emailOnOtherProfile = await Customer.exists(Customer.notDeletedFilter({ email: String(email).trim().toLowerCase(), _id: { $ne: profile._id } }));
      if (emailOnOtherProfile) throw "An account with this email already exists.";
    }

    const customerRole = await findActiveRoleByName("Customer");

    const { user, rawToken } = await createPendingUser({
      name,
      email,
      mobileNumber,
      userType: USER_TYPES.CUSTOMER,
      entityId: entity._id,
      roleIds: customerRole ? [customerRole._id] : [],
    });
    createdUser = user;

    if (profile) {
      claimedBefore = { name: profile.name, email: profile.email, linkedUserId: profile.linkedUserId, isRegistered: profile.isRegistered };
      claimed = profile;
      profile.name = name;
      profile.email = String(email).trim().toLowerCase();
      profile.linkedUserId = user._id;
      profile.isRegistered = true;
      // Family members typed at registration only fill a profile that has none yet (the cap is not exceeded).
      if (profile.familyMembers.length === 0 && familyMembers?.length) profile.familyMembers = familyMembers;
      await profile.save();
    } else {
      await createCustomerProfile({
        entityId: entity._id,
        linkedUserId: user._id,
        name,
        mobileNumber,
        email,
        familyMembers,
      });
    }

    // This endpoint only ever creates CUSTOMER accounts (see comment above), so the
    // activation link must send the devotee to the customer portal, never /admin.
    const activationUrl = `${env.CUSTOMER_APP_URL}/customer/activate/${rawToken}`;
    await sendTemplatedEmail("ACCOUNT_ACTIVATION", entity._id, user.email, {
      name: user.name,
      activationUrl,
    });

    return responseHandler({
      res,
      successMessage: "Registration received — check your email to set your password and finish signing in.",
      statusCode: 201,
    });
  } catch (error) {
    // Put a claimed counter profile back as it was FIRST: the rollback below deletes the profile linked to the login
    // it is undoing, and a counter profile must never be lost to a failed registration.
    if (claimed && claimedBefore) {
      Object.assign(claimed, claimedBefore);
      await claimed.save().catch(() => {});
    }
    if (createdUser) await rollbackCreatedUser(createdUser._id);
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * Public - GET /auth/register/check?mobileNumber=
 * Tells the Register form what it is dealing with, so it can adapt before submit:
 *   new        nothing on this mobile - a normal registration
 *   walkin     a profile added at the temple counter (maybe with no email): only name and email are asked, the
 *              mobile is fixed, and registering claims that profile
 *   registered an account already exists on this mobile - sign in instead
 * Returns the status only, never the profile's details.
 */
async function registerCheck(req, res) {
  try {
    const mobileNumber = String(req.query.mobileNumber || "").trim();
    if (mobileNumber.length < 6) return responseHandler({ res, response: { status: "new" } });

    const [profile, userTaken] = await Promise.all([
      Customer.findOne(Customer.notDeletedFilter({ mobileNumber })).select("isRegistered linkedUserId"),
      isUserMobileTaken(mobileNumber),
    ]);
    const registered = userTaken || (profile && (profile.isRegistered || profile.linkedUserId));
    return responseHandler({ res, response: { status: registered ? "registered" : profile ? "walkin" : "new" } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

const TOKEN_INFO_ERRORS = {
  invalid: "This link is invalid or has already been used.",
  expired: "This link has expired. Please request a new one.",
};

/**
 * Read-only — lets the Set-Password page greet the person by name and,
 * more importantly, feed their real name/email/mobile into the client-side
 * password-strength check *before* they submit. Without this, the client
 * has no way to know what the server will reject, so a password like
 * "Sundar@SSD123" can show "Excellent" on screen and still bounce at
 * submit time — confusing, and avoidable.
 */
async function activationTokenInfo(req, res) {
  try {
    const { user, reason } = await findUserByActivationToken(req.params.token);
    if (!user) throw TOKEN_INFO_ERRORS[reason];
    if (user.passwordSetAt) throw "Password already created. Please log in instead.";

    return responseHandler({
      res,
      response: { name: user.name, email: user.email, mobileNumber: user.mobileNumber },
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: 404 });
  }
}

async function resetTokenInfo(req, res) {
  try {
    const { user, reason } = await findUserByResetToken(req.params.token);
    if (!user) throw TOKEN_INFO_ERRORS[reason];

    return responseHandler({
      res,
      response: { name: user.name, email: user.email, mobileNumber: user.mobileNumber },
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: 404 });
  }
}

async function activate(req, res) {
  try {
    const { token, newPassword } = req.body;
    const { user, reason } = await findUserByActivationToken(token);

    if (!user) throw TOKEN_INFO_ERRORS[reason];
    if (user.passwordSetAt) throw "Password already created. Please log in instead.";

    assertStrongPassword(newPassword, [user.name, user.email, user.mobileNumber]);

    user.passwordHash = await hashPassword(newPassword);
    user.passwordSetAt = new Date();
    user.activationTokenHash = null;
    user.activationTokenExpiresAt = null;
    await user.save();

    return responseHandler({ res, successMessage: "Password created successfully. You can now sign in." });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

async function forgotPassword(req, res) {
  try {
    const { identifier } = req.body;
    const user = await findActiveUserByEmailOrMobile(identifier);

    if (!user) {
      return exceptionHandler({
        res,
        error: "No account is registered with this email or mobile number.",
        statusCode: 404,
      });
    }
    if (user.status !== 1) {
      throw "This account has been deactivated. Please contact your temple administrator.";
    }
    if (user.accessUpto && user.accessUpto.getTime() < Date.now()) {
      throw "Your access to this account has expired. Please contact your temple administrator.";
    }
    if (await isCustomerProfileInactive(user)) {
      throw "This account has been deactivated. Please contact your temple administrator.";
    }

    const rawToken = generateRawToken();
    user.passwordResetTokenHash = hashToken(rawToken);
    user.passwordResetTokenExpiresAt = addMinutes(new Date(), env.RESET_TOKEN_TTL_MINUTES);
    await user.save();

    // Shared by staff and devotee accounts alike — route each to their own
    // portal's reset screen so a customer never lands on the staff admin login.
    const isCustomer = user.userType === USER_TYPES.CUSTOMER;
    const resetPathPrefix = isCustomer ? "/customer" : "/admin";
    const portalOrigin = isCustomer ? env.CUSTOMER_APP_URL : env.ADMIN_APP_URL;
    const resetUrl = `${portalOrigin}${resetPathPrefix}/reset-password/${rawToken}`;
    const defaultAssignment = user.getDefaultEntityAssignment();
    await sendTemplatedEmail("PASSWORD_RESET", defaultAssignment?.entity, user.email, {
      name: user.name,
      resetUrl,
      expiresInMinutes: env.RESET_TOKEN_TTL_MINUTES,
    });

    return responseHandler({
      res,
      successMessage: "A reset link has been sent to the registered email.",
    });
  } catch (error) {
    return exceptionHandler({
      res,
      error,
      statusCode: typeof error === "string" ? 403 : undefined,
    });
  }
}

async function resetPassword(req, res) {
  try {
    const { token, newPassword } = req.body;
    const { user, reason } = await findUserByResetToken(token);

    if (!user) throw TOKEN_INFO_ERRORS[reason];

    assertStrongPassword(newPassword, [user.name, user.email, user.mobileNumber]);

    user.passwordHash = await hashPassword(newPassword);
    user.passwordResetTokenHash = null;
    user.passwordResetTokenExpiresAt = null;
    await user.save();

    return responseHandler({ res, successMessage: "Password reset successfully. You can now sign in." });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * Saves the caller's own "rows per page" choice for every Master list screen
 * (Item Master, Service Master, Deity Master, ...) — a self-service update,
 * not a User Master admin action, so it's scoped to req.auth.userId (the
 * caller's own account) rather than taking an :id param. Rides home on the
 * session user (toSessionUser(), see models/users) so it's already there on
 * every future login, on any device — not just remembered in this browser.
 */
async function updatePaginationCount(req, res) {
  try {
    const user = await User.findOneAndUpdate(
      User.notDeletedFilter({ _id: req.auth.userId }),
      { paginationCount: req.body.paginationCount },
      { new: true, runValidators: true }
    );
    if (!user) throw "Account not found.";
    return responseHandler({
      res,
      response: { paginationCount: user.paginationCount },
      successMessage: "Preference saved.",
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 404 : undefined });
  }
}

// Mounted at /auth — see routes/index.js for why the prefix lives there.
const router = express.Router();

router.post("/login", validateBody(loginSchema), login);
router.post("/register", validateBody(registerSchema), register);
router.get("/register/check", registerCheck);

// Read-only — let Set-Password/Reset-Password greet the person by name and
// check password strength against their real name/email/mobile *before*
// they submit, instead of only finding out at the end.
router.get("/activation/:token", activationTokenInfo);
router.get("/reset-password/:token", resetTokenInfo);

router.post("/activate", validateBody(activateSchema), activate);
router.post("/forgot-password", validateBody(forgotPasswordSchema), forgotPassword);
router.post("/reset-password", validateBody(resetPasswordSchema), resetPassword);

router.put("/pagination-count", authGuard, validateBody(paginationCountSchema), updatePaginationCount);

module.exports = router;
