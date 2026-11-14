/**
 * Dev/demo seed: the legacy G.seed() initial state as typed data, for the demo org ONLY.
 *
 * The data is the legacy seed evaluated once under a fixed clock and frozen into seed.data.ts
 * (regenerate with `node scripts/gen-seed.mjs`). It is reference data: people, projects, repos, agents,
 * policies and so on, plus demo work orders, audit and events. No simulated runtime behaviour is attached.
 * Production orgs never call this.
 */
import { ACTIONS, defaultMatrix } from "./catalog.js";
import { DAY } from "./format.js";
import { SEED_ANCHOR, SEED_JSON } from "./seed.data.js";
import type { DevSeed } from "./types.js";

/** Epoch ms of "now" when the seed was frozen. */
export { SEED_ANCHOR };

const SHIFT_FROM = SEED_ANCHOR - 400 * DAY;
const SHIFT_TO = SEED_ANCHOR + 30 * DAY;

/**
 * Move every timestamp by `delta`. A timestamp is a number of epoch milliseconds within 400 days before and
 * 30 days after the anchor; fixed far-future dates (the year-end freeze) keep their absolute value.
 */
function shift(x: unknown, delta: number): unknown {
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) x[i] = shiftValue(x[i], delta);
    return x;
  }
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    for (const k of Object.keys(o)) o[k] = shiftValue(o[k], delta);
  }
  return x;
}
function shiftValue(v: unknown, delta: number): unknown {
  if (typeof v === "number") return v >= SHIFT_FROM && v <= SHIFT_TO ? v + delta : v;
  return v && typeof v === "object" ? shift(v, delta) : v;
}

/**
 * A fresh copy of the demo org's state, with every relative timestamp shifted so the seed is "now".
 * Each call returns independent objects.
 */
export function devSeed(now: number = Date.now()): DevSeed {
  const data = JSON.parse(SEED_JSON) as DevSeed & { anchor: number };
  const delta = now - SEED_ANCHOR;
  if (delta !== 0) shift(data.state, delta);
  // The frozen legacy seed predates actions added to the built-in catalogue (the Read rights of default deny): carry them, with their
  // built-in defaults, so the demo org has them. Existing cells are never changed.
  const known = new Set(data.catalog.actions.map((a) => a.id));
  const added = ACTIONS.filter((a) => !known.has(a.id));
  if (added.length) {
    data.catalog.actions.push(...added.map((a) => ({ ...a })));
    const defaults = defaultMatrix();
    const m = (data.state as { matrix?: Record<string, Record<string, boolean>> }).matrix;
    if (m) for (const role of Object.keys(m)) for (const a of added) if (defaults[role]?.[a.id] !== undefined) m[role]![a.id] = defaults[role]![a.id]!;
  }
  return { state: data.state, catalog: data.catalog, integrationCategories: data.integrationCategories, notifyEvents: data.notifyEvents };
}
