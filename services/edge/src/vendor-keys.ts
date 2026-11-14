import type { ApiClient } from "./api.js";

/**
 * Vendor API keys: first the operator's /run/secrets/vendor_keys.json, then keys entered in the product (fetched decrypted from the API
 * just before use and cached for a short time only). Every key the edge has seen is remembered so the secret scanner can match it exactly.
 */
export class VendorKeys {
  private readonly cache = new Map<string, { key: string; at: number }>();
  private readonly known = new Set<string>();
  constructor(
    private readonly file: Record<string, string>,
    private readonly api: ApiClient,
    private readonly ttlMs = 60_000,
  ) {
    for (const k of Object.values(file)) this.known.add(k);
  }

  knownKeys(): string[] {
    return [...this.known];
  }

  async get(vendorId: string): Promise<string | null> {
    const f = this.file[vendorId];
    if (f) return f;
    const hit = this.cache.get(vendorId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.key;
    const r = await this.api.call("GET", `/internal/v1/vendors/${encodeURIComponent(vendorId)}/key`);
    if (r.kind !== "ok" || typeof r.body.key !== "string" || !r.body.key) return null;
    this.cache.set(vendorId, { key: r.body.key, at: Date.now() });
    this.known.add(r.body.key);
    return r.body.key;
  }
}
