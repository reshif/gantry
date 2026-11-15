/**
 * The run timeline (agent workspace, Phase 2, G10): what each station's runs did, in order, for people watching the work. Built only from what
 * Gantry recorded: the run starting, the tool calls the edge pulled from each transcript checkpoint (names and short targets), the model calls
 * and their cost as the edge metered them, the web pages read, the documents written, the questions asked and the result. No transcript text.
 */
import type { Queryable } from "@gantry/db";

export type TimelineEntry =
  | { at: number; kind: "start"; text: string }
  | { at: number; kind: "step"; turn: number; tool: string; detail: string }
  | { at: number; kind: "source"; ref: string; url: string; title: string }
  | { at: number; kind: "document"; name: string; version: number }
  | { at: number; kind: "result"; outcome: string; text: string };

export interface RunTimeline {
  runId: string; attemptId: string; station: string; state: string; startedAt: number; endedAt: number | null; turn: number | null;
  model: string | null; calls: number; tokens: number; costUsd: number; entries: TimelineEntry[];
}

/** The latest runs of the work order (newest first), each with its entries in time order. */
export async function woTimeline(db: Queryable, orgId: string, woId: string, limit = 6): Promise<RunTimeline[]> {
  const runs = (await db.query<{ id: string; attempt_id: string; state: string; started_at: Date; ended_at: Date | null; model_id: string | null; data: Record<string, unknown>; station: string }>(
    `select r.id, r.attempt_id, r.state, r.started_at, r.ended_at, r.model_id, r.data, a.station from runs r join attempts a on a.org_id = r.org_id and a.id = r.attempt_id
      where r.org_id = $1 and r.wo_id = $2 order by r.started_at desc limit $3`, [orgId, woId, limit],
  )).rows;
  if (!runs.length) return [];
  const ids = runs.map((r) => r.id);
  const attempts = runs.map((r) => r.attempt_id);
  const [cps, usage, srcs, docs, results] = await Promise.all([
    db.query<{ run_id: string; data: { steps?: Array<{ turn: number; tool: string; detail: string }> }; created_at: Date }>(`select run_id, data, created_at from checkpoints where org_id = $1 and run_id = any($2) and data ? 'steps' order by seq`, [orgId, ids]),
    db.query<{ run_id: string; n: string; tokens: string; micros: string }>(`select run_id, count(*)::text as n, sum(input_tokens + output_tokens)::text as tokens, sum(cost_micros)::text as micros from run_usage where org_id = $1 and run_id = any($2) group by run_id`, [orgId, ids]),
    db.query<{ run_id: string; ref: string; final_url: string; title: string; fetched_at: Date }>(`select run_id, ref, final_url, title, fetched_at from research_sources where org_id = $1 and run_id = any($2)`, [orgId, ids]),
    db.query<{ attempt_id: string; doc: string; version: number; created_at: Date }>(`select attempt_id, doc, version, created_at from artefacts where org_id = $1 and attempt_id = any($2) and doc is not null`, [orgId, attempts]),
    db.query<{ attempt_id: string; outcome: string; summary: string; created_at: Date }>(`select attempt_id, outcome, summary, created_at from station_results where org_id = $1 and attempt_id = any($2)`, [orgId, attempts]),
  ]);
  return runs.map((r) => {
    const u = usage.rows.find((x) => x.run_id === r.id);
    const entries: TimelineEntry[] = [{ at: r.started_at.getTime(), kind: "start", text: `Run started${r.model_id ? ` on ${r.model_id}` : ""}` }];
    for (const c of cps.rows.filter((x) => x.run_id === r.id)) for (const s of c.data.steps ?? []) entries.push({ at: c.created_at.getTime(), kind: "step", turn: s.turn, tool: s.tool, detail: s.detail });
    for (const s of srcs.rows.filter((x) => x.run_id === r.id)) entries.push({ at: s.fetched_at.getTime(), kind: "source", ref: s.ref, url: s.final_url, title: s.title });
    for (const d of docs.rows.filter((x) => x.attempt_id === r.attempt_id)) entries.push({ at: d.created_at.getTime(), kind: "document", name: d.doc, version: d.version });
    for (const x of results.rows.filter((y) => y.attempt_id === r.attempt_id)) entries.push({ at: x.created_at.getTime(), kind: "result", outcome: x.outcome, text: x.summary.slice(0, 400) });
    entries.sort((a, b) => a.at - b.at);
    const hb = r.data.heartbeat as { turn?: number | null } | undefined;
    return {
      runId: r.id, attemptId: r.attempt_id, station: r.station, state: r.state, startedAt: r.started_at.getTime(), endedAt: r.ended_at?.getTime() ?? null, turn: hb?.turn ?? null,
      model: r.model_id, calls: Number(u?.n ?? 0), tokens: Number(u?.tokens ?? 0), costUsd: Number(u?.micros ?? 0) / 1e6, entries,
    };
  });
}
