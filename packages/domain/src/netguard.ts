/**
 * Address guard shared by the API (vendor endpoint check) and the edge (model gateway, at request time): which addresses a vendor call may never reach
 * (S-68). Node only (uses node:net): import it as `@gantry/domain/netguard`, never from the package index, so the web bundle stays clean.
 * Same rules as the edge forward proxy and the MCP / research guards (services/edge/src/proxy.ts); kept in step with `isPrivateAddress` there.
 */
import net from "node:net";

export function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
}

export function inCidr(addr: string, cidr: string): boolean {
  const a = ipv4ToInt(addr.replace(/^::ffff:/i, ""));
  const [base, bitsS] = cidr.split("/");
  const b = ipv4ToInt(base ?? "");
  const bits = Number(bitsS);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

const PRIVATE_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3"];

/** Expands an IPv6 literal to its 16 bytes (null when it is not one). Handles `::` and a trailing dotted IPv4 part. */
function ipv6Bytes(addr: string): number[] | null {
  let a = addr.toLowerCase();
  const pct = a.indexOf("%");
  if (pct >= 0) a = a.slice(0, pct);
  if (!net.isIPv6(a)) return null;
  let tail: number[] = [];
  const lastColon = a.lastIndexOf(":");
  const last = a.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = ipv4ToInt(last);
    if (v4 === null) return null;
    tail = [(v4 >>> 24) & 255, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255];
    a = a.slice(0, lastColon + 1) + (a.endsWith("::" + last) ? "" : "0");
    if (a.endsWith(":0")) a = a.slice(0, -2);
  }
  const groupsWanted = 8 - tail.length / 2;
  const [head, rest] = a.includes("::") ? a.split("::") as [string, string] : [a, null];
  const h = head ? head.split(":").filter((x) => x !== "") : [];
  const r = rest !== null && rest !== undefined ? rest.split(":").filter((x) => x !== "") : [];
  const fill = rest === null ? 0 : groupsWanted - h.length - r.length;
  const groups = [...h, ...Array(Math.max(0, fill)).fill("0"), ...r];
  if (groups.length !== groupsWanted) return null;
  const out: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    out.push((n >>> 8) & 255, n & 255);
  }
  return [...out, ...tail];
}

const v4Of = (b: number[], at: number): string => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;

/**
 * Loopback, link-local, private, multicast, reserved: addresses an allow-listed name must never lead to. IPv6 forms that embed an IPv4
 * address (mapped ::ffff:0:0/96 in any spelling, compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16) are judged by that IPv4 address.
 */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.replace(/^::ffff:(?=\d+\.)/i, "");
  if (net.isIPv4(a)) return PRIVATE_V4.some((c) => inCidr(a, c));
  const b = ipv6Bytes(a);
  if (!b) return true;
  const zero = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateAddress(v4Of(b, 12)); // mapped
  if (zero(0, 12)) return true; // ::, ::1 and the deprecated IPv4-compatible block
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return isPrivateAddress(v4Of(b, 12)); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateAddress(v4Of(b, 2)); // 6to4
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true; // multicast
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return true; // 100::/64 discard
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  return false;
}


/** Never reachable by a vendor call, whatever an admin lists: loopback, the unspecified address, link-local (cloud metadata is 169.254.169.254) and IPv6 equivalents. */
const NEVER_V4 = ["0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/3"];

/** Compose networks that hold the control plane (deploy/compose.yml `control`); also never reachable. */
export const CONTROL_CIDRS: readonly string[] = ["10.89.17.0/24"];

/** The ranges an admin may open for an on-prem vendor: private ranges only (RFC 1918 and 100.64/10), never loopback or link-local. */
export const LAN_OPENABLE_V4: readonly string[] = ["10.0.0.0/8", "100.64.0.0/10", "172.16.0.0/12", "192.168.0.0/16"];

/** True when `cidr` is an IPv4 range (a bare address is a /32) inside private space. (The control network is refused at connect time even when a listed range covers it.) */
export function validLanCidr(cidr: string): boolean {
  const [base, bitsS] = cidr.split("/");
  if (!base || ipv4ToInt(base) === null) return false;
  const bits = bitsS === undefined ? 32 : Number(bitsS);
  if (!Number.isInteger(bits) || bits < 8 || bits > 32) return false;
  return LAN_OPENABLE_V4.some((c) => inCidr(base, c) && bits >= Number(c.split("/")[1]));
}

/**
 * Host names refused as a vendor endpoint before any lookup: loopback names always; with no LAN range listed also single-label names (compose
 * service names such as gantry-api, gantry-edge, mailpit) and `.internal` / `.local`. The edge still resolves and checks the address at request time.
 */
export function forbiddenVendorName(host: string, lanListed = false): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (net.isIP(h.replace(/^\[|\]$/g, ""))) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  return !lanListed && (!h.includes(".") || h.endsWith(".internal") || h.endsWith(".local"));
}

/**
 * Whether a vendor call may connect to this address. Loopback, link-local (metadata) and the control networks are refused always; other private
 * space is refused unless it lies in a range a Factory Admin listed (`lan`). Returns the reason, or null when allowed.
 */
export function vendorAddressRefusal(addr: string, lan: readonly string[] = []): string | null {
  const a = addr.replace(/^\[|\]$/g, "").replace(/^::ffff:(?=\d+\.)/i, "");
  if (net.isIPv4(a)) {
    if (NEVER_V4.some((c) => inCidr(a, c))) return `${a} is a loopback, link-local or metadata address.`;
    if (CONTROL_CIDRS.some((c) => inCidr(a, c))) return `${a} is on Gantry's control network.`;
    if (!isPrivateAddress(a)) return null;
    return lan.some((c) => inCidr(a, c)) ? null : `${a} is a private address. An on-prem vendor needs its LAN range listed in Security.`;
  }
  return isPrivateAddress(a) ? `${a} is a loopback, link-local or private IPv6 address.` : null;
}
