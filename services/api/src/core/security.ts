import { BlockList, isIP } from "node:net";
import type { SecuritySettings } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { DEFAULT_SECURITY, readSecurity, type Versioned } from "./read/index.js";

/** Is `ip` inside any allow-list entry (a CIDR or a bare address)? An empty list allows everyone. IPv4-mapped IPv6 is unwrapped. */
export function ipAllowed(ip: string, allow: string[]): boolean {
  if (!allow.length) return true;
  const addr = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const fam = isIP(addr);
  if (!fam) return false;
  const list = new BlockList();
  for (const raw of allow) {
    const [net, bits] = raw.trim().split("/");
    const f = net ? isIP(net) : 0;
    if (!net || !f) continue;
    const type = f === 4 ? "ipv4" : "ipv6";
    if (bits === undefined) list.addAddress(net, type);
    else if (/^\d+$/.test(bits)) list.addSubnet(net, Number(bits), type);
  }
  return list.check(addr, fam === 4 ? "ipv4" : "ipv6");
}

export function emailDomainAllowed(email: string, domains: string[]): boolean {
  if (!domains.length) return true;
  const d = email.split("@")[1]?.toLowerCase();
  return !!d && domains.some((x) => x.trim().toLowerCase() === d);
}

/** Security settings change rarely and are read on every request (IP list, idle timeout): a few seconds of cache, dropped on every write. */
export class SecurityCache {
  private hit: { at: number; v: Versioned<SecuritySettings> } | null = null;
  constructor(private readonly db: Queryable, private readonly orgId: string, private readonly ttlMs = 3000) {}
  async get(): Promise<Versioned<SecuritySettings>> {
    const now = Date.now();
    if (this.hit && now - this.hit.at < this.ttlMs) return this.hit.v;
    const v = await readSecurity(this.db, this.orgId);
    this.hit = { at: now, v };
    return v;
  }
  invalidate(): void {
    this.hit = null;
  }
}

export { DEFAULT_SECURITY };
