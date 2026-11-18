/** Work order reads for the fidelity harness: the traveler read, the record and the changes of every work order in the plant. */
import { DEFAULT_CATALOG } from "@gantry/domain";
import { fulfillJson, type Handler } from "./fixtures";

const NOW = Date.parse("2026-01-15T10:00:00Z");
const MIN = 60_000;
type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BRIEF = {
  goal: "Rate limits apply per merchant, not per account, with a safe rollback.",
  scopeIn: ["Per-merchant sliding window limiter", "429 with a Retry-After header", "Config default of 60 per minute"],
  scopeOut: ["Per-endpoint limits"], ac: ["Requests over the limit return HTTP 429 with a Retry-After header.", "The limit is configurable per merchant, default 60 per minute.", "Limits reset on a sliding window; no burst above 1.2x the limit."],
  risks: ["Clock skew between workers"], open: [], decisions: ["Counters live in Redis"], estimate: "M", route: [], children: [],
};
const CRITERIA = BRIEF.ac.map((text, i) => ({ id: `AC-${i + 1}`, text, status: "met", tests: [{ name: ["limiter_429", "config_default", "window_slide"][i], result: "pass", ms: 40 + i * 12 }] }));

/** ops1: what the server says about the person deciding a gate on one work order (eligibility, votes), for the approval dialog. */
export interface Ops1Approve { allowed: boolean; reason: string; have: number; need: number; approvals?: Array<{ name: string }>; eligible?: Array<{ id: string; name: string; why: string; away: boolean; oncall: boolean }> }

export function woReadOverrides(wos: Loose[], projectId: string, approveOf: Record<string, Ops1Approve> = {}): Record<string, Handler> {
  const ov: Record<string, Handler> = {};
  const cat = DEFAULT_CATALOG;
  for (const w of wos) {
    const gate = Object.entries(w.gates ?? {}).find(([, g]: [string, any]) => g.status === "waiting")?.[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
    const rt = cat.stations.map((s) => s.id);
    const can: Loose = {};
    for (const k of ["answer", "classify", "decline", "park", "sendback", "reassign", "move", "confirm", "summary"]) can[k] = { allowed: true, reason: "", needs: "" };
    const moves: Loose = {};
    for (const sid of rt) moves[sid] = { allowed: true, reason: "", kind: "back" };
    for (const b of cat.bays) moves[b.id] = { allowed: true, reason: `Moves to ${b.name}.`, kind: "park" };
    const gateProgress: Loose = {};
    for (const g of Object.keys(w.gates ?? {})) gateProgress[g] = { have: 0, need: 1, unmet: [], conds: [], onlyRequester: false, passes: false };
    const history = [0, 1, 2, 3, 4, 5, 6, 7, 8].slice(0, Math.max(1, w.station + 1)).map((i) => ({ station: cat.stations[i]!.id, agent: cat.stations[i]!.agent, model: "claude-sonnet", startedAt: w.createdAt + i * 90 * MIN, endedAt: i < w.station ? w.createdAt + (i + 1) * 90 * MIN : null, tokens: 60000 + i * 9000, cost: 0.9 + i * 0.1, outcome: i < w.station ? "passed" : null, note: "", summary: i < w.station ? `${cat.stations[i]!.name} finished with no open questions.` : undefined }));
    const full = { ...w, brief: BRIEF, criteria: CRITERIA, history, version: 7, gateProgress, allowed: { approve: gate ? { allowed: approveOf[w.id]?.allowed ?? true, reason: approveOf[w.id]?.reason ?? "", needs: "", gate, instance: `${w.id}:${gate}:1` } : null, moves, can }, stop: null, route: rt, pr: w.pr ?? { number: 300, state: "open", tag: null }, briefVersions: [], conv: { messages: [], qi: 0, answers: {}, misses: [], decisions: [], awaiting: "", done: true, raised: [], questions: [] } };
    const record = {
      id: w.id, version: 7, project: projectId, repo: w.repo, title: w.title, state: w.state,
      request: { text: w.description || w.title, by: w.requestedBy, via: w.source, at: w.createdAt, attachments: [] },
      classification: { predicted: w.cls, final: w.cls, confidence: 0.94, rationale: "The request adds new behaviour to an existing endpoint.", requested: null, overridden: null },
      route: rt, flowVersion: 3, clarification: [], briefVersions: WO_BRIEF_VERSIONS(w), brief: BRIEF, criteria: CRITERIA, journey: history,
      gates: woGateInstances(w), sendbacks: [], bayStays: [], attempts: history.map((h, i) => ({ id: `at-${i}`, station: h.station, visit: 1, fencing: 1, state: h.endedAt ? "done" : "running", outcome: h.outcome, startedAt: new Date(h.startedAt).toISOString(), endedAt: h.endedAt ? new Date(h.endedAt).toISOString() : null, agent: h.agent })), results: [], runs: [],
      code: { pullRequests: [{ number: 300, state: "open", draft: false, headSha: "a1b2c3d", title: w.title, url: null, mergedAt: null }], commits: [{ sha: "a1b2c3d", message: "Add sliding window limiter", author: "agent", at: new Date(NOW - 60 * MIN).toISOString() }], files: [{ path: "src/limiter/window.ts", status: "added", plus: 84, minus: 6, preview: [{ t: " ", s: "@@ -1,12 +1,30 @@" }, { t: " ", s: "import { Clock } from \"../clock\";" }, { t: "+", s: "export interface WindowOpts { limit: number; windowMs: number }" }, { t: "+", s: "export class SlidingWindow {" }, { t: "+", s: "  private hits: number[] = [];" }, { t: "+", s: "  allow(): boolean {" }, { t: "+", s: "    const now = this.clock.now();" }, { t: "+", s: "    return this.hits.length < this.o.limit;" }, { t: "+", s: "  }" }, { t: "+", s: "}" }, { t: "-", s: "const LIMIT = 100;" }] }, { path: "src/routes/payout.ts", status: "modified", plus: 31, minus: 9, preview: [{ t: " ", s: "@@ -1,6 +1,10 @@" }, { t: " ", s: "import { SlidingWindow } from \"../limiter/window\";" }, { t: "-", s: "const limiter = new FixedWindow(100);" }, { t: "+", s: "const limiter = new SlidingWindow({ limit: 100, windowMs: 60000 });" }, { t: "+", s: "if (!limiter.allow()) return reply.code(429).send();" } ] }, { path: "test/limiter.test.ts", status: "added", plus: 97, minus: 0, preview: [{ t: " ", s: "@@ -1,6 +1,10 @@" }, { t: "+", s: "it(\"rejects the 101st request in a window\", () => {" }, { t: "+", s: "  expect(hit(101)).toBe(false);" }, { t: "+", s: "});" } ] }, { path: "config/limits.yaml", status: "modified", plus: 6, minus: 2, preview: [{ t: " ", s: "@@ -1,6 +1,10 @@" }, { t: "-", s: "window: fixed" }, { t: "+", s: "window: sliding" }, { t: "+", s: "windowMs: 60000" } ] }], diff: { plus: 212, minus: 31, files: 4 }, tests: { passed: 54, failed: 0, added: 6 } },
      outcomes: [], totals: { tokens: 545000, cost: 1.16 },
      completeness: { sections: { summary: true, request: true, clarification: true, agreement: true, stations: true, changes: true, verification: true, merge: false, approvals: false, after: false, timeline: true }, done: 7, total: 11 },
      summary: { generated: `${w.title} is ${w.state}.`, written: null },
      events: [...history.map((h, i) => ({ seq: i + 1, at: new Date(h.startedAt).toISOString(), type: i === 0 ? "wo.submit" : "wo.enter", by: w.requestedBy, outcome: "ok", detail: i === 0 ? { text: w.title } : { station: h.station } })), ...woGateInstances(w).filter((g) => g.decision).map((g, i) => ({ seq: 100 + i, at: g.decision.at, type: "gate.decision", by: g.decision.decided_by, outcome: "ok", detail: { gate: g.gate, decision: "approved" } }))],
    };
    ov[`work-orders/${w.id}`] = (r) => fulfillJson(r, full);
    ov[`work-orders/${w.id}/record`] = (r) => fulfillJson(r, record);
    ov[`work-orders/${w.id}/changes`] = (r) => fulfillJson(r, { pullRequests: [{ number: 300, state: "open", headSha: "a1b2c3d", branch: "gantry/" + w.id.toLowerCase(), base: "main", url: null }], commits: [], files: record.code.files, patches: [] });
    for (const g of Object.keys(w.gates ?? {})) {
      ov[`work-orders/${w.id}/gates/${g}/approvers`] = (r) => fulfillJson(r, { gate: g, label: g, name: "Review and merge", rule: { text: `Needs ${approveOf[w.id]?.need ?? 1} approval${(approveOf[w.id]?.need ?? 1) > 1 ? "s" : ""} from Tech Lead or Project Admin \u00b7 the author can't approve`, required: approveOf[w.id]?.need ?? 1, base: approveOf[w.id]?.need ?? 1, sod: true, roles: [], people: [], conditions: [] }, progress: { have: approveOf[w.id]?.have ?? 0, need: approveOf[w.id]?.need ?? 1, approvals: approveOf[w.id]?.approvals ?? [], unmet: [], onlyRequester: false }, eligible: approveOf[w.id]?.eligible ?? [{ id: "p-lead", name: "Meera Iyer", why: "Tech Lead", away: false, oncall: true }], overrides: [], satisfiable: true, warning: null, viewerCanOverride: false, can: { editRule: true, editWhy: "", grantRole: true, grantWhy: "" } });
    }
    ov[`work-orders/${w.id}/session`] = (r) => fulfillJson(r, woSession(w, full, gate));
  }
  ov["work-order-sessions"] = (r) => fulfillJson(r, { items: [] });
  return ov;
}

/* ---- fidelity round 2, group wo: eight named checks on the merge gate ---- */
const WO_CHECKS = ["lint", "typecheck", "unit (48)", "integration (6)", "migration dry-run", "secret scan", "licence check", "e2e smoke"].map((name) => ({ name, ok: true }));

/* ---- fidelity round 1, group wo: gate instances with decisions and checks, two brief versions and a conversation for the work order screens ---- */
const WO_DECIDERS = ["p-lead", "p-admin", "p-priya", "p-asha"];
function woGateInstances(w: Loose): Loose[] {
  const idx = (gate: string) => DEFAULT_CATALOG.stations.findIndex((x) => x.id === DEFAULT_CATALOG.gates.find((g) => g.id === gate)?.after);
  return DEFAULT_CATALOG.gates
    .filter((g) => w.gates?.[g.id]?.status === "waiting" || idx(g.id) < w.station)
    .map((g, i) => {
      const gate = g.id;
      const passed = w.gates?.[gate]?.status !== "waiting";
      const at = new Date(w.createdAt + (i + 1) * 70 * MIN).toISOString();
      return {
        id: `${w.id}:${gate}:1`, gate, station: null, status: passed ? "closed" : "waiting", closedReason: passed ? "decision" : null, headSha: null, openedAt: at, closedAt: passed ? at : null,
        pinned: { flowVersion: 3, ruleVersion: 2, policyVersion: 5 },
        basis: { checks: gate === "G5" ? WO_CHECKS : [{ name: "lint", ok: true }, { name: "typecheck", ok: true }] },
        votes: passed ? [{ by: WO_DECIDERS[i % 4]!, vote: "approve", comment: "", at, via: "web", role: null }] : [],
        decision: passed ? { decision: "approve", decided_by: WO_DECIDERS[i % 4]!, rule: null, trust_level: null, detail: { mode: "human" }, at } : null,
      };
    });
}
const WO_BRIEF_VERSIONS = (w: Loose): Loose[] => [
  { v: 2, at: w.createdAt + 30 * MIN, by: w.requestedBy, note: "First draft", brief: { ...BRIEF, goal: "Rate limits apply per account.", scopeIn: ["Per-account sliding window limiter"], ac: BRIEF.ac.slice(0, 2), decisions: [] } },
  { v: 3, at: w.createdAt + 50 * MIN, by: w.requestedBy, note: "Per merchant, with rollback", brief: BRIEF },
];
function woSession(w: Loose, full: Loose, gate: string | undefined): Loose {
  const g = gate ? DEFAULT_CATALOG.gates.find((x) => x.id === gate) : undefined;
  const st = DEFAULT_CATALOG.stations[w.station] ?? DEFAULT_CATALOG.stations[0]!;
  return {
    woId: w.id, project: w.project, repo: w.repo,
    wo: { id: w.id, title: w.title, description: w.description ?? "", cls: w.cls, clsName: "Feature", confidence: 0.94, rationale: "", priority: w.priority, station: st.id, stationName: st.name, state: w.state, bay: null, gate: g ? { id: g.id, label: g.label, name: g.name } : null, requestedBy: w.requestedBy, closed: false },
    messages: [
      { id: "m1", role: "assistant", author: st.agent, text: `I reviewed the change for ${w.id}. The limiter tests pass; two naming nits remain.`, at: NOW - 3 * 60 * MIN, data: { mode: "agent", model: "claude-sonnet", agent: st.agent } },
      { id: "m2", role: "user", author: w.requestedBy, text: "Thanks. Is the default still 60 per minute?", at: NOW - 2 * 60 * MIN, data: {} },
      { id: "m3", role: "assistant", author: st.agent, text: "Yes, the default is 60 per minute per merchant and it is configurable.", at: NOW - 100 * MIN, data: { mode: "agent", model: "claude-sonnet", agent: st.agent } },
    ],
    agent: { mode: "agent", name: st.name === "Review and merge" ? "Reviewer" : `${st.name} agent`, id: st.agent, model: "claude-sonnet", vendor: "anthropic", version: 4, station: st.id },
    budget: { spentUsd: 1.16, limitUsd: 20 }, costUsd: 1.16,
    can: { talk: true, talkWhy: "", confirm: true, confirmWhy: "" }, steps: [], next: { actor: gate ? "approver" : "agent", text: gate ? `Findings are ready for the ${gate} approver.` : "Working." },
    waiting: null, dialogue: { questions: [], assumptions: [], objections: [], askedMe: false }, swarm: null, documents: [], research: { plan: null, allowList: [], canDecide: false, canApproveUnlisted: false }, sources: [], pending: [],
    brief: BRIEF, briefConfirmed: true, briefOpen: false, ruleQuestion: null, ruleReady: false, busy: false, version: full.version,
  };
}
