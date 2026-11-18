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

export function woReadOverrides(wos: Loose[], projectId: string): Record<string, Handler> {
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
    const history = [0, 1, 2, 3, 4, 5, 6].slice(0, Math.max(1, w.station + 1)).map((i) => ({ station: cat.stations[i]!.id, agent: cat.stations[i]!.agent, model: "claude-sonnet", startedAt: w.createdAt + i * 90 * MIN, endedAt: i < w.station ? w.createdAt + (i + 1) * 90 * MIN : null, tokens: 60000 + i * 9000, cost: 0.9 + i * 0.1, outcome: i < w.station ? "passed" : null, note: "", summary: i < w.station ? `${cat.stations[i]!.name} finished with no open questions.` : undefined }));
    const full = { ...w, brief: BRIEF, criteria: CRITERIA, history, version: 7, gateProgress, allowed: { approve: gate ? { allowed: true, reason: "", needs: "", gate, instance: `${w.id}:${gate}:1` } : null, moves, can }, stop: null, route: rt, pr: w.pr ?? { number: 300, state: "open", tag: null }, briefVersions: [], conv: { messages: [], qi: 0, answers: {}, misses: [], decisions: [], awaiting: "", done: true, raised: [], questions: [] } };
    const record = {
      id: w.id, version: 7, project: projectId, repo: w.repo, title: w.title, state: w.state,
      request: { text: w.description || w.title, by: w.requestedBy, via: w.source, at: w.createdAt, attachments: [] },
      classification: { predicted: w.cls, final: w.cls, confidence: 0.94, rationale: "The request adds new behaviour to an existing endpoint.", requested: null, overridden: null },
      route: rt, flowVersion: 3, clarification: [], briefVersions: [{ v: 2, at: w.createdAt + 20 * MIN, by: "p-lead", note: "First draft", brief: { ...BRIEF, goal: "Rate limits apply per account." } }, { v: 3, at: w.createdAt + 50 * MIN, by: "p-lead", note: "Approved", brief: BRIEF }], brief: BRIEF, criteria: CRITERIA, journey: history,
      gates: ["G2", "G4"].map((g, i) => ({ id: `${w.id}:${g}:1`, gate: g, station: null, status: "closed", closedReason: null, headSha: null, openedAt: null, closedAt: new Date(w.createdAt + (60 + i * 200) * MIN).toISOString(), pinned: { flowVersion: 3, ruleVersion: null, policyVersion: null }, basis: { checks: [{ name: "lint", ok: true }, { name: "typecheck", ok: true }, { name: "unit (48)", ok: true }] }, votes: [], decision: { decision: "approved", decided_by: i ? "p-reader" : "p-lead", rule: null, trust_level: null, detail: { mode: "Human" }, at: new Date(w.createdAt + (60 + i * 200) * MIN).toISOString() } })), sendbacks: [], bayStays: [], attempts: history.map((h, i) => ({ id: `at-${i}`, station: h.station, visit: 1, fencing: 1, state: h.endedAt ? "done" : "running", outcome: h.outcome, startedAt: new Date(h.startedAt).toISOString(), endedAt: h.endedAt ? new Date(h.endedAt).toISOString() : null, agent: h.agent })), results: [], runs: [],
      code: { pullRequests: [{ number: 300, state: "open", draft: false, headSha: "a1b2c3d", title: w.title, url: null, mergedAt: null }], commits: [{ sha: "a1b2c3d", message: "Add sliding window limiter", author: "agent", at: new Date(NOW - 60 * MIN).toISOString() }], files: [{ path: "src/limiter/window.ts", status: "added", plus: 84, minus: 6, preview: [{ t: " ", s: "@@ -1,12 +1,30 @@" }, { t: " ", s: "import { Clock } from \"../clock\";" }, { t: "+", s: "export interface WindowOpts { limit: number; windowMs: number }" }, { t: "+", s: "" }, { t: "+", s: "export class SlidingWindow {" }, { t: "+", s: "  private hits: number[] = [];" }, { t: "+", s: "  constructor(private o: WindowOpts, private clock: Clock) {}" }, { t: "+", s: "  allow(): boolean {" }, { t: "+", s: "    const now = this.clock.now();" }, { t: "+", s: "    this.hits = this.hits.filter(t => now - t < this.o.windowMs);" }, { t: "+", s: "    if (this.hits.length >= this.o.limit) return false;" }, { t: "+", s: "    this.hits.push(now);" }, { t: "+", s: "    return true;" }, { t: "+", s: "  }" }, { t: "+", s: "}" }, { t: "-", s: "const LIMIT = 100;" }, { t: " ", s: "" }] }, { path: "src/routes/payout.ts", status: "modified", plus: 31, minus: 9, preview: [{ t: " ", s: "@@ -40,9 +40,22 @@ router.post(\"/payout\"" }, { t: " ", s: "  const merchant = await getMerchant(req);" }, { t: "-", s: "  return handle(req, res);" }, { t: "+", s: "  const lim = limiters.for(merchant.id);" }, { t: "+", s: "  if (!lim.allow()) {" }, { t: "+", s: "    res.setHeader(\"Retry-After\", \"1\");" }, { t: "+", s: "    metrics.inc(\"payout_rate_limited_total\");" }, { t: "+", s: "    return res.status(429).end();" }, { t: "+", s: "  }" }, { t: "+", s: "  return handle(req, res);" }] }, { path: "test/limiter.test.ts", status: "added", plus: 97, minus: 0, preview: [{ t: " ", s: "@@ -0,0 +1,18 @@" }, { t: "+", s: "it(\"blocks after limit\", () => {" }, { t: "+", s: "  const w = new SlidingWindow({ limit: 2, windowMs: 1000 }, fake);" }, { t: "+", s: "  expect(w.allow()).toBe(true);" }, { t: "+", s: "  expect(w.allow()).toBe(true);" }, { t: "+", s: "  expect(w.allow()).toBe(false);" }, { t: "+", s: "});" }] }, { path: "config/limits.yaml", status: "modified", plus: 6, minus: 2, preview: [{ t: " ", s: "@@ -3,5 +3,9 @@" }, { t: "-", s: "payout_limit: 100" }, { t: "+", s: "payout_limit: 60" }, { t: "+", s: "payout_limit_window_ms: 60000" }] }], diff: { plus: 212, minus: 31, files: 4 }, tests: { passed: 54, failed: 0, added: 6 } },
      outcomes: [], totals: { tokens: 545000, cost: 1.16 },
      completeness: { sections: { summary: true, request: true, clarification: true, agreement: true, stations: true, changes: true, verification: true, merge: false, approvals: false, after: false, timeline: true }, done: 7, total: 11 },
      summary: { generated: `${w.title} is ${w.state}.`, written: null },
      events: history.map((h, i) => ({ seq: i + 1, at: new Date(h.startedAt).toISOString(), type: i === 0 ? "wo.submit" : "wo.enter", by: w.requestedBy, outcome: "ok", detail: i === 0 ? { text: w.title } : { station: h.station } })),
    };
    ov[`work-orders/${w.id}`] = (r) => fulfillJson(r, full);
    ov[`work-orders/${w.id}/record`] = (r) => fulfillJson(r, record);
    ov[`work-orders/${w.id}/changes`] = (r) => fulfillJson(r, { pullRequests: [{ number: 300, state: "open", headSha: "a1b2c3d", branch: "gantry/" + w.id.toLowerCase(), base: "main", url: null }], commits: [], files: record.code.files, patches: [] });
    for (const g of Object.keys(w.gates ?? {})) {
      ov[`work-orders/${w.id}/gates/${g}/approvers`] = (r) => fulfillJson(r, { gate: g, label: g, name: "Review and merge", rule: { text: "Needs 1 approval from Tech Lead or Project Admin \u00b7 the author can't approve", required: 1, sod: true, roles: [], people: [], conditions: [] }, progress: { have: 0, need: 1, approvals: [], unmet: [], onlyRequester: false }, eligible: [{ id: "p-lead", name: "Meera Iyer", why: "Tech Lead", away: false, oncall: true }], overrides: [], satisfiable: true, warning: null, viewerCanOverride: false, can: { editRule: true, editWhy: "", grantRole: true, grantWhy: "" } });
    }
    ov[`work-orders/${w.id}/session`] = (r) => fulfillJson(r, { ok: false, msg: "No conversation yet" }, 404);
  }
  ov["work-order-sessions"] = (r) => fulfillJson(r, { items: [] });
  return ov;
}
