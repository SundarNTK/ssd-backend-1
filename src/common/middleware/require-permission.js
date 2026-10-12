const { exceptionHandler } = require("../../utilities/handlers");
const { USER_TYPES } = require("../../utilities/constants/user-types");

/**
 * Gates a route on a specific module + level (view/edit/fullAccess).
 *
 * Reads `req.auth.permissions`, the grant snapshot taken at login and
 * carried on the token. A role change applies when that user signs in
 * again, so the menu and these checks stay in step for the whole session.
 *
 * SUPER_ADMIN bypasses this entirely, same as everywhere else in the app.
 * Mount it after authGuard and adminOnly.
 */
function requirePermission(module, level = "view") {
  const guard = (req, res, next) => {
    if (req.auth?.userType === USER_TYPES.SUPER_ADMIN) return next();

    if (req.auth?.permissions?.[module]?.[level]) return next();

    return exceptionHandler({
      res,
      error: `You don't have ${level} access to ${module}.`,
      statusCode: 403,
    });
  };

  // An arrow function assigned to a const is named "guard", which tells you
  // nothing when you walk the router stack to audit what protects what.
  // Naming it after the grant it enforces makes the route table
  // self-documenting: every route states the permission it requires.
  Object.defineProperty(guard, "name", { value: `requirePermission:${module}:${level}` });
  return guard;
}

/**
 * Same check, passing when ANY of the listed modules grants the level - for lookups that more
 * than one screen reads (e.g. the halls list feeds both the Hall master and the Hall Booking form).
 */
requirePermission.any = function requireAnyPermission(modules, level = "view") {
  const guard = (req, res, next) => {
    if (req.auth?.userType === USER_TYPES.SUPER_ADMIN) return next();
    if (modules.some((m) => req.auth?.permissions?.[m]?.[level])) return next();
    return exceptionHandler({
      res,
      error: `You don't have ${level} access to ${modules.join(" / ")}.`,
      statusCode: 403,
    });
  };
  Object.defineProperty(guard, "name", { value: `requirePermission.any:${modules.join("|")}:${level}` });
  return guard;
};

module.exports = requirePermission;
