/**
 * SSRF protections for outbound monitoring checks (spec 11).
 * Pure functions so every blocked class is unit-testable.
 */

import { isIP } from "node:net";

export const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
export const MAX_REDIRECTS = 4;

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

const INTERNAL_HOSTNAMES = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^metadata\.google\.internal$/i,
  /^instance-data$/i,
];

function parseIpFamilies(ip: string): { family: 4 | 6; normalized: string } {
  if (isIP(ip) !== 6) return { family: 4, normalized: ip };
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 in any spelling) — the OS treats these
  // as IPv4, so range checks must too.
  const groups = expandIPv6(ip).split(":");
  if (groups.slice(0, 5).every((g) => g === "0000") && groups[5] === "ffff") {
    const hi = parseInt(groups[6]!, 16);
    const lo = parseInt(groups[7]!, 16);
    return { family: 4, normalized: [(hi >>> 8) & 255, hi & 255, (lo >>> 8) & 255, lo & 255].join(".") };
  }
  return { family: 6, normalized: ip };
}

/** Decode alternate IPv4 encodings (decimal, octal, hex) to dotted-quad. */
export function normalizeIPv4(host: string): string | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  if (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && (p === "0" || !p.startsWith("0")) && Number(p) <= 255)
  )
    return host;
  // Windows/INET_ATON style: fewer parts, possibly hex/octal segments
  const nums: number[] = [];
  for (const part of parts) {
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) nums.push(parseInt(part, 16));
    else if (/^0[0-7]+$/.test(part)) nums.push(parseInt(part, 8));
    else if (/^\d+$/.test(part)) nums.push(parseInt(part, 10));
    else return null;
    if (nums.length > 1 && nums[nums.length - 1]! > 255) return null;
  }
  if (nums.length === 1) {
    const n = nums[0];
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }
  if (nums.length === 2) {
    return [nums[0], (nums[1]! >>> 16) & 255, (nums[1]! >>> 8) & 255, nums[1]! & 255].join(".");
  }
  if (nums.length === 3) {
    return [nums[0], nums[1], (nums[2]! >>> 8) & 255, nums[2]! & 255].join(".");
  }
  if (nums.length === 4) {
    return nums.join(".");
  }
  return null;
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function expandIPv6(ip: string): string {
  let addr = ip;
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  // Embedded dotted-quad (::ffff:127.0.0.1, 64:ff9b::192.0.2.1) → two hex groups;
  // a raw dotted group would crash the BigInt conversion below.
  if (addr.includes(":")) {
    const quad = addr.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (quad) {
      const [a, b, c, d] = quad[2]!.split(".").map(Number);
      addr = quad[1] + `${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`;
    }
  }
  if (addr.includes("::")) {
    const sides = addr.split("::");
    const left = sides[0] ? sides[0].split(":").filter(Boolean) : [];
    const right = sides[1] ? sides[1].split(":").filter(Boolean) : [];
    const missing = 8 - left.length - right.length;
    addr = [...left, ...Array(missing).fill("0"), ...right].join(":");
  }
  return addr
    .split(":")
    .map((g) => g.padStart(4, "0"))
    .join(":")
    .toLowerCase();
}

const FORBIDDEN_V6 = [
  "::/8", // reserved "this network": unspecified, loopback, deprecated IPv4-compatible (RFC 4291)
  "fc00::/7", // unique local
  "fe80::/10", // link-local
  "ff00::/8", // multicast
  "2001:db8::/32", // documentation
  "64:ff9b:1::/48", // NAT64 local (RFC 6052 section 3.1)
];

function ipv6InCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const a = BigInt("0x" + expandIPv6(ip).replace(/:/g, ""));
  const b = BigInt("0x" + expandIPv6(base!).replace(/:/g, ""));
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (a & mask) === (b & mask);
}

/** True when the IP must never be contacted by the checker. */
export function isForbiddenIp(rawIp: string): boolean {
  // Zone index (fe80::1%eth0): node:net.isIP rejects it, so strip before parsing.
  const { family, normalized } = parseIpFamilies(rawIp.replace(/%[0-9A-Za-z._~-]+$/, ""));
  if (family === 4) {
    const ip = normalizeIPv4(normalized) ?? normalized;
    return (
      inCidr4(ip, "0.0.0.0", 8) || // "this" network / unspecified
      inCidr4(ip, "10.0.0.0", 8) || // private
      inCidr4(ip, "100.64.0.0", 10) || // CGNAT
      inCidr4(ip, "127.0.0.0", 8) || // loopback
      inCidr4(ip, "169.254.0.0", 16) || // link-local (incl. 169.254.169.254 metadata)
      inCidr4(ip, "172.16.0.0", 12) || // private
      inCidr4(ip, "192.0.0.0", 24) || // IETF protocol assignments
      inCidr4(ip, "192.0.2.0", 24) || // TEST-NET-1
      inCidr4(ip, "192.88.99.0", 24) || // 6to4 relay anycast (deprecated)
      inCidr4(ip, "192.168.0.0", 16) || // private
      inCidr4(ip, "198.18.0.0", 15) || // benchmarking
      inCidr4(ip, "198.51.100.0", 24) || // TEST-NET-2
      inCidr4(ip, "203.0.113.0", 24) || // TEST-NET-3
      inCidr4(ip, "224.0.0.0", 4) || // multicast
      inCidr4(ip, "240.0.0.0", 4) // reserved (incl. broadcast)
    );
  }
  return FORBIDDEN_V6.some((cidr) => ipv6InCidr(normalized, cidr));
}

/** Validate a monitoring target URL before it is ever saved or fetched. */
export function validateMonitorUrl(rawUrl: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: "URL is not parseable." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `Protocol ${url.protocol} is not allowed; use http or https.` };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Credentials in URLs are not allowed." };
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) {
    return { ok: false, error: `Port ${port} is not in the allowed set (80, 443, 8080, 8443).` };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (INTERNAL_HOSTNAMES.some((re) => re.test(url.hostname))) {
    return { ok: false, error: `Internal hostname "${url.hostname}" is blocked.` };
  }
  // Literal IPs are validated now; hostnames are re-validated on every check.
  if (isIP(host) || /^v[0-9a-f]+\./i.test(host)) {
    if (isForbiddenIp(host)) return { ok: false, error: `Address ${host} resolves to a forbidden range.` };
  }
  // Alternate encodings of IPv4 (decimal, octal, hex, short forms).
  if (/^\d+(\.\d+)*$/.test(host) || /^0[xX][0-9a-fA-F]+$/.test(host)) {
    const normalized = normalizeIPv4(host);
    if (normalized && isForbiddenIp(normalized)) {
      return { ok: false, error: `Address ${host} is an alternate encoding of a forbidden range.` };
    }
  }
  return { ok: true, url };
}

/** Resolve a redirect Location against the previous URL, revalidating fully. */
export function resolveRedirect(previous: URL, location: string): UrlCheck {
  let next: URL;
  try {
    next = new URL(location, previous);
  } catch {
    return { ok: false, error: "Unparseable redirect location." };
  }
  if (next.protocol !== previous.protocol && !["http:", "https:"].includes(next.protocol)) {
    return { ok: false, error: "Redirect to a disallowed protocol." };
  }
  return validateMonitorUrl(next.toString());
}
