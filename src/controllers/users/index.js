const express = require("express");
const env = require("../../config/env");
const authGuard = require("../../common/middleware/auth-guard");
const adminOnly = require("../../common/middleware/admin-only");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { uploadAvatar } = require("../../common/middleware/upload");
const { responseHandler, exceptionHandler, queryHandler } = require("../../utilities/handlers");
const { isSuperAdmin, assertGrantableRoles, canGrantRole } = require("../../common/utils/escalation");
const { USER_TYPES } = require("../../utilities/constants/user-types");

const { User } = require("../../models/users");
const findActiveEntityByCode = require("../../utilities/helpers/find-active-entity-by-code");
const findActiveRolesByIds = require("../../utilities/helpers/find-active-roles-by-ids");
const findAllActiveRoles = require("../../utilities/helpers/find-all-active-roles");
const ensureCustomerProfileForUser = require("../../utilities/helpers/ensure-customer-profile-for-user");
const rollbackCreatedUser = require("../../utilities/helpers/rollback-created-user");
const sendTemplatedEmail = require("../../utilities/helpers/send-templated-email");
const createPendingUser = require("../../utilities/helpers/create-pending-user");
const resendActivation = require("../../utilities/helpers/resend-activation");
const isUserEmailTaken = require("../../utilities/helpers/is-user-email-taken");
const isUserMobileTaken = require("../../utilities/helpers/is-user-mobile-taken");
const { createSchema, updateSchema } = require("./request-objects");

/**
 * Resolves the requested role ids to real, active role documents and
 * refuses the request if any of them would hand the actor more access than
 * they hold. Returns the documents so callers don't look them up twice.
 *
 * The existence check matters on its own: without it a typo'd or
 * soft-deleted ObjectId is stored happily and the account silently ends up
 * with fewer permissions than the admin believes they granted.
 */
async function resolveAssignableRoles(req, roleIds = []) {
  if (!roleIds.length) return [];

  const roles = await findActiveRolesByIds(roleIds);
  if (roles.length !== roleIds.length) {
    throw "One or more of the selected roles no longer exists or is inactive.";
  }

  assertGrantableRoles(req, roles);
  return roles;
}

/** Only a System Admin may create, modify, or otherwise act on a System Admin. */
function assertMaySuperAdmin(req, action) {
  if (!isSuperAdmin(req)) {
    throw `Only a System Admin can ${action} a System Admin account.`;
  }
}

/**
 * The role picker for the user form — names only, and only the roles this
 * particular admin could actually hand out.
 *
 * This exists because "create an admin user" genuinely needs to read role
 * names, while `roles:view` governs something different: the Roles master,
 * where permissions are inspected and edited. Requiring the second to do
 * the first would mean nobody could assign a role without also being able
 * to rewrite the permission system — the opposite of least privilege, and
 * the reason this endpoint is gated on `users:edit` instead.
 *
 * Two deliberate narrowings keep that from becoming a hole:
 *   - only `_id` and `name` are returned, never the `permissions` array, so
 *     this doesn't become a back door onto the data `roles:view` protects;
 *   - the list is filtered to roles the caller could grant without
 *     escalating (canGrantRole), so the picker never offers a choice that
 *     POST /users would then refuse.
 */
async function assignableRoles(req, res) {
  try {
    const roles = await findAllActiveRoles();
    const assignable = roles
      .filter((role) => !role.isLocked && canGrantRole(req, role))
      .map((role) => ({ _id: role._id, name: role.name }));

    return responseHandler({ res, response: assignable });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * Every account regardless of userType shows up here — an admin needs to
 * see (and deactivate) Customer accounts too, even though this screen can
 * never *create* one. passwordHash never leaks: it's `select: false` on
 * the schema, so it's excluded unless a query explicitly asks for it.
 */
async function list(req, res) {
  try {
    const { page, pageSize, skip, filter, sort } = queryHandler(req, {
      notDeletedFilter: User.notDeletedFilter,
      searchFields: ["name", "email", "mobileNumber", "uCode"],
    });
    if (req.query.userType) filter.userType = req.query.userType;
    else if (req.query.excludeUserType) filter.userType = { $ne: req.query.excludeUserType };
    if (req.query.role) filter["entities.roles"] = req.query.role;

    const [items, total] = await Promise.all([
      User.find(filter)
        .populate("entities.roles", "name")
        .populate("familyMembers.natchathiram", "name tamilName")
        .sort(sort)
        .skip(skip)
        .limit(pageSize),
      User.countDocuments(filter),
    ]);

    return responseHandler({ res, response: { items, total, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * Creates an Admin_Users account, always. The account type is set here and
 * cannot be supplied by the request — see request-objects.js for why there
 * is no `userType` field on the schema at all.
 *
 * SUPER_ADMIN is therefore unreachable from this endpoint by construction
 * rather than by a check that could be forgotten. It comes only from the
 * bootstrap scripts, which require shell access to the server.
 */
async function create(req, res) {
  let createdUser = null;
  try {
    const { name, email, mobileNumber, roleIds, accessUpto, status, profileImage, posAccess, familyMembers } = req.body;

    await resolveAssignableRoles(req, roleIds);

    const entity = await findActiveEntityByCode(env.DEFAULT_ENTITY_CODE);
    if (!entity) throw "No active entity is configured.";

    const { user, rawToken } = await createPendingUser({
      name,
      email,
      mobileNumber,
      userType: USER_TYPES.ADMIN_USER,
      entityId: entity._id,
      roleIds,
      createdBy: req.auth?.userId,
      profileImage: profileImage || null,
      status: status === undefined ? 1 : status,
      accessUpto: accessUpto || null,
      posAccess: posAccess === undefined ? false : posAccess,
      familyMembers: familyMembers || [],
    });
    createdUser = user;

    // Staff are enrolled in the customer pool too, so an admin can book for
    // their own family without a second account. Same helper the public
    // register flow uses, and rolled back the same way if it fails — a login
    // with no devotee profile is exactly the half-created state that
    // register() already goes out of its way to avoid.
    await ensureCustomerProfileForUser(user, entity._id);

    const activationUrl = `${env.ADMIN_APP_URL}/admin/activate/${rawToken}`;
    await sendTemplatedEmail("ACCOUNT_ACTIVATION", entity._id, user.email, {
      name: user.name,
      activationUrl,
    });

    return responseHandler({
      res,
      response: user.toSessionUser(),
      successMessage: "User created — an activation email has been sent.",
      statusCode: 201,
    });
  } catch (error) {
    if (createdUser) await rollbackCreatedUser(createdUser._id);
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 403 : undefined });
  }
}

async function update(req, res) {
  try {
    const user = await User.findOne(User.notDeletedFilter({ _id: req.params.id }));
    if (!user) return exceptionHandler({ res, error: "User not found.", statusCode: 404 });

    const { name, email, mobileNumber, roleIds, accessUpto, status, profileImage, posAccess, familyMembers } = req.body;
    const isSelf = String(user._id) === String(req.auth?.userId);

    // A System Admin account is only ever editable by another System Admin —
    // otherwise `users:edit` becomes a way to lock out or take over the
    // highest-privilege accounts on the platform.
    if (user.userType === USER_TYPES.SUPER_ADMIN) assertMaySuperAdmin(req, "modify");

    // Changing your own roles or your own active status is never legitimate
    // here: the first is self-escalation, the second is self-lockout. Both
    // are somebody else's job.
    if (isSelf && roleIds) throw "You can't change the roles on your own account.";
    if (isSelf && status !== undefined && status !== user.status) {
      throw "You can't change the status of your own account.";
    }

    if (roleIds) {
      await resolveAssignableRoles(req, roleIds);
      const assignment = user.getDefaultEntityAssignment();
      if (assignment) assignment.roles = roleIds;
    }

    // Deactivating the last active System Admin leaves nobody able to
    // administer the platform — and nobody able to undo it either.
    if (status === 0 && user.userType === USER_TYPES.SUPER_ADMIN && user.status === 1) {
      const remaining = await User.countDocuments(
        User.notDeletedFilter({ userType: USER_TYPES.SUPER_ADMIN, status: 1, _id: { $ne: user._id } })
      );
      if (remaining === 0) throw "This is the last active System Admin — deactivating it would lock everyone out.";
    }

    if (email && email.toLowerCase() !== user.email) {
      if (await isUserEmailTaken(email, user._id)) throw "Another account already uses this email.";
      user.email = email.toLowerCase();
    }
    if (mobileNumber !== undefined && mobileNumber !== user.mobileNumber) {
      if (mobileNumber && (await isUserMobileTaken(mobileNumber, user._id))) {
        throw "Another account already uses this mobile number.";
      }
      user.mobileNumber = mobileNumber || null;
    }
    if (name) user.name = name;
    // Only touched when a new file was actually uploaded — an edit that
    // doesn't include one must leave the existing avatar alone rather than
    // clearing it.
    if (profileImage) user.profileImage = profileImage;
    if (accessUpto !== undefined) user.accessUpto = accessUpto;
    if (status !== undefined) user.status = status;
    if (posAccess !== undefined) user.posAccess = posAccess;
    if (familyMembers !== undefined) user.familyMembers = familyMembers;

    user.updatedBy = req.auth?.userId || null;
    await user.save();
    await user.populate("familyMembers.natchathiram", "name tamilName");

    return responseHandler({ res, response: user.toSessionUser(), successMessage: "User updated successfully." });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 403 : undefined });
  }
}

/**
 * POST /users/:id/resend-activation
 * For an admin user who never set a password (lost or missed the first email): a fresh set-password link goes to
 * their email, replacing the old one. Same rules as editing the account - a System Admin account only by another
 * System Admin - and a devotee account is not handled here (use Customers).
 */
async function resendUserActivation(req, res) {
  try {
    const user = await User.findOne(User.notDeletedFilter({ _id: req.params.id }));
    if (!user) return exceptionHandler({ res, error: "User not found.", statusCode: 404 });
    if (user.userType === USER_TYPES.CUSTOMER) throw "Devotee accounts are managed from Customers.";
    if (user.userType === USER_TYPES.SUPER_ADMIN) assertMaySuperAdmin(req, "modify");

    const { email, dryRun } = await resendActivation(user);
    return responseHandler({
      res,
      response: { email, dryRun },
      successMessage: dryRun ? `Activation email prepared for ${email} (test mode - not actually sent).` : `Activation email sent to ${email}.`,
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

// Mounted at /users — see routes/index.js for why the prefix lives there.
const router = express.Router();
router.use(authGuard, adminOnly);

// Declared before "/:id" so the literal path is never read as an id, and
// gated on users:edit rather than roles:view — assigning a role is part of
// managing users; inspecting what a role grants is not.
router.get("/assignable-roles", requirePermission("users", "edit"), assignableRoles);

// uploadAvatar runs before validateBody on the write routes: the form is
// submitted as multipart when an image is attached, and req.body doesn't
// exist until multer has parsed it. It's a no-op for plain JSON requests.
router.get("/", requirePermission("users", "view"), list);
router.post("/", requirePermission("users", "fullAccess"), uploadAvatar, validateBody(createSchema), create);
router.put("/:id", requirePermission("users", "edit"), uploadAvatar, validateBody(updateSchema), update);
router.post("/:id/resend-activation", requirePermission("users", "edit"), resendUserActivation);

module.exports = router;

module.exports.resendUserActivation = resendUserActivation;
