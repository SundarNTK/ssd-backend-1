const mongoose = require("mongoose");
const {
  auditablePlugin,
  activeUniqueIndexOptions,
  activeUniqueWhenPresent,
} = require("../../common/plugins/auditable");

const { USER_TYPES, USER_TYPE_VALUES } = require("../../utilities/constants/user-types");

/**
 * Which entity (temple/branch) this user has access to, and with which
 * roles under that entity — same shape as HEB's `entities` array on its
 * User model. SSD has exactly one entity ("SST") today, so every user gets
 * exactly one array entry with `default: true`, but nothing about login,
 * permission checks, or the User schema itself assumes there's only ever
 * one — a second entity is a new array entry, not a schema change.
 */
const entityAssignmentSchema = new mongoose.Schema(
  {
    entity: { type: mongoose.Schema.Types.ObjectId, ref: "Entity", required: true },
    roles: [{ type: mongoose.Schema.Types.ObjectId, ref: "Role" }],
    default: { type: Boolean, default: false },
  },
  { _id: false }
);

// Same shape as Customer's family member sub-schema — an admin user is a
// devotee too (see ensureCustomerProfileForUser), and staff sometimes want
// their own family's Natchathiram on hand without switching to the Customer
// Master. Purely informational here: nothing on the User master reads or
// enforces these fields the way booking flows do on Customer, and none of
// them are required.
const familyMemberSchema = new mongoose.Schema(
  {
    nameEnglish: { type: String, default: "", trim: true },
    nameTamil: { type: String, default: "", trim: true },
    natchathiram: { type: mongoose.Schema.Types.ObjectId, ref: "Nakshathiram", default: null },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema({
  // Human-readable account number, "SSD-U1" style — sequence-generated, and
  // distinct from `uid` (random, unguessable, from auditablePlugin).
  uCode: { type: String, default: null },

  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  email: { type: String, required: true, trim: true, lowercase: true },
  mobileNumber: { type: String, default: null },
  profileImage: { type: String, default: null }, // full Cloudinary secure_url

  passwordHash: { type: String, default: null, select: false },

  userType: { type: String, enum: USER_TYPE_VALUES, required: true },
  entities: { type: [entityAssignmentSchema], default: [] },

  familyMembers: { type: [familyMemberSchema], default: [] },

  accessUpto: { type: Date, default: null },

  // Separate from the role/permission system on purpose — "can reach the
  // admin-booking APIs" (a role grant) and "is allowed to physically use
  // the POS counter terminal" (this flag) are different questions. A user
  // can hold full admin-booking permissions and still have this off; the
  // POS login screen and every /pos/booking/* route both check it.
  posAccess: { type: Boolean, default: false },

  // Same shape as posAccess, for the same reason: the Hall & Meal masters
  // (Hall Category, Hall, Hall Purpose, Additional Service, Hall Package,
  // Food Menu Item, Food Package) are deliberately not part of the Role/
  // permission system at all — see AVAILABLE_MODULES and
  // common/middleware/hall-meal-access-only.js. Being SUPER_ADMIN does NOT
  // imply this; it's off by default even for other Super Admin accounts,
  // and is only ever turned on for the one account this area is meant for.
  hallMealAccess: { type: Boolean, default: false },

  // --- activation (first "set your password" link) ---
  //
  // `activationTokenExpiresAt` is null for accounts created from the User
  // master: the invitation stays valid until it is used, so an admin never
  // has to reissue one for somebody who opened it a week later. What ends
  // its life is `passwordSetAt` — the token hash is cleared on use, so the
  // link is strictly single-use even though it never times out.
  activationTokenHash: { type: String, default: null, select: false },
  activationTokenExpiresAt: { type: Date, default: null },
  passwordSetAt: { type: Date, default: null },

  // --- forgot / reset password ---
  passwordResetTokenHash: { type: String, default: null, select: false },
  passwordResetTokenExpiresAt: { type: Date, default: null },

  // --- mobile number change (OTP), staged until verified ---
  pendingMobileNumber: { type: String, default: null },
  mobileChangeOtpHash: { type: String, default: null, select: false },
  mobileChangeOtpExpiresAt: { type: Date, default: null },

  lastLoginAt: { type: Date, default: null },

  // How many rows this user last chose to see per page on any Master list
  // screen (Item Master, Service Master, Deity Master, ...) — set once here
  // and every list screen in the Admin Panel opens at this value, including
  // after a fresh login on a different device, since it rides home on the
  // session user (see toSessionUser() below) rather than living in
  // per-browser storage. Restricted to the same options the page-size
  // selector itself offers (see SSD-Frontend's DataTable.tsx
  // DEFAULT_PAGE_SIZE_OPTIONS) so a stray value can never end up requesting
  // an unsupported page size.
  paginationCount: { type: Number, enum: [10, 25, 50, 100], default: 10 },
});

userSchema.plugin(auditablePlugin);

userSchema.index({ email: 1 }, activeUniqueIndexOptions({ collation: { locale: "en", strength: 2 } }));
// Was `activeUniqueIndexOptions({ sparse: true })`, which MongoDB refuses to
// build (sparse + partialFilterExpression is an illegal combination) — the
// error was logged and swallowed, so mobile numbers had NO uniqueness
// constraint at the database level at all. Accounts may still leave it null.
userSchema.index({ mobileNumber: 1 }, activeUniqueWhenPresent("mobileNumber"));
userSchema.index({ userType: 1, status: 1 });
userSchema.index({ "entities.entity": 1 });
userSchema.index({ uCode: 1 }, activeUniqueWhenPresent("uCode"));

/** True once the invitation has been used — drives the list screens' "Password set" column. */
userSchema.virtual("hasSetPassword").get(function hasSetPassword() {
  return Boolean(this.passwordSetAt);
});

userSchema.set("toJSON", { virtuals: true });
userSchema.set("toObject", { virtuals: true });

userSchema.methods.isAccountUsable = function isAccountUsable() {
  if (this.isDeleted || this.status !== 1) return false;
  if (this.accessUpto && this.accessUpto.getTime() < Date.now()) return false;
  return true;
};

/** The entity a session should resolve to when there's no host-based routing to disambiguate (§ SSD single-entity today). */
userSchema.methods.getDefaultEntityAssignment = function getDefaultEntityAssignment() {
  if (!this.entities || this.entities.length === 0) return null;
  return this.entities.find((e) => e.default) || this.entities[0];
};

userSchema.methods.toSessionUser = function toSessionUser() {
  const defaultAssignment = this.getDefaultEntityAssignment();
  return {
    id: String(this._id),
    uid: this.uid,
    uCode: this.uCode,
    name: this.name,
    email: this.email,
    mobileNumber: this.mobileNumber,
    userType: this.userType,
    profileImage: this.profileImage,
    posAccess: this.posAccess,
    hallMealAccess: this.hallMealAccess,
    entityId: defaultAssignment ? String(defaultAssignment.entity) : null,
    paginationCount: this.paginationCount,
  };
};

module.exports = { User: mongoose.model("User", userSchema), USER_TYPES };
