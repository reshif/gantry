/**
 * The `previous` part of a station handoff (spec 10.2): what earlier stations concluded, without the noise around it.
 *
 * Gantry supplies structure and a size limit; it does not decide what a station should conclude. For each earlier station only the latest
 * accepted (succeeded) result is passed, as its summary and structured output. Superseded attempts, failed and interrupted runs, retry
 * history, token usage, cost and runner metadata are left out: the station documents and the dialogue carry the substance, and the rest is
 * on the work order's timeline.
 */

export interface StationResultRow {
  station: string;
  outcome: string;
  summary: string | null;
  body: Record<string, unknown> | null;
}

export interface PreviousResult {
  station: string;
  summary: string;
  output: unknown;
  /** Set when the output was cut to fit the cap: which top-level fields were kept in full and which were left out. */
  truncated?: { bytes: number; keptFields: string[]; omittedFields: string[] };
}

export interface PreviousHandoff {
  results: PreviousResult[];
  /** What was left out and where the rest is, so the agent knows it exists and does not guess. */
  omitted: { attempts: number; note: string };
}

/** Total serialized size of the `previous` results. Well under the 100 KB command-line limit the prompt must fit in. */
export const PREVIOUS_CAP_BYTES = 12_000;
const MIN_PER_RESULT = 1_000;

const size = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? "");

function fit(r: { station: string; summary: string; output: unknown }, budget: number): PreviousResult {
  const out: PreviousResult = { station: r.station, summary: r.summary.slice(0, 1_000), output: r.output };
  const bytes = size(r.output);
  if (bytes <= budget) return out;
  const o = r.output;
  if (typeof o === "object" && o !== null && !Array.isArray(o)) {
    const kept: Record<string, unknown> = {};
    const omittedFields: string[] = [];
    let left = budget;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const s = size({ [k]: v });
      if (s <= left) {
        kept[k] = v;
        left -= s;
      } else omittedFields.push(k);
    }
    return { ...out, output: kept, truncated: { bytes, keptFields: Object.keys(kept), omittedFields } };
  }
  return { ...out, output: null, truncated: { bytes, keptFields: [], omittedFields: [] } };
}

/** `rows` in creation order. Returns the latest succeeded result of each station, in the order the stations first appear, within `cap` bytes. */
export function compactPrevious(rows: StationResultRow[], woId: string, cap: number = PREVIOUS_CAP_BYTES): PreviousHandoff {
  const latest = new Map<string, StationResultRow>();
  for (const r of rows) if (r.outcome === "succeeded") latest.set(r.station, r);
  const order = [...new Set(rows.map((r) => r.station))].filter((s) => latest.has(s));
  const budget = Math.max(MIN_PER_RESULT, Math.floor(cap / Math.max(1, order.length)));
  const results = order.map((s) => {
    const r = latest.get(s)!;
    return fit({ station: s, summary: r.summary ?? "", output: r.body?.output ?? null }, budget);
  });
  return {
    results,
    omitted: {
      attempts: rows.length - results.length,
      note: `Earlier attempts, failed or interrupted runs, usage and cost are not repeated here. The station documents above and the questions and assumptions hold what was settled; the full record is on the timeline of work order ${woId}. If something you need is missing, ask the person rather than guess.`,
    },
  };
}
