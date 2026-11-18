/**
 * The Review station's verdict (findings 15, 16, 17): the agent's per-criterion verdict, its findings and its pull request description are recorded on the work
 * order (`data.review`), and the verdict is enforced. Code reads what the agent said; it does not write the review. "Changes requested" never waits at the gate:
 * the work order goes back to the station the agent names (Build by default) with the findings, or to Needs a person when it keeps coming back.
 */
import { route, stationDef, type Project } from "@gantry/domain";
import { job } from "../../core/jobs-contract.js";
import { stationIdOf, type Fx } from "./engine.js";
import { sendBackCore } from "./moves.js";
import type { Wo } from "./model.js";

export interface ReviewCriterion { criterion: string; result: "pass" | "fail" | "untested"; evidence: string }
export interface ReviewFinding { severity: string; file: string; line: number | null; issue: string; fix: string }
export interface ReviewRecord {
  verdict: "approve" | "changes_requested" | "none";
  /** What the agent wrote, before any cross-check. */
  reported: string;
  criteria: ReviewCriterion[];
  findings: ReviewFinding[];
  notes: string;
  sendBackTo: string | null;
  description: { title: string | null; body: string } | null;
  headSha: string | null;
  attempt: string;
  at: number;
}

/** After this many automatic send-backs from Review a person decides (the agent and the builder disagree, or the fix does not land). */
export const MAX_REVIEW_SENDBACKS = 2;

const str = (v: unknown, max = 4000): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const FAIL = /^(fail(ed|s)?|not[ _-]?(met|covered|satisfied|done|implemented)|unmet|missing|no|false|unsatisfied|violated)$/i;
const PASS = /^(pass(ed|es)?|met|ok|covered|satisfied|done|yes|true|implemented)$/i;

export function parseReview(out: Record<string, unknown>, o: { attempt: string; headSha: string | null; now: number }): ReviewRecord {
  const reported = str(out.verdict, 60).toLowerCase().replace(/[\s-]+/g, "_");
  const criteria: ReviewCriterion[] = (Array.isArray(out.criteria) ? out.criteria : []).map(obj).map((x) => {
    const r = str(x.result ?? x.verdict ?? x.status, 40);
    return { criterion: str(x.criterion ?? x.text, 600), result: (FAIL.test(r) ? "fail" : PASS.test(r) ? "pass" : "untested") as ReviewCriterion["result"], evidence: str(x.evidence ?? x.note, 1200) };
  }).filter((c) => c.criterion);
  const findings: ReviewFinding[] = (Array.isArray(out.findings) ? out.findings : []).map(obj).map((x) => ({
    severity: str(x.severity, 20).toLowerCase() || "minor", file: str(x.file, 300), line: Number.isFinite(Number(x.line)) && x.line !== null && x.line !== "" ? Number(x.line) : null, issue: str(x.issue ?? x.text, 1500), fix: str(x.fix, 1500),
  })).filter((f) => f.issue).slice(0, 50);
  const body = str(out.pullRequestDescription ?? out.prDescription, 20000);
  const title = str(out.pullRequestTitle ?? out.prTitle, 200);
  const approved = reported === "approve" || reported === "approved";
  const asked = ["changes_requested", "request_changes", "changes_required", "reject", "rejected", "block", "blocked"].includes(reported);
  // The agent's own per-criterion verdict counts: an "approve" next to a criterion it marked failed is a request for changes.
  const criterionFailed = criteria.some((c) => c.result === "fail");
  const verdict: ReviewRecord["verdict"] = asked || (approved && criterionFailed) ? "changes_requested" : approved ? "approve" : reported ? "changes_requested" : "none";
  return {
    verdict, reported, criteria, findings, notes: str(out.reviewNotes ?? out.notes, 8000), sendBackTo: str(out.sendBackTo ?? out.returnTo, 60).toLowerCase() || null,
    description: body ? { title: title || null, body } : null, headSha: o.headSha, attempt: o.attempt, at: o.now,
  };
}

export const reviewOf = (w: Wo): ReviewRecord | null => (w.data.review && typeof w.data.review === "object" ? (w.data.review as ReviewRecord) : null);

/** The findings as the text the station that gets the work back reads. */
export function reviewText(rv: ReviewRecord): string {
  const lines = [
    rv.notes || "Review asked for changes.",
    ...rv.criteria.filter((c) => c.result !== "pass").map((c) => `- Criterion ${c.result === "fail" ? "not met" : "untested"}: ${c.criterion}${c.evidence ? ` (${c.evidence})` : ""}`),
    ...rv.findings.map((f) => `- [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : ""}${f.issue}${f.fix ? ` Fix: ${f.fix}` : ""}`),
  ];
  return lines.join("\n").slice(0, 8000);
}

/** The pull request description job: the work order's PR is updated through the GitHub service (deduped per attempt, so a re-run of Review updates it again). */
export function queueDescribe(fx: Fx, w: Wo, rv: ReviewRecord): void {
  if (rv.description) fx.jobs.push(job("pr.describe", { woId: w.id, attemptId: rv.attempt }, { dedupeKey: `pr.describe:${w.id}:${rv.attempt}` }));
}

/**
 * Enforces the verdict after Review's result is recorded. Returns where the work order went. "approve" and "none" open the gate as before (the gate card shows
 * the verdict); "changes_requested" goes back to the station the agent named, or to Needs a person.
 */
export async function enforceReview(fx: Fx, w: Wo, project: Project, rv: ReviewRecord, by: string, parkPerson: (reason: string) => Promise<void>): Promise<"gate" | "sent_back" | "person"> {
  if (rv.verdict !== "changes_requested") return "gate";
  const r = route(fx.catalog, project, w.cls);
  const here = stationIdOf(fx.catalog, w);
  const named = rv.sendBackTo && r.includes(rv.sendBackTo) && r.indexOf(rv.sendBackTo) <= r.indexOf(here) ? rv.sendBackTo : null;
  const target = named ?? (r.includes("build") && r.indexOf("build") <= r.indexOf(here) ? "build" : null);
  const prior = (Array.isArray(w.data.sendbacks) ? (w.data.sendbacks as Array<{ from?: string; by?: string; review?: boolean }>) : []).filter((s) => s.review && s.from === here).length;
  const name = stationDef(fx.catalog, here)?.name ?? here;
  if (!target) {
    await parkPerson(`${name} requested changes and this route has no earlier station to send the work to. Findings: ${reviewText(rv).slice(0, 600)}`);
    return "person";
  }
  if (prior >= MAX_REVIEW_SENDBACKS) {
    await parkPerson(`${name} has requested changes ${prior + 1} times; a person needs to decide. Latest findings: ${reviewText(rv).slice(0, 600)}`);
    return "person";
  }
  await sendBackCore(fx, w, project, here, target, reviewText(rv), "system", { review: true, round: prior + 1, agent: by });
  return "sent_back";
}

