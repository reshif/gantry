/** The record read (GET /work-orders/{id}/record), its changes read, and the facts the sections derive from them. */
import { useQuery } from "@tanstack/react-query";
import type { Brief, BriefVersion, ConvMessage, Criterion, HistoryEntry, Outcome, Project, Sendback } from "@gantry/domain";
import { api, get } from "../../api/client";
import type { DiffRead } from "../../api/types";
import { qk } from "../../api/keys";
import { useProject } from "../../api/queries";
import { useCatalog } from "../projects/kit";
import { bayLabel, stName, useTravelerWo, type RawRecEvent, type TWo } from "../traveler/model";

/** The Review agent's recorded verdict (record.review, and on the gate instance as basis.review). */
export interface RecReview {
  verdict: "approve" | "changes_requested" | "none";
  reported?: string;
  criteria: Array<{ criterion: string; result: "pass" | "fail" | "untested"; evidence: string }>;
  findings: Array<{ severity: string; file: string; line: number | null; issue: string; fix: string }>;
  notes: string;
  sendBackTo?: string | null;
  headSha?: string | null;
  at?: number;
}
export interface RecGate {
  id: string;
  gate: string;
  station: string | null;
  status: string;
  closedReason: string | null;
  headSha: string | null;
  openedAt: string | null;
  closedAt: string | null;
  pinned: { flowVersion: number; ruleVersion: number | null; policyVersion: number | null };
  basis: { checks?: Array<{ name: string; ok: boolean }>; required?: number; riskTags?: string[]; forcedHuman?: boolean; review?: RecReview };
  votes: Array<{ by: string; vote: string; comment: string; at: string | null; via: string; role: string | null }>;
  decision: { decision: string; decided_by: string | null; rule: string | null; trust_level: string | null; detail: { mode?: string; reason?: string; via?: string; reasonCode?: string; samplingReason?: string } | null; at: string } | null;
}
export interface RecPr {
  number: number;
  state: string;
  draft: boolean;
  headSha: string | null;
  title: string;
  url: string | null;
  mergedAt: string | null;
}
export interface RecCommit {
  sha: string;
  message: string;
  author: string | null;
  at: string | null;
}
export interface RecFile {
  path: string;
  from?: string | null;
  status: string;
  plus: number;
  minus: number;
  step?: string;
  ac?: string[];
  protected?: boolean;
  state?: string;
  preview?: Array<{ t: string; s: string }>;
}
export interface RecordData {
  id: string;
  version: number;
  project: string;
  repo: string;
  title: string;
  state: string;
  request: { text: string; by: string; via: string; at: number; attachments: unknown[] };
  classification: { predicted: string; final: string; confidence: number; rationale: string; requested: string | null; overridden: { by: string; at: number; from: string; reason: string } | null };
  route: string[];
  flowVersion: number;
  clarification: ConvMessage[];
  briefVersions: BriefVersion[];
  brief: Brief;
  criteria: Criterion[];
  journey: HistoryEntry[];
  gates: RecGate[];
  review?: RecReview | null;
  sendbacks: Sendback[];
  bayStays: Array<{ bay: string; reason: string; by: string | null; from: string | null; to: string | null }>;
  attempts: Array<{ id: string; station: string; visit: number; fencing: number; state: string; outcome: string | null; startedAt: string | null; endedAt: string | null; agent: string | null }>;
  results: Array<{ id: string; attempt: string; station: string; outcome: string; summary: string; at: string | null; output: unknown }>;
  runs: Array<{ id: string; attempt: string; state: string; model: string | null; at: string | null }>;
  code: { pullRequests: RecPr[]; commits: RecCommit[]; files: RecFile[]; diff: { plus: number; minus: number; files: number }; tests: { passed: number; failed: number; added: number } };
  outcomes: Outcome[];
  totals: { tokens: number; cost: number };
  completeness: { sections: Record<string, boolean>; done: number; total: number };
  summary: { generated: string; written: { text: string; by: string; at: number } | null };
  events: RawRecEvent[];
}
export interface ChangesData {
  pullRequests: Array<{ number: number; state: string; headSha: string | null; branch: string | null; base: string | null; url: string | null }>;
  commits: Array<{ sha: string; message: string; author: string | null; at: number | null; files: Array<{ path: string; status: string; plus: number; minus: number }> }>;
  files: Array<{ path: string; status: string; plus: number; minus: number }>;
  patches: Array<{ id: string; ref: string; bytes: number }>;
}

export function useRecordRead(id: string | null | undefined) {
  return useQuery({ queryKey: qk.record(id ?? ""), queryFn: () => get<RecordData>(api(`work-orders/${encodeURIComponent(id ?? "")}/record`)), enabled: !!id });
}
/** The stored patch text of the work order as one entry per file across its commits, with hunks and line numbers (GET /work-orders/{id}/diff). */
export function useDiffRead(id: string | null | undefined) {
  return useQuery({ queryKey: qk.diff(id ?? ""), queryFn: () => get<DiffRead>(api(`work-orders/${encodeURIComponent(id ?? "")}/diff`)), enabled: !!id });
}
export function useChangesRead(id: string | null | undefined) {
  return useQuery({ queryKey: qk.changes(id ?? ""), queryFn: () => get<ChangesData>(api(`work-orders/${encodeURIComponent(id ?? "")}/changes`)), enabled: !!id });
}

/** Everything a record screen reads: the traveler read of the work order, its record and its project. */
export function useRecordData(woId: string | null | undefined) {
  const wo = useTravelerWo(woId);
  const rec = useRecordRead(woId);
  const project = useProject(wo.data?.project).data ?? null;
  const cat = useCatalog();
  return { wo: wo.data, rec: rec.data, project: project as Project | null, cat, loading: wo.isLoading || rec.isLoading, error: wo.error ?? rec.error };
}

export const ms = (iso: string | null | undefined): number | null => (iso ? Date.parse(iso) : null);
export const sum = <T extends { plus: number; minus: number }>(files: T[], k: "plus" | "minus"): number => files.reduce((t, f) => t + (f[k] || 0), 0);

export const SECTIONS = [
  { id: "summary", label: "Summary" },
  { id: "request", label: "Request" },
  { id: "clarification", label: "Clarification" },
  { id: "agreement", label: "Agreement" },
  { id: "stations", label: "Station by station" },
  { id: "changes", label: "Changes" },
  { id: "verification", label: "Verification" },
  { id: "merge", label: "Merge and release" },
  { id: "approvals", label: "Approvals" },
  { id: "after", label: "After release" },
  { id: "timeline", label: "Full timeline" },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];

export const SOURCES: Record<string, string> = { ui: "Gantry web", web: "Gantry web", console: "Gantry console", slack: "Slack", github: "GitHub issue trigger", api: "API", issue: "Issue trigger", schedule: "Schedule", ci: "Failing CI" };
export const srcName = (s: string | null | undefined): string => (s && SOURCES[s]) || s || "unknown";

/** Visits in order of start, with the agent's reported summary taken from the station results (the n-th result of a station is the n-th visit). */
export function visitsOf(wo: TWo, rec: RecordData | undefined): Array<HistoryEntry & { summary?: string }> {
  const seen: Record<string, number> = {};
  return (wo.history || [])
    .filter((e) => e.station)
    .map((e) => {
      const n = (seen[e.station] = (seen[e.station] ?? 0) + 1);
      const res = (rec?.results ?? []).filter((r) => r.station === e.station)[n - 1];
      const summary = e.summary || res?.summary || undefined;
      return summary ? { ...e, summary } : e;
    });
}
export function routeTaken(wo: TWo): string[] {
  const out: string[] = [];
  for (const e of wo.history || []) if (e.station && out[out.length - 1] !== e.station) out.push(e.station);
  return out;
}
export const endAt = (wo: TWo): number => wo.doneAt || (wo.killed && wo.killed.at) || Date.now();
export function stateLine(wo: TWo, cat: ReturnType<typeof useCatalog>): string {
  if (wo.state === "done") return "Shipped" + (wo.pr && wo.pr.tag ? ` as ${wo.pr.tag}` : "");
  if (wo.state === "killed") return "Killed";
  if (wo.bay) return `In ${bayLabel(cat, wo.bay)}`;
  const label = { running: "Running", waiting: "Waiting", blocked: "Blocked", failed: "Failed" }[wo.state as string] ?? wo.state;
  return `${label} at ${stName(cat, cat?.stations[wo.station]?.id) || "a station"}`;
}
/** Question and answer pairs of the intake conversation. */
export function qaPairs(msgs: ConvMessage[], isAgent: (id: string) => boolean): Array<{ q: ConvMessage; a: ConvMessage | null }> {
  const out: Array<{ q: ConvMessage; a: ConvMessage | null }> = [];
  msgs.forEach((m, i) => {
    if (!m.qid) return;
    let ans: ConvMessage | null = null;
    for (let k = i + 1; k < msgs.length; k++) {
      const x = msgs[k]!;
      if (x.qid) break;
      if (!isAgent(x.from)) {
        ans = x;
        break;
      }
    }
    out.push({ q: m, a: ans });
  });
  return out;
}
export function briefDiff(a: BriefVersion["brief"] | undefined, b: BriefVersion["brief"] | undefined): Array<{ t: "+" | "-"; field: string; text: string }> {
  const out: Array<{ t: "+" | "-"; field: string; text: string }> = [];
  const x0 = a ?? ({} as Partial<BriefVersion["brief"]>);
  const y0 = b ?? ({} as Partial<BriefVersion["brief"]>);
  if (x0.goal !== y0.goal && y0.goal) {
    out.push({ t: "-", field: "Goal", text: x0.goal || "" });
    out.push({ t: "+", field: "Goal", text: y0.goal });
  }
  const fields: Array<[keyof BriefVersion["brief"], string]> = [["scopeIn", "Scope in"], ["scopeOut", "Scope out"], ["ac", "Acceptance"], ["risks", "Risk"], ["decisions", "Decision"]];
  for (const [k, label] of fields) {
    const x = (x0[k] as string[] | undefined) ?? [];
    const y = (y0[k] as string[] | undefined) ?? [];
    x.forEach((v) => y.includes(v) || out.push({ t: "-", field: label, text: v }));
    y.forEach((v) => x.includes(v) || out.push({ t: "+", field: label, text: v }));
  }
  if (x0.estimate !== y0.estimate && y0.estimate) out.push({ t: "+", field: "Estimate", text: `${x0.estimate || "–"} → ${y0.estimate}` });
  return out;
}
export function critStatus(c: Criterion): { id: string; label: string; icon: string } {
  const s = c.status;
  if (s === "met") return { id: "met", label: "Passed", icon: "check" };
  if (s === "not met" || s === "failed") return { id: "failed", label: "Failed", icon: "x" };
  if (s === "pending") return { id: "pending", label: "Pending", icon: "st-wait" };
  return { id: "untested", label: "Not tested", icon: "dots" };
}
