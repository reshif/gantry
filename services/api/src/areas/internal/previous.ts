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
  /** When the result was written (ms since the epoch). Needed to tell a result of the current round from one before the last send-back. */
  at?: number;
}

export interface PreviousResult {
  station: string;
  summary: string;
  output: unknown;
  /** Set when the result was written before the send-back that returned this station: it belongs to a round that was discarded, and says what the work looked like then, not now. */
  fromDiscardedRound?: true;
  /** Set when the output was cut to fit the cap: which top-level fields were kept in full and which were left out. */
  truncated?: { bytes: number; keptFields: string[]; omittedFields: string[] };
}

export interface PreviousHandoff {
  results: PreviousResult[];
  /** Present when this station was returned by a send-back and some results are from before it. */
  discardedRound?: { stations: string[]; note: string };
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

/**
 * `rows` in creation order. Returns the latest succeeded result of each station, in the order the stations first appear, within `cap` bytes.
 * `redo` is set for a station that a send-back returned (S-146): the results of that station and of every station after it that were written before the
 * send-back belong to the round being redone, and are marked as such instead of being presented as the current state of the work.
 */
export function compactPrevious(rows: StationResultRow[], woId: string, cap: number = PREVIOUS_CAP_BYTES, redo?: { station: string; since: number }): PreviousHandoff {
  const latest = new Map<string, StationResultRow>();
  for (const r of rows) if (r.outcome === "succeeded") latest.set(r.station, r);
  const seen = [...new Set(rows.map((r) => r.station))];
  const order = seen.filter((s) => latest.has(s));
  const budget = Math.max(MIN_PER_RESULT, Math.floor(cap / Math.max(1, order.length)));
  const from = redo ? seen.indexOf(redo.station) : -1;
  const results = order.map((s) => {
    const r = latest.get(s)!;
    const out = fit({ station: s, summary: r.summary ?? "", output: r.body?.output ?? null }, budget);
    return redo && from >= 0 && seen.indexOf(s) >= from && typeof r.at === "number" && r.at < redo.since ? { ...out, fromDiscardedRound: true as const } : out;
  });
  const discarded = results.filter((r) => r.fromDiscardedRound).map((r) => r.station);
  return {
    results,
    ...(discarded.length ? { discardedRound: { stations: discarded, note: `${discarded.join(", ")} ${discarded.length === 1 ? "is" : "are"} from a discarded round: written before the send-back that returned ${redo!.station}. They show what the work looked like then, not what it is now; do not treat them as current.` } } : {}),
    omitted: {
      attempts: rows.length - results.length,
      note: `Earlier attempts, failed or interrupted runs, usage and cost are not repeated here. The station documents above and the questions and assumptions hold what was settled; the full record is on the timeline of work order ${woId}. If something you need is missing, ask the person rather than guess.`,
    },
  };
}
