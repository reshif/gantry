/** The public API's settings (spec 12.5, legacy `apiConfig`): rate limit, burst, idempotency window, webhook signing, and the master switch for triggers (spec 15.3, off in a new install). Stored in orgs.settings.api. */
import type { Queryable } from "@gantry/db";
import { obj } from "../../core/read/rows.js";

export interface ApiSettings {
  rateLimit: number;
  burst: number;
  idempotencyHours: number;
  webhookSigning: string;
  /** Master switch for every trigger. Off in a new install; a trigger also has its own switch. */
  triggersEnabled: boolean;
}
export interface VersionedApiSettings { version: number; value: ApiSettings }

export const DEFAULT_API: ApiSettings = { rateLimit: 60, burst: 20, idempotencyHours: 24, webhookSigning: "HMAC-SHA256", triggersEnabled: false };
/** The signing schemes the outbound webhook delivery implements (the worker signs `t.body` with HMAC-SHA256). */
export const SIGNING = ["HMAC-SHA256"] as const;

const int = (v: unknown, d: number, lo: number, hi: number): number => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : d);

export function parseApi(settings: unknown): VersionedApiSettings {
  const a = obj(obj(settings).api);
  return {
    version: typeof a.version === "number" ? a.version : 0,
    value: {
      rateLimit: int(a.rateLimit, DEFAULT_API.rateLimit, 1, 6000),
      burst: int(a.burst, DEFAULT_API.burst, 0, 1000),
      idempotencyHours: int(a.idempotencyHours, DEFAULT_API.idempotencyHours, 1, 168),
      webhookSigning: typeof a.webhookSigning === "string" && (SIGNING as readonly string[]).includes(a.webhookSigning) ? a.webhookSigning : DEFAULT_API.webhookSigning,
      triggersEnabled: a.triggersEnabled === true,
    },
  };
}

export async function readApiSettings(db: Queryable, orgId: string): Promise<VersionedApiSettings> {
  const { rows } = await db.query<{ settings: unknown }>(`select settings from orgs where id = $1`, [orgId]);
  return parseApi(rows[0]?.settings);
}

/** Settings change rarely and the gate reads them on every API-key request: a few seconds of cache, dropped on every write in this process. */
export class ApiSettingsCache {
  private hit: { at: number; v: VersionedApiSettings } | null = null;
  constructor(private readonly db: Queryable, private readonly orgId: string, private readonly ttlMs = 3000) {}
  async get(): Promise<VersionedApiSettings> {
    const now = Date.now();
    if (this.hit && now - this.hit.at < this.ttlMs) return this.hit.v;
    const v = await readApiSettings(this.db, this.orgId);
    this.hit = { at: now, v };
    return v;
  }
  invalidate(): void {
    this.hit = null;
  }
}
