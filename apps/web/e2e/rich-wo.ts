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
      route: rt, flowVersion: 3, clarification: [], briefVersions: [], brief: BRIEF, criteria: CRITERIA, journey: history,
      gates: [], sendbacks: [], bayStays: [], attempts: history.map((h, i) => ({ id: `at-${i}`, station: h.station, visit: 1, fencing: 1, state: h.endedAt ? "done" : "running", outcome: h.outcome, startedAt: new Date(h.startedAt).toISOString(), endedAt: h.endedAt ? new Date(h.endedAt).toISOString() : null, agent: h.agent })), results: [], runs: [],
      code: { pullRequests: [{ number: 300, state: "open", draft: false, headSha: "a1b2c3d", title: w.title, url: null, mergedAt: null }], commits: [{ sha: "a1b2c3d", message: "Add sliding window limiter", author: "agent", at: new Date(NOW - 60 * MIN).toISOString() }], files: [{ path: "src/limiter/window.ts", status: "added", plus: 84, minus: 6, preview: [{ t: " ", s: "@@ -1,12 +1,30 @@" }, { t: " ", s: "import { Clock } from \"../clock\";" }, { t: "+", s: "export interface WindowOpts { limit: number; windowMs: number }" }, { t: "+", s: "export class SlidingWindow {" }, { t: "+", s: "  private hits: number[] = [];" }, { t: "+", s: "  allow(): boolean {" }, { t: "+", s: "    const now = this.clock.now();" }, { t: "+", s: "    return this.hits.length < this.o.limit;" }, { t: "+", s: "  }" }, { t: "+", s: "}" }, { t: "-", s: "const LIMIT = 100;" }] }, { path: "src/routes/payout.ts", status: "modified", plus: 31, minus: 9 }, { path: "test/limiter.test.ts", status: "added", plus: 97, minus: 0 }, { path: "config/limits.yaml", status: "modified", plus: 6, minus: 2 }], diff: { plus: 212, minus: 31, files: 4 }, tests: { passed: 54, failed: 0, added: 6 } },
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
