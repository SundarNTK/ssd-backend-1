const { Customer } = require("../../../models/customers");
const { USER_TYPES } = require("../../constants/user-types");

/**
 * A devotee account is also switched off from the Customer master: marking the
 * profile Inactive (or deleting it) must lock the login out, even for a login
 * created before the two statuses were kept in step. Staff are devotees too, but
 * their sign-in is governed by their User record, so only CUSTOMER accounts are
 * looked at here.
 */
async function isCustomerProfileInactive(user) {
  if (!user || user.userType !== USER_TYPES.CUSTOMER) return false;
  const profile = await Customer.findOne({ linkedUserId: user._id }).select("status isDeleted").lean();
  return Boolean(profile && (profile.isDeleted || profile.status !== 1));
}

module.exports = isCustomerProfileInactive;
