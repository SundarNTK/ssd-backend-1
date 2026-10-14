/**
 * Min / Max Quantity of an Item or Service: the quantity a booking starts at (the minimum, which cannot be reduced
 * below) and the most that can be booked in one line. A maximum of 0 is an older record saved before the maximum
 * became mandatory and means "no limit" until it is edited.
 *
 * Only applies where the person chooses the quantity - not to lines whose quantity follows the deities picked or is
 * fixed at 1 for family members.
 */
function quantityLimitsOf(master) {
  if (!master) return null;
  if (master.isDeityMappingRequired || master.isFamilyMembersRequired) return null;
  return {
    name: master.name,
    min: Math.max(1, Number(master.minQuantity) || 1),
    max: Number(master.maxQuantity) > 0 ? Number(master.maxQuantity) : null,
  };
}

/** Throws a plain message a cashier can act on when `qty` is outside the master's limits. */
function assertQuantityLimits(limits, qty) {
  if (!limits) return;
  if (qty < limits.min) throw `The minimum quantity for "${limits.name}" is ${limits.min}.`;
  if (limits.max !== null && qty > limits.max) throw `The maximum quantity for "${limits.name}" is ${limits.max}.`;
}

module.exports = { quantityLimitsOf, assertQuantityLimits };
