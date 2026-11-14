/** Test helpers: the demo seed as flow/insight state, and the legacy engine evaluated on the same data. */
import { devSeed, SEED_ANCHOR } from "./seed.js";
import type { InsightState } from "./insight.js";

export const NOW = SEED_ANCHOR;

export function seedState(now: number = NOW): InsightState {
  const s = devSeed(now);
  return { ...s.state, catalog: s.catalog, stops: { factory: s.state.factory.killed }, events: s.state.events } as InsightState;
}

/** Clone with a mutation applied; the original is untouched. */
export function mutate(state: InsightState, f: (s: InsightState) => void): InsightState {
  const c = structuredClone(state);
  f(c);
  return c;
}
