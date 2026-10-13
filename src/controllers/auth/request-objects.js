const Joi = require("joi");

// Deliberately its own definition, not utilities/constants/schemas/family-member
// (used by the customer-update request objects) — that one requires a 2-100
// char name when nameEnglish is given at all; this one only requires 1+
// when given. Register's validation predates the shared schema and unifying
// them would silently tighten what a public registrant is allowed to submit.
// Neither name is `.required()` — see that shared schema's own comment.
const familyMemberSchema = Joi.object({
  nameEnglish: Joi.string().trim().min(1).allow("").default(""),
  nameTamil: Joi.string().trim().allow("").default(""),
  natchathiram: Joi.string().trim().hex().length(24).allow(null, ""),
});

const loginSchema = Joi.object({
  email: Joi.string().trim().email({ tlds: false }).required(),
  password: Joi.string().min(1).required(),
  // Which sign-in screen this came from. Absent = no portal rule (older clients).
  portal: Joi.string().valid("admin", "pos", "customer"),
});

const activateSchema = Joi.object({
  token: Joi.string().required(),
  newPassword: Joi.string().min(12).required(),
  confirmPassword: Joi.any().valid(Joi.ref("newPassword")).required().messages({
    "any.only": "Confirm password must match the new password.",
  }),
});

const forgotPasswordSchema = Joi.object({
  identifier: Joi.string().trim().min(3).required(),
});

// Mirrors the Customer Master fields (FSD §3.12) — register captures the full
// profile, not just login credentials, since a devotee's family details are
// needed for temple service bookings from day one.
// `maxFamilyMembers`/`status` are deliberately NOT accepted here — those are
// admin-only concerns (the User Master), not something a public registrant
// can set on themselves.
const registerSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  email: Joi.string().trim().email({ tlds: false }).required(),
  mobileNumber: Joi.string().trim().min(6).required(),
  familyMembers: Joi.array().items(familyMemberSchema).max(5).default([]),
});

const resetPasswordSchema = Joi.object({
  token: Joi.string().required(),
  newPassword: Joi.string().min(12).required(),
  confirmPassword: Joi.any().valid(Joi.ref("newPassword")).required().messages({
    "any.only": "Confirm password must match the new password.",
  }),
});

// Kept in lockstep with the User model's own `paginationCount` enum and the
// frontend's DataTable.tsx DEFAULT_PAGE_SIZE_OPTIONS — all three lists must
// agree, or a value valid at one layer could get silently rejected (or
// silently accepted then rejected by the model) at another.
const paginationCountSchema = Joi.object({
  paginationCount: Joi.number().valid(10, 25, 50, 100).required(),
});

module.exports = {
  loginSchema,
  activateSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  registerSchema,
  paginationCountSchema,
};
