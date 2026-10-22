/**
 * Address rules for the admin/POS IP allow list (see controllers/ip-access).
 *
 * Only IPv4 is handled. The sites' DNS records are A records only, so every
 * visitor reaches them over IPv4; an IPv6 value is never a valid list entry
 * and a visitor that somehow arrives over IPv6 is treated as "not on the list".
 *
 * An entry is a single address ("203.0.113.10") or a range in CIDR form
 * ("198.51.100.0/29"). Entries are refused when they could not possibly
 * identify a visitor (a private LAN address such as 192.168.1.10 never
 * reaches the server from the internet) or when they would let in far more
 * than one site's network (a range wider than /24).
 */
const net = require("net");

/** Narrowest we allow is a /32 (one address); the widest is a /24 (256 addresses). */
const MIN_PREFIX = 24;

// Ranges that never appear as a visitor's address on the public internet.
const NEVER_PUBLIC = [
  ["0.0.0.0", 8, "this-network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "shared carrier address space"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "reserved"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmark"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

const neverPublicList = new net.BlockList();
for (const [base, prefix] of NEVER_PUBLIC) neverPublicList.addSubnet(base, prefix, "ipv4");

/**
 * What a visitor's address looks like once the proxy chain has been
 * resolved: trims it and unwraps "::ffff:1.2.3.4" (an IPv4 address the
 * socket reported in IPv6 form). Returns "" for anything unusable.
 */
function normalizeIp(raw) {
  if (typeof raw !== "string") return "";
  let value = raw.trim();
  if (value.toLowerCase().startsWith("::ffff:")) value = value.slice(7);
  return value;
}

/**
 * Validates one list entry typed by a person.
 * @param {string} input
 * @param {{ allowPrivate?: boolean, minPrefix?: number }} [options]
 *   `allowPrivate` is for the server-side always-allowed list, which is set
 *   by whoever runs the server rather than typed into the screen.
 * @returns {{ ok: true, value: string, prefix: number } | { ok: false, error: string }}
 */
function parseEntry(input, { allowPrivate = false, minPrefix = MIN_PREFIX } = {}) {
  const text = normalizeIp(String(input ?? ""));
  if (!text) return { ok: false, error: "Enter an IP address." };

  const [address, prefixText, ...extra] = text.split("/");
  if (extra.length > 0) return { ok: false, error: `"${text.slice(0, 50)}" is not a valid address or range.` };

  if (net.isIPv6(address)) {
    return { ok: false, error: "IPv6 addresses are not supported. The sites are reached over IPv4; enter the IPv4 address." };
  }
  if (!net.isIPv4(address)) return { ok: false, error: `"${address.slice(0, 50)}" is not a valid IPv4 address (example: 203.0.113.10).` };
  // net.isIPv4 accepts "01.2.3.4"? It rejects leading zeros, but keep the guard explicit for readability.
  if (address.split(".").some((part) => part.length > 1 && part.startsWith("0"))) {
    return { ok: false, error: `"${address}" has a leading zero in a number; write it without (for example 203.0.113.10).` };
  }

  let prefix = 32;
  if (prefixText !== undefined) {
    if (!/^\d{1,2}$/.test(prefixText)) return { ok: false, error: `"/${prefixText.slice(0, 10)}" is not a valid range size.` };
    prefix = Number(prefixText);
    if (prefix > 32) return { ok: false, error: "A range size cannot be more than /32." };
    if (prefix < minPrefix) {
      return { ok: false, error: `A range this wide (/${prefix}) would let in many unrelated networks. The widest allowed is /${minPrefix}.` };
    }
  }

  if (!allowPrivate && neverPublicList.check(address, "ipv4")) {
    return {
      ok: false,
      error: `${address} is a private or reserved address (for example a 192.168.x.x LAN address). Visitors reach the server from the temple's PUBLIC address; find it at https://checkip.amazonaws.com from a temple PC.`,
    };
  }

  return { ok: true, value: prefix === 32 ? address : `${address}/${prefix}`, prefix };
}

/**
 * @param {string[]} entries  normalized entries from parseEntry().value
 * @returns {(ip: string) => boolean} true when the address is on the list
 */
function buildMatcher(entries) {
  const list = new net.BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split("/");
    if (prefix === undefined) list.addAddress(address, "ipv4");
    else list.addSubnet(address, Number(prefix), "ipv4");
  }
  return (ip) => {
    const value = normalizeIp(ip);
    return net.isIPv4(value) && list.check(value, "ipv4");
  };
}

module.exports = { MIN_PREFIX, normalizeIp, parseEntry, buildMatcher };
