/** Findings group repeated signals by kind, agent and project (spec 13.4). A refresh recounts evidence from the live records; it never drafts or applies anything. */
import type { Queryable, Tx } from "@gantry/db";
import type { LearningFinding } from "@gantry/domain";
import { DAY } from "@gantry/domain";
import { EVIDENCE_CAP, FINDING_WINDOW_DAYS, MIN_REPEATS } from "./config.js";
import { collectSignals, type Signal } from "./signals.js";

interface FindingRow {
  id: string;
  signal: string | null;
  title: string;
  agent_id: string | null;
  project_id: string | null;
  evidence: string[];
  evidence_count: number;
  first_at: Date | null;
  last_at: Date | null;
  status: string;
  version: number;
  created_at: Date;
}

const ms = (d: Date | string | null | undefined): number => (d ? new Date(d).getTime() : 0);
const COLS = `id, signal, title, agent_id, project_id, evidence, evidence_count, first_at, last_at, status, version, created_at`;

export const findingRows = async (db: Queryable, orgId: string, id?: string, lock = false): Promise<FindingRow[]> =>
  (await db.query<FindingRow>(`select ${COLS} from findings where org_id = $1 ${id ? "and id = $2" : ""} and signal is not null order by created_at, id ${lock ? "for update" : ""}`, id ? [orgId, id] : [orgId])).rows;

export function toFinding(r: FindingRow): LearningFinding {
  return {
    id: r.id, title: r.title, signal: r.signal as LearningFinding["signal"], agent: r.agent_id ?? "", project: r.project_id, evidence: Array.isArray(r.evidence) ? r.evidence : [],
    count: r.evidence_count, firstAt: ms(r.first_at ?? r.created_at), lastAt: ms(r.last_at ?? r.created_at), status: r.status, rev: r.version,
  };
}

const LABEL: Record<string, string> = {
  rejection: "Gate rejections", sendback: "Send-backs", revert: "Reverts", incident: "Incidents", override: "Class overrides", miss: "Intake misses", regression: "Eval regressions",
};

/** The reason most of the group's signals give, shortened: it names the finding. */
function topReason(list: readonly Signal[]): string {
  const counts = new Map<string, { n: number; text: string }>();
  for (const s of list) {
    const key = s.text.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
    if (!key) continue;
    const e = counts.get(key) ?? { n: 0, text: s.text.trim().replace(/\s+/g, " ").slice(0, 80) };
    e.n++;
    counts.set(key, e);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.text ?? "";
}

const evidenceOf = (s: Signal): string => s.wo || s.ref || "";

export interface RefreshResult {
  created: number;
  updated: number;
  open: number;
}

/**
 * Groups the signals of the last window by kind, agent and project. A group that repeats opens a finding; an open finding picks up new evidence (up to the cap).
 * Addressed findings are left alone: signals that appear after one was addressed open a new finding once they repeat.
 */
export async function refreshFindings(tx: Tx, orgId: string, now: Date): Promise<RefreshResult> {
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`findings:${orgId}`]);
  const since = now.getTime() - FINDING_WINDOW_DAYS * DAY;
  const signals = (await collectSignals(tx, orgId)).filter((s) => s.at >= since && evidenceOf(s));
  const groups = new Map<string, Signal[]>();
  for (const s of signals) {
    const k = `${s.signal}|${s.agent ?? ""}|${s.project ?? ""}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
  }
  const rows = await findingRows(tx, orgId, undefined, true);
  const open = new Map(rows.filter((r) => r.status === "open").map((r) => [`${r.signal}|${r.agent_id ?? ""}|${r.project_id ?? ""}`, r]));
  let next = rows.reduce((m, r) => Math.max(m, Number(/^F-(\d+)$/.exec(r.id)?.[1] ?? 0)), 0) + 1;
  let created = 0;
  let updated = 0;
  for (const [key, list] of groups) {
    const ids = [...new Set(list.map(evidenceOf))];
    const first = Math.min(...list.map((s) => s.at));
    const last = Math.max(...list.map((s) => s.at));
    const cur = open.get(key);
    if (cur) {
      const have = new Set(cur.evidence);
      const merged = [...cur.evidence];
      for (const id of ids) if (!have.has(id) && merged.length < EVIDENCE_CAP) merged.push(id);
      const lastAt = Math.max(ms(cur.last_at), last);
      if (merged.length === cur.evidence.length && lastAt === ms(cur.last_at)) continue;
      await tx.query(`update findings set evidence = $3::jsonb, evidence_count = $4, last_at = $5, first_at = least(coalesce(first_at, $6), $6), version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [
        orgId, cur.id, JSON.stringify(merged), merged.length, new Date(lastAt), new Date(first),
      ]);
      updated++;
      continue;
    }
    if (ids.length < MIN_REPEATS) continue;
    const [signal, agent, project] = key.split("|") as [string, string, string];
    const reason = topReason(list);
    const title = `${LABEL[signal] ?? signal}${reason ? `: ${reason}` : ""}`;
    const evidence = ids.slice(0, EVIDENCE_CAP);
    await tx.query(
      `insert into findings (org_id, id, kind, subject, body, status, signal, title, agent_id, project_id, evidence, evidence_count, first_at, last_at) values ($1,$2,$3,$4::jsonb,$5,'open',$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
      [orgId, `F-${next++}`, signal, JSON.stringify({ agent: agent || null, project: project || null }), title, signal, title, agent || null, project || null, JSON.stringify(evidence), evidence.length, new Date(first), new Date(last)],
    );
    created++;
  }
  const openNow = Number((await tx.query<{ n: string }>(`select count(*)::text as n from findings where org_id = $1 and status = 'open' and signal is not null`, [orgId])).rows[0]!.n);
  return { created, updated, open: openNow };
}
