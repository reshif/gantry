/**
 * Pure flow logic ported from legacy/js/flow.js and the pure parts of sim.js / policy.js:
 * flow definition and routes per class, classification and the intake conversation, gate decisions
 * (N of M, author cannot approve, risk tags force human), slots, queue order, submit guard and move rules.
 */
import { DEFAULT_CATALOG, ONBOARD_STAGES, RISK_TAG_RULES } from "./catalog.js";
import { gateModeLock, requiredFor } from "./gates.js";
import { HOUR } from "./format.js";
import { actorName, can, effectiveStop, findPerson, findProject, findRepo, isFactoryAdmin, isOnCall, rolesIn } from "./policy.js";
import type { OverrideMarks, PolicyState } from "./policy.js";
import type {
  Approval, ApproverCondition, ApproverNeeds, ApproverRule, Bay, Brief, Catalog, Conversation, ConvMiss, ConvQuestion, Decision, DecisionRule, Gate, GateKind, GateInstance,
  Person, Priority, Project, Repo, Station, WorkClass, WorkOrder,
} from "./types.js";

/** Everything the flow functions read: the permission inputs plus full projects, repos, work orders and catalogue. */
export interface FlowState extends PolicyState {
  projects: Project[];
  repos: Repo[];
  workOrders: WorkOrder[];
  catalog: Catalog;
}

/* ------------------------------------------------------------------ catalogue lookups --- */

const cat = (s: { catalog?: Partial<Catalog> } | Catalog): Catalog => {
  const c = "catalog" in s ? (s.catalog as Partial<Catalog> | undefined) : (s as Catalog);
  return { ...DEFAULT_CATALOG, ...(c ?? {}) };
};

export function stationIndex(c: Catalog, id: string): number {
  return c.stations.findIndex((s) => s.id === id);
}
export function stationDef(c: Catalog, id: string): Station | null {
  return c.stations.find((s) => s.id === id) ?? null;
}
export function gateDef(c: Catalog, id: string): Gate | undefined {
  return c.gates.find((g) => g.id === id);
}
export function gateAfter(c: Catalog, stationId: string): Gate | null {
  return c.gates.find((g) => g.after === stationId) ?? null;
}
export function bayDef(c: Catalog, id: string): Bay | undefined {
  return c.bays.find((b) => b.id === id);
}
/** Station a work order is at (its `station` is an index into the catalogue). */
export function stationOf(c: Catalog, wo: Pick<WorkOrder, "station">): Station {
  return c.stations[wo.station] as Station;
}
export function classOf(c: Catalog, project: Project | null | undefined, clsId: string): WorkClass {
  const list = project?.flow?.classes ?? c.classes;
  return (list.find((x) => x.id === clsId) ?? c.classes.find((x) => x.id === clsId) ?? c.classes[0]) as WorkClass;
}
/** Classes enabled in a project. */
export function classesOf(c: Catalog, project: Project | null | undefined): WorkClass[] {
  const list = project?.flow?.classes ?? c.classes.filter((x) => !x.custom);
  return list.filter((x) => x.enabled !== false);
}

const defaultOrder = (c: Catalog) => c.stations.filter((s) => !s.custom).map((s) => s.id);

export interface FlowStation extends Station {
  enabled: boolean;
  wip: number;
  index: number;
}
export interface FlowGate extends Gate {
  enabled: boolean;
  mode: GateKind;
}
export interface FlowDefinition {
  stations: FlowStation[];
  active: FlowStation[];
  gates: FlowGate[];
  bays: Bay[];
  classes: WorkClass[];
}

/** Project flow as ordered definitions (legacy G.flowOf). */
export function flowOf(c: Catalog, project: Project | null | undefined): FlowDefinition {
  const f = project?.flow;
  const order = f?.order ?? defaultOrder(c);
  const stations: FlowStation[] = [];
  for (const id of order) {
    const d = stationDef(c, id);
    if (!d) continue;
    const cfg = f?.stations[id] ?? { enabled: true, wip: 5 };
    stations.push({ ...d, enabled: id === "intake" ? true : !!cfg.enabled, wip: cfg.wip, index: stationIndex(c, id) });
  }
  const gates: FlowGate[] = [];
  for (const st of stations) {
    const g = gateAfter(c, st.id);
    if (!g) continue;
    const cfg = f?.gates[g.id] ?? { enabled: true, mode: g.kind };
    gates.push({ ...g, enabled: !!cfg.enabled && st.enabled, mode: cfg.mode || g.kind });
  }
  const bayIds = f?.bays ?? c.bays.filter((b) => !b.custom).map((b) => b.id);
  const bays = bayIds.map((id) => bayDef(c, id)).filter((b): b is Bay => !!b);
  return { stations, active: stations.filter((s) => s.enabled), gates, bays, classes: classesOf(c, project) };
}

/** The brief gate (G0+G1) is switched off in this project (a Factory Admin override). Intake itself is never off: the work order still enters there and the brief is written. */
export const briefGateOff = (project: Project | null | undefined): boolean => !!project?.flow && project.flow.gates.G0G1?.enabled === false && !project.flow.gates.G0G1.absent;

/** Ordered station ids a class travels in a project (follows project.flow.order and station toggles). */
export function route(c: Catalog, project: Project | null | undefined, clsId: string): string[] {
  const cl = classOf(c, project, clsId);
  const order = project?.flow?.order ?? defaultOrder(c);
  const out: string[] = [];
  for (const sid of order) {
    const cfg = project?.flow?.stations[sid];
    const on = sid === "intake" || !project || !project.flow || (cfg && cfg.enabled && !cfg.absent);
    if (on && !cl.skips.includes(sid)) out.push(sid);
    if (cl.endsAfter && sid === cl.endsAfter) break;
  }
  return out;
}

/** Gates a class must pass, in order. */
export function routeGates(c: Catalog, project: Project | null | undefined, clsId: string): string[] {
  const cl = classOf(c, project, clsId);
  const out: string[] = [];
  for (const sid of route(c, project, clsId)) {
    const g = gateAfter(c, sid);
    if (!g) continue;
    const cfg = project?.flow?.gates[g.id];
    // G0+G1 stays on the route even when switched off by an override: the work order still waits at Intake for its brief, and the runtime passes the gate by itself (briefGateOff) once the brief is written.
    if (project?.flow && (!cfg || cfg.absent || (!cfg.enabled && g.id !== "G0G1"))) continue;
    if (g.id === "G6" && cl.endsAfter) continue;
    if (cl.gates && cl.gates.length && g.id !== "G0G1" && !cl.gates.includes(g.id) && g.kind !== "auto") continue;
    out.push(g.id);
  }
  return out;
}

export function nextStationId(c: Catalog, project: Project | null | undefined, wo: Pick<WorkOrder, "cls" | "station">): string | null {
  const r = route(c, project, wo.cls);
  const cur = stationOf(c, wo).id;
  const i = r.indexOf(cur);
  return i >= 0 && i < r.length - 1 ? (r[i + 1] as string) : null;
}

/** The gate a work order waits behind at its current station, if its class passes it. */
export function gateForWO(c: Catalog, project: Project | null | undefined, wo: Pick<WorkOrder, "cls" | "station">): Gate | null {
  const g = gateAfter(c, stationOf(c, wo).id);
  if (!g) return null;
  return routeGates(c, project, wo.cls).includes(g.id) ? g : null;
}

/** Effective gate mode in a project: project.flow.gates[id].mode overrides the default kind. */
export function gateKind(c: Catalog, project: Project | null | undefined, gateId: string): GateKind {
  const g = gateDef(c, gateId);
  if (!g) return "human";
  const cfg = project?.flow?.gates[gateId];
  const mode = cfg?.mode || g.kind;
  // Runtime guard: a mode stored before a lock existed (or written around the API) never lowers a gate a person must decide. (The regulated-project rule is enforced on edits only.)
  // A locked mode a Factory Admin chose with a reason (recorded on the gate) is honoured, except where it is a correctness or G5 rule.
  if (cfg?.mode && mode !== "human" && gateModeLock(g, mode, null, { override: !!cfg.override?.mode }) !== null) return "human";
  return mode;
}

/* ------------------------------------------------------------------ classification ------ */

const KW: ReadonlyArray<readonly [string, RegExp, string]> = [
  ["hotfix", /\b(outage|prod(uction)? (is )?down|sev ?1|hotfix|main is red|urgent|p0)\b/i, "mentions an outage or urgent production fix"],
  ["security", /\b(cve|vulnerab|xss|injection|secret|auth(z|orization)? (gap|bypass)|patch .* parser)\b/i, "mentions a vulnerability or security fix"],
  ["spike", /\b(investigate|spike|explore|evaluate|research|feasibility)\b/i, "asks a question rather than a change"],
  ["epic", /\b(epic|centre|center|redesign|overhaul|migrate all|new service|multi-)\b/i, "is large enough to split into several work orders"],
  ["docs", /\b(docs?|readme|runbook|documentation)\b/i, "only changes documentation"],
  ["chore", /\b(bump|upgrade|dependency|dependencies|renovate|pin|tag all)\b/i, "is routine maintenance or a dependency change"],
  ["refactor", /\b(refactor|clean ?up|extract|rename|restructure)\b/i, "restructures code without changing behaviour"],
  ["bug", /\b(fix|bug|error|crash|broken|wrong|regression|incorrect|fails?)\b/i, "describes broken behaviour"],
  ["feature", /\b(add|support|new|expose|show|enable|allow)\b/i, "adds new behaviour"],
];

export interface Classification {
  cls: string;
  confidence: number;
  rationale: string;
  alternatives: string[];
}

/** Local keyword classifier (legacy G.classify). Project classes with classifier hints win when a hint matches. */
export function classify(c: Catalog, text: string, requested: string | null | undefined, project?: Project | null): Classification {
  const custom = project ? classesOf(c, project).filter((x) => x.hints && x.hints.length) : [];
  const ch = custom.find((x) => (x.hints as string[]).some((w) => new RegExp("\\b" + String(w).replace(/[^a-z0-9 -]/gi, "") + "\\b", "i").test(text)));
  if (ch) return { cls: ch.id, confidence: 0.88, rationale: "The request matches classifier hints for " + ch.name + " (" + (ch.hints as string[]).join(", ") + ").", alternatives: [] };
  const hits = KW.filter((k) => k[1].test(text));
  const top = hits[0] ?? (["feature", null, "has no strong signal; defaulting to Feature"] as const);
  const conf = hits.length === 0 ? 0.52 : hits.length === 1 ? 0.91 : Math.max(0.6, 0.86 - (hits.length - 2) * 0.07);
  let rationale = "The request " + top[2] + ".";
  if (hits.length > 1) rationale += " Also matched " + hits.slice(1, 3).map((h) => c.classes.find((x) => x.id === h[0])?.name ?? h[0]).join(", ") + ".";
  const out: Classification = { cls: top[0], confidence: +conf.toFixed(2), rationale, alternatives: hits.slice(1, 3).map((h) => h[0]) };
  if (requested && requested !== top[0]) out.rationale += " Submitter requested " + (c.classes.find((x) => x.id === requested)?.name ?? requested) + ".";
  return out;
}

/* ------------------------------------------------------------------ intake conversation - */

type WoText = Pick<WorkOrder, "title" | "description" | "cls">;

/**
 * No-model fallback only. Which gaps a brief has is the Intake agent's judgement (it reads the request, the repository and AGENTS.md), never a keyword check, so the
 * fallback finds none and says nothing about them.
 */
export function intakeMisses(_wo: WoText): ConvMiss[] {
  return [];
}

/**
 * The no-model fallback form: three plain fields, no agent voice and no canned answers (no chips). It is shown only when no Intake agent can talk (see `scripted` messages,
 * labelled "Rule-based (no agent)" by the page). With an agent, the agent decides what is missing and asks it in its own words.
 */
export function convQuestions(wo: Pick<WorkOrder, "cls" | "title" | "repo"> & { conv: Pick<Conversation, "misses"> }): ConvQuestion[] {
  void wo;
  return [
    { id: "scope", field: "scope", text: "Scope (form field, no agent is reading this request): what is in scope?", chips: [] },
    { id: "ac", field: "ac", text: "Acceptance (form field): how will we know it is done?", chips: [] },
    { id: "extra", field: "extra", text: "Note (form field): anything else to add? Leave it empty or write \"no\" if not.", chips: [] },
  ];
}

const FIELD_LABEL: Record<string, string> = { scope: "Scope", ac: "Acceptance", rollback: "Rollback", version: "Target release", testdata: "Test data", repro: "Reproduction", children: "Split", extra: "Note" };
const fieldLabel = (f: string) => FIELD_LABEL[f] ?? f;

/** Placeholders Gantry seeds into a brief before anyone has written it: dropping one is not taking away something a person wrote. */
export const BRIEF_SCAFFOLD_OUT = { spike: ["Code changes"], other: ["UI changes unless stated", "Data backfills unless stated"] } as const;
export const isBriefScaffold = (x: string): boolean => (BRIEF_SCAFFOLD_OUT.spike as readonly string[]).includes(x) || (BRIEF_SCAFFOLD_OUT.other as readonly string[]).includes(x);

/** The brief derived from the conversation so far (legacy G.buildBrief). */
export function buildBrief(c: Catalog, project: Project | null | undefined, wo: Pick<WorkOrder, "cls" | "title" | "conv">): Brief {
  const a = wo.conv.answers;
  const cls = c.classes.find((x) => x.id === wo.cls);
  const rt = project ? route(c, project, wo.cls) : [];
  const b: Brief = {
    goal: wo.title,
    scopeIn: a.scope ? [a.scope] : a.question ? [a.question] : [],
    scopeOut: wo.cls === "spike" ? [...BRIEF_SCAFFOLD_OUT.spike] : [...BRIEF_SCAFFOLD_OUT.other],
    ac: a.ac ? [a.ac] : [],
    risks: wo.conv.misses.filter((m) => !m.resolved).map((m) => m.text),
    open: wo.conv.done ? [] : wo.conv.questions.slice(wo.conv.qi).map((q) => q.text),
    decisions: wo.conv.decisions.map((d) => d.text),
    estimate: (cls ? cls.est : "M") + (wo.cls === "epic" ? " (split)" : ""),
    route: rt,
    // Children are authored by the Plan agent (or proposed by the Intake agent / edited by a person), never derived from a scripted answer.
    children: [],
  };
  if (a.rollback) b.risks.push("Rollback: " + a.rollback);
  return b;
}

/** Start the intake conversation for a work order. */
export function startConversation(
  c: Catalog,
  project: Project | null | undefined,
  wo: Pick<WorkOrder, "cls" | "title" | "description" | "repo" | "createdAt" | "clsConfidence" | "clsRationale">,
  awaiting?: string | null,
): { conv: Conversation; brief: Brief } {
  const misses = intakeMisses(wo);
  const cls = c.classes.find((x) => x.id === wo.cls);
  const conv: Conversation = { messages: [], qi: 0, answers: {}, misses, decisions: [], awaiting: awaiting || "submitter", done: false, raised: [], questions: [] };
  // Scripted notes are Gantry's, not an agent's: they are authored by "system" and marked scripted so the page can label them (and hide them when an agent talks).
  conv.messages.push({ from: "system", at: wo.createdAt, text: "Class: " + (cls ? cls.name : wo.cls) + ". " + wo.clsRationale, scripted: true });
  const qs = convQuestions({ cls: wo.cls, title: wo.title, repo: wo.repo, conv: { misses } });
  conv.questions = qs;
  conv.messages.push({ from: "system", at: wo.createdAt + 1000, text: "Fallback intake form (no agent is reading this request).", scripted: true });
  const q0 = qs[0] as ConvQuestion;
  conv.messages.push({ from: "system", at: wo.createdAt + 2000, text: q0.text, qid: q0.id, chips: q0.chips, scripted: true });
  return { conv, brief: buildBrief(c, project, { cls: wo.cls, title: wo.title, conv }) };
}

export type AnswerOutcome = { returned: true } | { note: true } | { next: boolean };

/** Record an answer. Returns a new conversation; the input is not modified. */
export function answerConversation(
  c: Catalog,
  project: Project | null | undefined,
  wo: Pick<WorkOrder, "cls" | "title" | "conv">,
  text: string,
  by: string,
  at: number,
): { conv: Conversation; brief: Brief; outcome: AnswerOutcome } {
  const conv: Conversation = structuredClone(wo.conv);
  const done = (outcome: AnswerOutcome) => ({ conv, brief: buildBrief(c, project, { cls: wo.cls, title: wo.title, conv }), outcome });
  const rq = conv.raised.find((x) => !x.answered);
  if (rq) {
    rq.answered = true;
    rq.answer = text;
    conv.messages.push({ from: by, at, text });
    conv.decisions.push({ text: rq.station + " question: " + text, by, at });
    const st = stationDef(c, rq.station);
    conv.messages.push({ from: st?.agent ?? "ag-intake", at: at + 500, text: "Thanks. Returning the work order to " + (st ? st.name : rq.station) + "." });
    return done({ returned: true });
  }
  if (conv.done) {
    conv.messages.push({ from: by, at, text });
    return done({ note: true });
  }
  const q = conv.questions[conv.qi] as ConvQuestion;
  conv.messages.push({ from: by, at, text });
  conv.answers[q.id] = text;
  const m = conv.misses.find((x) => x.id === q.id);
  if (m) m.resolved = true;
  if (q.id !== "extra" || !/^no\b/i.test(text)) conv.decisions.push({ text: fieldLabel(q.field) + ": " + text, by, at });
  conv.qi++;
  if (conv.qi < conv.questions.length) {
    const n = conv.questions[conv.qi] as ConvQuestion;
    conv.messages.push({ from: "system", at: at + 600, text: n.text, qid: n.id, chips: n.chips, scripted: true });
  } else {
    conv.done = true;
    // The submitter has answered everything: the brief now waits for an approver, not for the submitter.
    conv.awaiting = "approver";
    conv.messages.push({ from: "system", at: at + 600, scripted: true, text: "The brief is ready. Confirm it to pass G0+G1 and start the route, or decline it to the Declined bay." });
  }
  return done({ next: !conv.done });
}

export interface NewWorkOrderInput {
  /** Allocated by the caller (database sequence). */
  id: string;
  project: string;
  repo: string;
  title: string;
  description?: string;
  attachments?: unknown[];
  requestedCls?: string | null;
  forceCls?: string;
  priority?: Priority;
  source?: string;
  requestedBy: string;
  createdAt: number;
  awaiting?: string | null;
  paths?: string[];
  parent?: string | null;
  risk?: string;
}

/** The label on a class guessed by keywords before the Intake agent has read the request. */
export const PROVISIONAL_CLS_PREFIX = "Provisional rule-based keyword match (no agent has read the request yet; the Intake agent classifies it next, and this stands only if no model is usable). ";

/** Build a work order at Intake with its classification, gates and conversation (legacy G.buildWO, with the clock and id supplied). */
export function buildWorkOrder(c: Catalog, project: Project, o: NewWorkOrderInput): WorkOrder {
  const cl = classify(c, o.title + " " + (o.description || ""), o.requestedCls, project);
  // A person's explicit class is theirs and is kept; the keyword heuristic is only a first guess for requests that name none (an agent or a person may reclassify at Intake).
  const cls = o.forceCls || o.requestedCls || cl.cls;
  const chosen = !o.forceCls && !!o.requestedCls;
  const clsName = (id: string) => c.classes.find((x) => x.id === id)?.name ?? id;
  const classDef = classOf(c, project, cls);
  const created = o.createdAt;
  const gates: Record<string, GateInstance> = {};
  for (const g of routeGates(c, project, cls)) gates[g] = { status: "pending", approvals: [], rejections: [], checks: [] };
  const g0 = gates.G0G1;
  if (g0) g0.status = "waiting";
  const clsConfidence = chosen ? 1 : cl.confidence;
  const clsRationale = chosen
    ? "Chosen by the submitter: " + clsName(cls) + "." + (cl.cls !== cls ? " A rule-based keyword match (no agent read the request) would have said " + clsName(cl.cls) + "; the choice stands unless a person changes it." : "")
    : PROVISIONAL_CLS_PREFIX + cl.rationale;
  const base = {
    cls, title: o.title, description: o.description || "", repo: o.repo, createdAt: created, clsConfidence, clsRationale,
  };
  const { conv, brief } = startConversation(c, project, base, o.awaiting);
  return {
    id: o.id, project: o.project, repo: o.repo, title: o.title, description: o.description || "", attachments: o.attachments || [],
    cls, clsConfidence, clsRationale, clsSuggested: cl.cls, clsOverridden: null, requestedCls: o.requestedCls || null,
    priority: o.priority || classDef.priority, source: o.source || "console", requestedBy: o.requestedBy, createdAt: created,
    station: 0, state: "waiting", bay: null, bayReason: "", bayFrom: null, progress: 100, slot: null,
    history: [{ station: "intake", agent: "ag-intake", model: "", startedAt: created, endedAt: null, tokens: 0, cost: 0, outcome: null, note: "" }],
    gates, log: [{ at: created, who: o.requestedBy, text: "Submitted from " + (o.source || "console") + "." }],
    diff: { plus: 0, minus: 0, files: 0 }, tests: { passed: 0, failed: 0, added: 0 }, pr: null,
    blockReason: null, failReason: null, doneAt: null, killed: null, parent: o.parent || null, children: [], risk: o.risk || (project.regulated ? "high" : "normal"),
    paths: o.paths || [], slaDue: created + classOf(c, project, cls).slaH * HOUR, conv, brief,
  };
}

/* ------------------------------------------------------------------ risk tags ----------- */

/** Risk tags computed from changed file paths (spec 9.5). */
export function riskTagsFor(paths: readonly string[]): string[] {
  const tags = new Set<string>();
  for (const p of paths) for (const r of RISK_TAG_RULES) if (r.test.test(p)) tags.add(r.tag);
  return [...tags];
}

/** Risk tags on a work order: from its changed files (or declared paths) plus a `high` risk level. Any tag forces a human vote. */
export function riskTagsOf(wo: Pick<WorkOrder, "files" | "paths" | "risk">): string[] {
  const paths = wo.files && wo.files.length ? wo.files.map((f) => f.path) : wo.paths;
  const tags = riskTagsFor(paths);
  if (wo.risk === "high" && !tags.includes("high-risk")) tags.push("high-risk");
  return tags;
}
export function forcesHuman(wo: Pick<WorkOrder, "files" | "paths" | "risk">): boolean {
  return riskTagsOf(wo).length > 0;
}

/* ------------------------------------------------------------------ approver rules ------ */

const NO_RULE: ApproverRule = { roles: [], people: [], required: 1, sod: false, conditions: [], escalateH: 0, fallback: null };

/** Conditions of the gate's approver rule that apply to this work order. */
export function conditionsFor(project: Project, wo: Pick<WorkOrder, "cls" | "risk" | "paths" | "repo" | "title" | "files">, gateId: string): ApproverCondition[] {
  const rule = project.approvers[gateId];
  if (!rule) return [];
  const tags = riskTagsOf({ files: wo.files, paths: wo.paths, risk: wo.risk });
  return rule.conditions.filter((cd) => {
    if (cd.when.type === "class") return wo.cls === cd.when.value;
    if (cd.when.type === "risk") return wo.risk === cd.when.value || tags.includes(cd.when.value);
    if (cd.when.type === "path") {
      return (wo.paths || []).some((p) => p.indexOf(cd.when.value) === 0) || (wo.repo === "payments-api" && cd.when.value === "/payments" && /settlement|refund|charge/i.test(wo.title));
    }
    return false;
  });
}

function satisfies(person: Person, project: Project, needs: ApproverNeeds): boolean {
  const roles = rolesIn(person, project.id);
  const ok = needs.people.includes(person.id) || needs.roles.some((r) => roles.includes(r));
  return ok && (!needs.oncall || isOnCall({ projects: [project] }, person, project.id));
}

export interface GateProgress {
  have: number;
  need: number;
  unmet: ApproverCondition[];
  conds: ApproverCondition[];
  /** Every approval so far came from the requester (I4: never the sole approver). */
  onlyRequester: boolean;
  passes: boolean;
  /** Separation of duties is on and the author had voted: that vote is on record but does not count ("1 of 2 (the author's vote does not count)"). */
  authorExcluded: boolean;
}

/** N of M: approvals so far against the rule, unmet conditions, and I4. G0+G1 is the submitter's own confirmation, so I4 does not apply to it. */
export function gateProgress(project: Project, wo: Pick<WorkOrder, "cls" | "risk" | "paths" | "repo" | "title" | "files" | "gates" | "requestedBy">, gateId: string, people: Person[]): GateProgress {
  const rule = project.approvers[gateId] ?? { ...NO_RULE };
  const st = wo.gates[gateId] ?? { approvals: [] };
  const conds = conditionsFor(project, wo, gateId);
  // Separation of duties is judged when votes are counted, not only when one is cast: a vote the author made while it was off stays on record and stops counting once it is on.
  const sodNow = gateId !== "G0G1" && !!rule.sod;
  const sodCounted = sodNow ? st.approvals.filter((a) => a.by !== wo.requestedBy && (a.for ?? a.by) !== wo.requestedBy) : st.approvals;
  // N approvals are N different seats (S-53): a named approver and their stand-in fill one seat.
  const counted = sodCounted.filter((a, i) => sodCounted.findIndex((b) => (b.for ?? b.by) === (a.for ?? a.by)) === i);
  const authorExcluded = sodCounted.length !== st.approvals.length;
  const unmet = conds.filter((cd) => !counted.some((a) => {
    const pp = people.find((x) => x.id === a.by);
    return !!pp && satisfies(pp, project, cd.needs);
  }));
  // The count the server enforces: never below what this opening was opened with (tightening applies at once, loosening never approves waiting work, spec 9.3),
  // except where the rule lists this class: that override is the owner's setting and applies live.
  const classSet = !!rule.classRequired && Object.prototype.hasOwnProperty.call(rule.classRequired, wo.cls);
  const need = classSet ? requiredFor(rule, wo.cls) : Math.max(requiredFor(rule, wo.cls), Number((st as { openedRequired?: number }).openedRequired) || 0);
  const onlyRequester = gateId !== "G0G1" && counted.length > 0 && counted.every((a) => a.by === wo.requestedBy);
  return { have: counted.length, need, unmet, conds, onlyRequester, passes: counted.length >= need && !unmet.length && !onlyRequester, authorExcluded };
}

/**
 * The away person whose seat this voter would fill as their stand-in, or why no seat is open (S-53, S-54). A stand-in never votes for someone separation of
 * duties refuses on this work order (the author), and a seat already voted (by the away person) is not filled twice.
 */
function delegateSeat(state: FlowState, project: Project, rule: ApproverRule, approvals: Approval[], wo: Pick<WorkOrder, "requestedBy" | "id">, gateId: string, personId: string, now: number): { seat: Person | undefined; refused: string | null } {
  const cands = state.people.filter((x) => x.away && x.away.delegate === personId && x.away.from <= now && x.away.to > now && (rule.people.includes(x.id) || rule.roles.some((r) => rolesIn(x, project.id).includes(r))));
  let refused: string | null = null;
  for (const x of cands) {
    if (rule.sod && gateId !== "G0G1" && wo.requestedBy === x.id) { refused ??= "Separation of duties: " + x.name + " is the author of " + wo.id + ", so a stand-in cannot approve for them."; continue; }
    if (approvals.some((a) => (a.for ?? a.by) === x.id)) { refused ??= x.name + " already has a vote on this gate; a seat counts once, so their stand-in does not vote too."; continue; }
    return { seat: x, refused: null };
  }
  return { seat: undefined, refused };
}

/** The seat a vote fills: the away person the voter stands in for, only when no other way lets them in (their own seat otherwise). Null for the voter's own seat. */
export function delegatedSeat(state: FlowState, personId: string, wo: WorkOrder, gateId: string, now: number): string | null {
  const project = state.projects.find((p) => p.id === wo.project) as Project;
  const rule = project.approvers[gateId] ?? { ...NO_RULE };
  const person = findPerson(state, personId);
  if (!person) return null;
  const roles = rolesIn(person, project.id);
  if (rule.people.includes(personId) || rule.roles.some((r) => roles.includes(r))) return null;
  return delegateSeat(state, project, rule, wo.gates[gateId]?.approvals ?? [], wo, gateId, personId, now).seat?.id ?? null;
}

function deny(reason: string, needs?: string, rule?: string): Decision {
  const r: DecisionRule = { kind: "approver", id: rule || "APPROVERS", name: "Approver rules" };
  return { allowed: false, reason, needs: needs || "", rule: r };
}

/** May this person approve this gate on this work order right now? Adds approver rules on top of can(). */
export function gateDecision(state: FlowState, personId: string | null | undefined, wo: WorkOrder, gateId: string, now: number, opts: { override?: boolean } = {}): Decision {
  const marks: OverrideMarks = { kind: null };
  const d = gateDecisionCore(state, personId, wo, gateId, now, opts, marks);
  if (d.allowed && marks.kind) return { ...d, override: true, overrideKind: marks.kind };
  return d;
}

function gateDecisionCore(state: FlowState, personId: string | null | undefined, wo: WorkOrder, gateId: string, now: number, opts: { override?: boolean }, marks: OverrideMarks): Decision {
  const c = cat(state);
  const person = findPerson(state, personId);
  const project = state.projects.find((p) => p.id === wo.project) as Project;
  const g = gateDef(c, gateId);
  if (!person) return deny("Not signed in.");
  if (!g) return deny("Unknown gate.");
  if (gateKind(c, project, gateId) === "auto") return deny(g.label + " is automatic in " + project.name + "; it passes when its checks pass.", "Automatic gate", "AUTO");
  const st = wo.gates[gateId];
  if (!st || st.status !== "waiting") return deny(wo.id + " is not waiting at " + g.label + ".", "", "STATE");
  const stop = effectiveStop(state, { project: project.id, repo: wo.repo, wo });
  if (stop) {
    // Owner decision 2026-11-19: a Factory Admin may approve a gate during a halt with a reason ("Approve anyway"); a kill, and everyone else, stay blocked.
    if (stop.mode === "halt" && isFactoryAdmin(state, personId as string)) {
      if (!opts.override) return { ...deny(stop.reason, "override_reason", "HALT"), override: true, overrideKind: "halt" as const };
      marks.kind = "halt";
    } else return deny(stop.reason, stop.mode === "halt" ? "Resume first" : "Restore first", stop.mode === "halt" ? "HALT" : "KILL");
  }

  if (gateId === "G0G1") {
    const d0 = can(state, personId, "brief.confirm", { project: project.id, time: now, ...(opts.override ? { override: true } : {}) });
    if (!d0.allowed) return d0;
    if (d0.overrideKind) marks.kind = d0.overrideKind;
    const roles0 = rolesIn(person, project.id);
    const senior = roles0.some((r) => ["line_lead", "project_admin", "factory_admin"].includes(r));
    if (!senior && wo.requestedBy !== personId) return deny("Engineers may confirm only briefs they submitted. " + actorName(state, wo.requestedBy) + " submitted this one.", "Submitter, Line Lead or Project Admin", "APR-G0G1");
    if (!wo.conv.done) return deny("The intake conversation still has open questions.", "Answer the open questions first", "APR-G0G1");
    return { allowed: true, reason: wo.requestedBy === personId ? "You submitted this work order." : "Line Leads and Project Admins may confirm any brief.", rule: { kind: "approver", id: "APR-G0G1", name: "Brief confirmation" }, needs: "" };
  }

  const base = can(state, personId, g.action || "gate.approve", { project: project.id, repo: wo.repo, time: now, ...(opts.override ? { override: true } : {}) });
  if (!base.allowed) return base;
  if (base.overrideKind) marks.kind = base.overrideKind;
  const rule = project.approvers[gateId] ?? { ...NO_RULE };
  if (st.approvals.some((a) => a.by === personId)) return deny("You already approved " + g.label + " on " + wo.id + ".", "Another approver", "APR-" + gateId);
  if (st.approvals.some((a) => a.for === personId)) return deny("Your stand-in already approved " + g.label + " on " + wo.id + " for you; a seat counts once.", "Another approver", "APR-" + gateId);
  const roles = rolesIn(person, project.id);
  const aprRule: DecisionRule = { kind: "approver", id: "APR-" + gateId, name: g.label + " approvers" };
  // Factory Admin is universal (owner decision 2026-11-19): a normal approver on every gate. Only the author under separation of duties (or the
  // author alone, I4) is outside the ordinary rule: the API turns that vote into a break-glass override that needs a reason and is audited.
  if (roles.includes("factory_admin")) {
    const own = wo.requestedBy === personId;
    return { allowed: true, reason: "Factory Admin may approve any gate" + (own && rule.sod ? ", including their own work order" : "") + (own && rule.sod ? " (break-glass override: needs a reason and is flagged in audit)." : "."), rule: aprRule, needs: "" };
  }
  if (rule.sod && wo.requestedBy === personId) return deny("Separation of duties on " + g.label + ": the author of " + wo.id + " cannot approve it.", "Someone other than the author", "APR-" + gateId);
  const byRole = rule.roles.some((r) => roles.includes(r));
  const byName = rule.people.includes(personId as string);
  const delegation = delegateSeat(state, project, rule, st.approvals, wo, gateId, personId as string, now);
  const delegateFor = delegation.seat;
  const conds = conditionsFor(project, wo, gateId);
  const byCond = conds.find((cd) => satisfies(person, project, cd.needs));
  // Once the gate has waited past its escalation limit the rule's fallback approver (the project owner when none is named) may approve it. Only after escalation, and still under
  // can() and separation of duties above: the fallback gains no right to approve that the person's own roles do not give.
  const fallbackId = st.escalated ? rule.fallback ?? project.owner : null;
  const byFallback = !!fallbackId && fallbackId === personId;
  if (!byRole && !byName && !delegateFor && !byCond && !byFallback) {
    if (delegation.refused) return deny(delegation.refused, "Someone who is not the author's stand-in", "APR-" + gateId);
    const cn = conds.filter((cd) => cd.needs.oncall && cd.needs.roles.some((r) => roles.includes(r)));
    const roleList = (rs: string[]) => rs.map((r) => state.catalog.roles.find((x) => x.id === r)?.name ?? r).join(" or ");
    if (cn.length && !isOnCall({ projects: [project] }, person, project.id)) return deny((cn[0] as ApproverCondition).text + "; " + person.name + " is not on call.", "On-call " + roleList((cn[0] as ApproverCondition).needs.roles), "APR-" + gateId);
    return deny(
      "Approver rule for " + g.label + " on " + project.name + " lists " + (rule.roles.length ? roleList(rule.roles) : "no roles") + (rule.people.length ? " and " + rule.people.map((p) => actorName(state, p)).join(", ") : "") + ".",
      "Needs " + (rule.roles.length ? roleList(rule.roles) : rule.people.map((p) => actorName(state, p)).join(", ")),
      "APR-" + gateId,
    );
  }
  /* I4: with separation of duties off the requester may vote, but never alone. Their vote is accepted; the gate needs someone else too (see gateProgress). */
  const why = byName ? "Named approver for " + g.label + "." : byRole ? "Approver rule allows " + rule.roles.map((r) => state.catalog.roles.find((x) => x.id === r)?.name ?? r).join(" or ") + "." : delegateFor ? "Delegate for " + delegateFor.name + " while they are away." : byCond ? "Meets condition: " + (byCond as ApproverCondition).text + "." : "Fallback approver for " + g.label + ": the gate has waited past its escalation limit.";
  return { allowed: true, reason: why + (base.rule.kind === "policy" ? " " + base.reason : ""), rule: aprRule, needs: "" };
}

/* ------------------------------------------------------------------ slots, queue -------- */

/** Work orders holding a coding slot in a project. */
export function slotsUsed(workOrders: readonly WorkOrder[], projectId: string): WorkOrder[] {
  return workOrders.filter((w) => w.project === projectId && w.slot && w.state !== "done" && w.state !== "killed");
}

/** Lowest free coding slot (1-based) or null. */
export function freeSlot(workOrders: readonly WorkOrder[], project: Pick<Project, "id" | "flow">): number | null {
  const used = slotsUsed(workOrders, project.id).map((w) => w.slot);
  for (let i = 1; i <= project.flow.slots; i++) if (!used.includes(i)) return i;
  return null;
}

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Deterministic queue order (spec 9.6): priority, then age (longest in the bay first), then id. Returns a new array. */
export function queueOrder(wos: readonly WorkOrder[]): WorkOrder[] {
  return wos.slice().sort((a, b) =>
    (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
    || (a.bayAt ?? a.createdAt) - (b.bayAt ?? b.createdAt)
    || a.createdAt - b.createdAt
    || a.id.localeCompare(b.id));
}

/** The queued work orders of a project in dispatch order. */
export function queuedFor(workOrders: readonly WorkOrder[], projectId: string): WorkOrder[] {
  return queueOrder(workOrders.filter((w) => w.project === projectId && w.bay === "queue" && !w.heldByKill));
}

/* ------------------------------------------------------------------ submit guard -------- */

/** Why a submission to (project, repo) is refused, or null (legacy G.submitGuard). */
export function submitGuard(state: FlowState, projectId: string, repoId: string | null | undefined): string | null {
  const project = findProject(state, projectId);
  if (!project) return "Pick a project.";
  const stop = effectiveStop(state, { project: projectId, repo: repoId ?? null });
  if (stop) return "Submissions are refused. " + stop.reason;
  const repo = findRepo(state, repoId) as Repo | undefined;
  if (!repo || repo.project !== projectId) return "Pick a repo in " + project.name + ".";
  if (repo.onboarding.stage !== "ready" && !repo.onboarding.exception) {
    const stages = [...ONBOARD_STAGES, { id: "failed", name: "Failed" }, { id: "person", name: "Needs a person" }];
    return repo.name + " is not ready: onboarding is at '" + (stages.find((x) => x.id === repo.onboarding.stage)?.name ?? repo.onboarding.stage) + "'. Finish onboarding first (#onboarding).";
  }
  return null;
}

/* ------------------------------------------------------------------ moves --------------- */

export interface MoveCheck {
  allowed: boolean;
  reason: string;
  kind?: "park" | "unpark" | "back" | "approve";
}

/**
 * Dry-run of a move to a station or bay (legacy G.moveCheck; spec 9.4 `move` with `dry_run`).
 * `principalId` is the person who would perform it.
 */
export function moveCheck(state: FlowState, principalId: string | null | undefined, wo: WorkOrder, target: string, now: number): MoveCheck {
  const c = cat(state);
  const project = state.projects.find((p) => p.id === wo.project) as Project;
  const why = (d: Decision) => (d.needs ? d.needs + ". " : "") + d.reason;
  /* scope stops first; a killed work order itself is reported by the state check below */
  const stop = effectiveStop(state, { project: wo.project, repo: wo.repo });
  if (stop) return { allowed: false, reason: stop.reason };
  if (wo.state === "killed" || wo.state === "done") return { allowed: false, reason: wo.id + " is " + wo.state + "." };
  const bay = bayDef(c, target);
  if (bay) {
    if (project.flow.bays && !project.flow.bays.includes(target)) return { allowed: false, reason: bay.name + " is not a bay in " + project.name + "." };
    if (wo.bay === target) return { allowed: false, reason: "Already in " + bay.name + "." };
    const perm = target === "declined" ? "wo.decline" : "wo.park";
    const d = can(state, principalId, perm, { project: wo.project, time: now });
    if (!d.allowed) return { allowed: false, reason: why(d) };
    if (target === "queue" && stationOf(c, wo).id !== "build" && nextStationId(c, project, wo) !== "build") return { allowed: false, reason: "Only work about to build can wait in the Queue." };
    return { allowed: true, kind: "park", reason: "Moves to " + bay.name + " with a reason." };
  }
  const r = route(c, project, wo.cls);
  const stName = (id: string) => stationDef(c, id)?.name ?? id;
  if (!r.includes(target)) {
    const cfg = project.flow.stations[target];
    return { allowed: false, reason: stName(target) + " is not on the " + (classOf(c, project, wo.cls).name) + " route" + (cfg && cfg.enabled ? "" : " (station is off or absent in this project)") + "." };
  }
  const cur = stationOf(c, wo).id;
  if (wo.bay) {
    if (target !== (wo.bayFrom || cur)) return { allowed: false, reason: "From " + (bayDef(c, wo.bay)?.name ?? wo.bay) + " it can only return to " + stName(wo.bayFrom || cur) + "." };
    const du = can(state, principalId, "wo.park", { project: wo.project, time: now });
    return du.allowed ? { allowed: true, kind: "unpark", reason: "Returns to " + stName(target) + "." } : { allowed: false, reason: why(du) };
  }
  const ci = r.indexOf(cur);
  const ti = r.indexOf(target);
  if (ti === ci) return { allowed: false, reason: "Already at " + stName(target) + "." };
  if (ti < ci) {
    const db = can(state, principalId, "wo.sendback", { project: wo.project, time: now });
    return db.allowed ? { allowed: true, kind: "back", reason: "Sends back to " + stName(target) + "." } : { allowed: false, reason: why(db) };
  }
  if (ti > ci + 1) return { allowed: false, reason: "Work moves one station at a time; " + stName(r[ci + 1] as string) + " comes first." };
  const g = gateForWO(c, project, wo);
  if (wo.state === "running") return { allowed: false, reason: "Still running at " + stName(cur) + "; it moves when the station finishes" + (g ? " and " + g.label + " passes" : "") + "." };
  if (!g) return { allowed: false, reason: "It moves automatically when the station finishes." };
  if (gateKind(c, project, g.id) === "auto") return { allowed: false, reason: g.label + " is automatic in this project; it passes when its checks pass." };
  const dg = gateDecision(state, principalId, wo, g.id, now);
  if (!dg.allowed) return { allowed: false, reason: g.label + ": " + why(dg) };
  return { allowed: true, kind: "approve", reason: "Approves " + g.label + " " + g.name + "." };
}

