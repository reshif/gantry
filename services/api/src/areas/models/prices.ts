/**
 * Price versions (spec 10.4 Prices). A version is immutable once published and has an effective date; the price in force at a moment is the
 * published version with the latest effective date not after that moment (ties: the higher version). Metered cost uses the version in force
 * when the call is recorded and stores that version number on the usage row.
 */
import type { Queryable, Tx } from "@gantry/db";

export interface Price {
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
}
export interface PriceBook {
  version: number | null;
  effectiveFrom: Date | null;
  prices: Record<string, Price>;
}
export interface PriceVersionRow {
  version: number;
  effectiveFrom: string;
  publishedAt: string;
  publishedBy: string | null;
  note: string;
  prices: Record<string, Price>;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export function parsePrices(body: unknown): Record<string, Price> {
  const out: Record<string, Price> = {};
  for (const [id, p] of Object.entries((body && typeof body === "object" ? body : {}) as Record<string, unknown>)) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    out[id] = { in: num(o.in ?? o.input), out: num(o.out ?? o.output), ...(o.cacheRead !== undefined ? { cacheRead: num(o.cacheRead) } : {}), ...(o.cacheWrite !== undefined ? { cacheWrite: num(o.cacheWrite) } : {}) };
  }
  return out;
}

/** The price version in force at `at` (default now). */
export async function priceBookAt(db: Queryable, orgId: string, at: Date = new Date()): Promise<PriceBook> {
  const { rows } = await db.query<{ version: number; body: unknown; eff: Date }>(
    `select version, body, coalesce(effective_from, published_at) as eff from price_versions
      where org_id = $1 and published_at is not null and coalesce(effective_from, published_at) <= $2
      order by coalesce(effective_from, published_at) desc, version desc limit 1`,
    [orgId, at],
  );
  const r = rows[0];
  return r ? { version: r.version, effectiveFrom: r.eff, prices: parsePrices(r.body) } : { version: null, effectiveFrom: null, prices: {} };
}

export async function listPriceVersions(db: Queryable, orgId: string, limit = 50): Promise<PriceVersionRow[]> {
  const { rows } = await db.query<{ version: number; body: unknown; eff: Date; published_at: Date; published_by: string | null; note: string }>(
    `select version, body, coalesce(effective_from, published_at) as eff, published_at, published_by, note from price_versions
      where org_id = $1 and published_at is not null order by version desc limit $2`,
    [orgId, limit],
  );
  return rows.map((r) => ({ version: r.version, effectiveFrom: r.eff.toISOString(), publishedAt: r.published_at.toISOString(), publishedBy: r.published_by, note: r.note, prices: parsePrices(r.body) }));
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Cost in micro-dollars. $ per million tokens equals micro-dollars per token. Cache prices default to Anthropic's ratios of the input price. */
export function costMicros(price: Price | undefined, u: Usage): number {
  if (!price) return 0;
  const cr = price.cacheRead ?? price.in * 0.1;
  const cw = price.cacheWrite ?? price.in * 1.25;
  return Math.round(u.inputTokens * price.in + u.outputTokens * price.out + u.cacheReadTokens * cr + u.cacheWriteTokens * cw);
}

/**
 * Publishes a new price version: the latest version's prices with `changes` applied (a null removes a model). Returns its number.
 * The version number is taken under an advisory lock so two publishers cannot collide.
 */
export async function publishPriceVersion(tx: Tx, orgId: string, changes: Record<string, Price | null>, opts: { by: string | null; note: string; effectiveFrom?: Date | null }): Promise<number> {
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`price_versions:${orgId}`]);
  const last = (await tx.query<{ version: number; body: unknown }>(`select version, body from price_versions where org_id = $1 order by version desc limit 1`, [orgId])).rows[0];
  const body: Record<string, Price> = parsePrices(last?.body);
  for (const [id, p] of Object.entries(changes)) {
    if (p === null) delete body[id];
    else body[id] = p;
  }
  const version = (last?.version ?? 0) + 1;
  await tx.query(
    `insert into price_versions (org_id, version, body, note, published_at, published_by, effective_from) values ($1,$2,$3::jsonb,$4,now(),$5,coalesce($6::timestamptz, now()))`,
    [orgId, version, JSON.stringify(body), opts.note, opts.by, opts.effectiveFrom ?? null],
  );
  return version;
}
