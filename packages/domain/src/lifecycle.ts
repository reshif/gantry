/**
 * Pure derivations over the work order lifecycle record (legacy/js/lifecycle.js, G.lc).
 *
 * The legacy module also *generated* the record (plan, commits, files, tests) deterministically from the
 * title. That was simulation and is not ported: in the product the record is written by real station
 * outputs. What remains here is what reads the record: acceptance criteria from the brief, completeness of
 * the sections, the plain-language summary, and the request and brief-version snapshots taken at intake and
 * confirmation.
 */
import { MIN, fmt } from "./format.js";
import { actorName } from "./policy.js";
import type { PolicyState } from "./policy.js";
import type { Agent, ApiKey, BriefVersion, Catalog, Criterion, IntegrationInstance, IntegrationType, Project, Trigger, WorkOrder, WoRequest } from "./types.js";
import { DEFAULT_CATALOG } from "./catalog.js";

const STOP_WORDS = new Set(["add", "fix", "the", "for", "and", "with", "to", "on", "in", "of", "a", "an", "new", "show", "support", "expose", "emit", "upgrade", "bump", "patch", "retry", "rate", "limit", "split", "extract", "into", "from", "over", "after", "when", "by", "per", "all"]);

/** The one-word subject of a work order (first significant word of the title, singular). */
export function topic(wo: Pick<WorkOrder, "title">): string {
  const words = wo.title.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  return (words[0] || "change").replace(/s$/, "");
}

/**
 * Whether a GitHub check run is the repository's required check. A required name is written as the status context ("ci/test", "ci / test") but a check
 * run reports only its job name ("test"), so the two match when they are equal or when the run's name is the last segment of the required one.
 */
export function checkMatches(required: string, checkName: string): boolean {
  const n = (x: string): string => x.toLowerCase().replace(/\s*\/\s*/g, "/").trim();
  const r = n(required);
  const c = n(checkName);
  return r === c || r.endsWith("/" + c);
}

/** What Verify reported for each criterion (agent-reported, recorded by the station), and the test runs it listed. */
export interface Verification {
  criteria?: Array<{ criterion: string; result: string; evidence?: string }>;
  testsRun?: Array<{ name: string; command?: string; result: string; ms?: number }>;
  /** The failed-test count the platform itself observed (not the agent's), when it observed one. */
  observedFailed?: number;
}

const VERDICT: Record<string, string> = { pass: "met", passed: "met", met: "met", fail: "not met", failed: "not met", "not met": "not met" };
const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Acceptance criteria derived from the confirmed brief and the class. With Verify's recorded report, each criterion carries its verdict
 * ("met", "not met", otherwise "not tested") and the test runs its evidence names. A verdict is matched by the criterion's text, else by its
 * position among the brief's criteria; a criterion Verify did not mention stays "not tested".
 */
export function criteriaFor(wo: Pick<WorkOrder, "brief" | "cls">, verification?: Verification | null): Criterion[] {
  const b = wo.brief;
  const list: string[] = [];
  const fromBrief = b && b.ac && b.ac.length ? b.ac.length : 0;
  for (const t of b && b.ac && b.ac.length ? b.ac : ["New behaviour covered by tests"]) list.push(t);
  list.push("Existing behaviour unchanged (regression suite green)");
  if (wo.cls === "hotfix" || wo.cls === "security") list.push("Fix verified in staging before release");
  else if (wo.cls === "feature" || wo.cls === "epic") list.push("Change documented in the changelog and API reference");
  else if (wo.cls === "docs") list.push("Reviewed by the owning team");
  const reported = Array.isArray(verification?.criteria) ? verification!.criteria! : [];
  const runs = Array.isArray(verification?.testsRun) ? verification!.testsRun! : [];
  return list.map((text, i) => {
    const v = reported.find((r) => typeof r?.criterion === "string" && norm(r.criterion) === norm(text)) ?? (i < Math.max(fromBrief, 1) ? reported[i] : undefined);
    const named = v && typeof v.evidence === "string" ? runs.filter((r) => typeof r?.name === "string" && r.name && v.evidence!.includes(r.name)) : [];
    let status = v ? (VERDICT[String(v.result).toLowerCase()] ?? "not tested") : "not tested";
    // The verdict is the agent's; the runs are evidence. A "met" is not kept when a run its own evidence names failed, nor when the platform observed
    // failing tests and no run named for the criterion passed: it drops to "not met" in the first case and "not tested" (unconfirmed) in the second.
    if (status === "met" && named.some((r) => r.result !== "pass")) status = "not met";
    else if (status === "met" && (verification?.observedFailed ?? 0) > 0 && !named.some((r) => r.result === "pass")) status = "not tested";
    const tests = named.map((r) => ({ name: r.name, result: r.result === "pass" ? "pass" : "fail", ms: Number.isFinite(r.ms) ? Math.max(0, Math.round(r.ms as number)) : 0 }));
    return { id: "AC-" + (i + 1), text, status, tests };
  });
}

/** The request snapshot a work order carries (what was asked, by whom, through which channel). */
export function requestOf(wo: Pick<WorkOrder, "title" | "description" | "source" | "requestedBy" | "submittedBy" | "createdAt" | "attachments" | "requestedCls">): WoRequest {
  return { title: wo.title, text: wo.description, source: wo.source, by: wo.requestedBy, via: wo.submittedBy || null, at: wo.createdAt, attachments: (wo.attachments || []).slice(), requestedCls: wo.requestedCls || null };
}

/** Brief version 1, recorded when G0+G1 passes. Null before confirmation or when already recorded. */
export function confirmedBriefVersion(wo: Pick<WorkOrder, "gates" | "briefVersions" | "brief" | "requestedBy" | "createdAt">): BriefVersion | null {
  const g = wo.gates.G0G1;
  if (!g || g.status !== "passed" || (wo.briefVersions && wo.briefVersions.length)) return null;
  const a = g.approvals[0] ?? { by: wo.requestedBy, at: wo.createdAt + 20 * MIN };
  return { v: 1, at: a.at, by: a.by, note: "Confirmed at G0+G1", brief: structuredClone(wo.brief) };
}

export interface Completeness {
  sections: Record<string, boolean>;
  done: number;
  total: number;
}

/** Completeness of the record sections (the meter on #record). */
export function completeness(wo: WorkOrder): Completeness {
  const s: Record<string, boolean> = {
    summary: true,
    request: !!wo.request,
    clarification: !!(wo.conv && wo.conv.messages.length),
    agreement: (wo.briefVersions ?? []).length > 0,
    stations: wo.history.some((e) => !!e.summary),
    changes: (wo.commits ?? []).length > 0,
    verification: (wo.criteria ?? []).some((c) => c.tests.length),
    merge: !!(wo.pr && wo.pr.state === "merged"),
    approvals: Object.keys(wo.gates).some((k) => {
      const g = wo.gates[k];
      return !!g && (g.approvals.length > 0 || !!g.decision);
    }),
    after: (wo.outcomes ?? []).length > 0,
    timeline: true,
  };
  const keys = Object.keys(s);
  return { sections: s, done: keys.filter((k) => s[k]).length, total: keys.length };
}

export interface SummaryContext extends PolicyState {
  projects: Project[];
  catalog: Catalog;
  agents?: Agent[];
  apiKeys?: ApiKey[];
  triggers?: Trigger[];
  integrationTypes?: IntegrationType[];
  integrationInstances?: IntegrationInstance[];
}

const SOURCE_LABELS: Record<string, string> = {
  ui: "the web app", web: "the web app", console: "the console", slack: "Slack", teams: "Microsoft Teams", github: "GitHub", gitlab: "GitLab",
  api: "the API", schedule: "a schedule", epic: "an epic split", trigger: "a trigger", email: "email",
};

/** Readable name of a work order source (a channel, an integration type or an instance id). */
export function sourceLabel(ctx: Pick<SummaryContext, "integrationTypes" | "integrationInstances">, src: string | null | undefined): string {
  if (src && SOURCE_LABELS[src]) return SOURCE_LABELS[src] as string;
  const inst = ctx.integrationInstances?.find((i) => i.id === src);
  if (inst) return inst.name;
  const t = ctx.integrationTypes?.find((x) => x.id === src);
  if (t) return t.name;
  return src || "the web app";
}

const sum = (wo: WorkOrder, k: "plus" | "minus") => (wo.files ?? []).reduce((t, f) => t + f[k], 0);

/** Plain-language summary paragraph of a work order (legacy `summaryText`). */
export function summaryText(ctx: SummaryContext, wo: WorkOrder): string {
  const c = { ...DEFAULT_CATALOG, ...ctx.catalog };
  const p = ctx.projects.find((x) => x.id === wo.project);
  const st = c.stations[wo.station];
  const asked = actorName(ctx, wo.requestedBy);
  const clsName = c.classes.find((x) => x.id === wo.cls)?.name ?? wo.cls;
  const bay = wo.bay ? c.bays.find((b) => b.id === wo.bay) : undefined;
  const commits = wo.commits ?? [];
  const files = wo.files ?? [];
  const state =
    wo.state === "done"
      ? "It shipped" + (wo.pr && wo.pr.tag ? " as " + wo.pr.tag : "") + (wo.doneAt ? " on " + fmt.stamp(wo.doneAt) : "") + "."
      : wo.state === "killed"
        ? "It was killed: " + (wo.killed ? wo.killed.reason : "") + "."
        : wo.bay
          ? "It is in " + (bay ? bay.name : wo.bay) + (wo.bayReason ? " (" + wo.bayReason + ")" : "") + "."
          : "It is " + (wo.state === "waiting" ? "waiting at a gate after " : wo.state + " at ") + (st ? st.name : "a station") + ".";
  const delivered = commits.length
    ? " The change touches " + files.length + " files (+" + sum(wo, "plus") + " −" + sum(wo, "minus") + ") in " + commits.length + " commits" + (wo.pr && wo.pr.number ? ", PR #" + wo.pr.number : "") + "."
    : "";
  const met = (wo.criteria ?? []).filter((x) => x.status === "met").length;
  return (
    asked + " asked for \"" + wo.title + "\" in " + (p ? p.name : wo.project) + " (" + wo.repo + ") via " + sourceLabel(ctx, wo.sourceIntegration || wo.source) + ". Gantry classified it as " + clsName + "." +
    delivered + (wo.criteria ? " " + met + " of " + wo.criteria.length + " acceptance criteria are met." : "") + " " + state
  );
}

/** Total tokens and cost across a work order's station visits. */
export function woTotals(wo: Pick<WorkOrder, "history">): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const e of wo.history) {
    tokens += e.tokens;
    cost += e.cost;
  }
  return { tokens, cost };
}
