const { verifySessionToken } = require("../utils/jwt");
const { exceptionHandler } = require("../../utilities/handlers");
const { User } = require("../../models/users");
const mergeRolePermissions = require("../../utilities/helpers/merge-role-permissions");
const isCustomerProfileInactive = require("../../utilities/helpers/is-customer-profile-inactive");

/**
 * Verifies the JWT, then re-reads the account from the database.
 *
 * Account state stays live: deactivating a user, or their access period
 * ending, locks them out on the next request.
 *
 * Module permissions stay as they were at login. The token carries that
 * snapshot, and both the side menu and the route checks use it. Unticking a
 * module leaves the open session unchanged; the menu and the page update
 * together the next time that user signs in. A token minted before this
 * claim existed falls back to the live role grants.
 */
async function authGuard(req, res, next) {
  let payload;
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) throw new Error("missing token");
    payload = verifySessionToken(token);
  } catch {
    return exceptionHandler({
      res,
      error: "Session expired or invalid — please sign in again.",
      statusCode: 401,
    });
  }

  try {
    const user = await User.findOne(User.notDeletedFilter({ _id: payload.sub })).populate({
      path: "entities.roles",
      match: { isDeleted: false, status: 1 },
      select: "name permissions",
    });

    // Covers deleted, deactivated, and access-period-expired accounts in one
    // check — same rule login uses, applied continuously instead of once.
    if (!user || !user.isAccountUsable() || (await isCustomerProfileInactive(user))) {
      return exceptionHandler({
        res,
        error: "This account is no longer active. Please contact an administrator.",
        statusCode: 401,
      });
    }

    const assignment = user.getDefaultEntityAssignment();
    const roles = (assignment?.roles || []).filter(Boolean);

    req.auth = {
      userId: String(user._id),
      userType: user.userType,
      entityId: assignment ? String(assignment.entity) : null,
      roles: roles.map((r) => String(r._id)),
      permissions:
        payload.permissions && typeof payload.permissions === "object"
          ? payload.permissions
          : mergeRolePermissions(roles),
      user,
    };

    return next();
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

module.exports = authGuard;
