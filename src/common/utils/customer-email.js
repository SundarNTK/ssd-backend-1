/**
 * A customer profile always carries an email (it is unique and the registration key), but a walk-in created at the
 * counter may have none. Such a profile stores a placeholder derived from the mobile number instead, which is never
 * shown as a real address and never emailed. When the person later registers on the same mobile, the profile is
 * claimed and the placeholder is replaced by the real email (see controllers/auth).
 */
const PLACEHOLDER_SUFFIX = "@no-email.local";
const PLACEHOLDER_RE = /@no-email\.local$/i;

const placeholderEmail = (mobileNumber) => `walkin.${String(mobileNumber).trim()}${PLACEHOLDER_SUFFIX}`;
const isPlaceholderEmail = (email) => PLACEHOLDER_RE.test(String(email || ""));

module.exports = { placeholderEmail, isPlaceholderEmail };
