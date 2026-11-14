import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import EvalsView, { regressionsOf } from "./evals";
import { evalsUi } from "./evals/kit";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: any; headers: Record<string, string>; query: URLSearchParams }

const NOW = Date.now();
const DAY = 86_400_000;
const person = { id: "p-asha", name: "Asha Raman", title: "Head", email: "a@acme.dev", teams: [], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "a", away: null, mfa: true };
const elig = (ok: boolean, text: string, extra: object = {}) => ({ ok, text, score: ok ? 0.9 : null, suite: "SUITE-BUILD", threshold: 0.85, needs: ok ? "" : "A passing run of SUITE-BUILD", ...extra });
const ver = (v: string, o: object = {}) => ({ v, at: NOW - DAY, note: "", diff: "", suiteScore: 0.9, live: false, rc: false, snapshot: JSON.stringify({ model: "claude-opus-5-5" }), eligibility: elig(true, "Eligible"), ...o });
const BUILD = {
  id: "ag-build", name: "Builder", station: "build", model: "claude-opus-5-5", fallbacks: [], version: "2.6.1", status: "active", autonomy: "gate", tools: {}, skills: ["sk-a"], mcp: [], stations: ["build"], projects: "all", budget: 12,
  guardrails: { paths: [], maxDiff: 0 }, suite: "SUITE-BUILD", instructions: "", overrides: {}, spark: [0.8, 0.85], spend7d: 1, initials: "B", evalScore: 0.9, rev: 7, suiteName: "Builder golden set", threshold: 0.85, running: 0,
  versions: [ver("2.5.0"), ver("2.6.1", { live: true }), ver("2.7.0-rc1", { rc: true, suiteScore: 0, eligibility: elig(false, "Blocked: 60% vs 85% on SUITE-BUILD", { score: 0.6 }) }), ver("2.8.0-rc1", { rc: true, eligibility: elig(true, "Eligible: 91% vs 85% on SUITE-BUILD") })],
};
const REVIEW = { ...BUILD, id: "ag-review", name: "Reviewer", station: "review", version: "1.0.0", suite: "SUITE-REVIEW", evalScore: 0.7, versions: [ver("1.0.0", { live: true })] };
const AGENTS = [BUILD, REVIEW];
const cases = (prefix: string, n: number, extra: object = {}) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-0${i + 1}`, name: `Case ${i + 1}`, task: `Task ${i + 1}`, repo: null, commit: null, golden: false, checks: "", rules: [], by: "p-asha", added: NOW - 5 * DAY, ...extra }));
const SUITES = [
  { id: "SUITE-BUILD", name: "Builder golden set", station: "build", threshold: 0.85, agent: "ag-build", version: 1, running: null, cases: [...cases("BLD", 5), { id: "BLD-06", name: "Pinned", task: "t", repo: "payments-api", commit: "a".repeat(40), golden: true, checks: "", rules: [{ kind: "output_contains", value: "x" }] }] },
  { id: "SUITE-REVIEW", name: "Reviewer golden set", station: "review", threshold: 0.8, agent: "ag-review", version: 1, running: null, cases: cases("REV", 2) },
];
const res = (id: string, pass: boolean, o: object = {}) => ({ caseId: id, pass, reason: pass ? "" : "Missed an acceptance criterion", ms: 4000, ...o });
const run = (id: string, suite: string, agent: string, version: string, model: string, score: number, results: object[], o: object = {}) => ({
  id, suite, agent, version, model, at: NOW - 2 * DAY, score, results, by: "p-asha", cost: 3.2, status: "completed", count: results.length, passed: results.filter((r: any) => r.pass).length, range: [Math.max(0, score - 0.3), Math.min(1, score + 0.1)], repeats: 1, done: results.length, total: results.length, finishedAt: NOW, override: false, vendor: null, seeded: false, ...o,
});
const RUNS_BUILD = [
  run("RUN-1", "SUITE-BUILD", "ag-build", "2.6.1", "claude-opus-5-5", 0.83, ["BLD-01", "BLD-02", "BLD-03", "BLD-04", "BLD-05", "BLD-06"].map((c, i) => res(c, i !== 5))),
  run("RUN-2", "SUITE-BUILD", "ag-build", "2.7.0-rc1", "claude-opus-5-5", 0.5, ["BLD-01", "BLD-02", "BLD-03", "BLD-04", "BLD-05", "BLD-06"].map((c, i) => res(c, i < 3, { repeats: 2, passes: i < 3 ? 2 : 0, advisory: i === 0 ? [{ kind: "model_graded", label: "Is it polite?", pass: null, advisory: true }] : undefined })), { at: NOW - DAY, repeats: 2 }),
];
const SC = (n: number) => ({ taskSuccess: n ? 0.9 : 0, firstPass: n ? 0.8 : 0, testPass: 0, rework: n ? 0.1 : 0, costPerWO: n ? 1.2 : 0, minutesPerStation: n ? 14 : 0, gateRejections: n ? 2 : 0, overrideRate: n ? 0.05 : 0, trend: { success: n ? [0.8, 0.82, 0.85, 0.84, 0.86, 0.9, 0.88, 0.9] : [0, 0, 0, 0, 0, 0, 0, 0], cost: n ? [1, 1.1, 1, 1.2, 1.2, 1.1, 1.3, 1.2] : [0, 0, 0, 0, 0, 0, 0, 0] }, counts: { attempts: n, decisions: n, workOrders: n } });
const SCORECARDS = { "ag-build": SC(12), "ag-review": SC(2) };
const EXTRA = {
  heat: { "ag-build": { payments: 0.9, risk: 0.6 }, "ag-review": { payments: null, risk: null } }, confusion: {}, perClass: { feature: { count: 8, success: 0.88, cycleH: 30, rework: 0.1 }, bug: { count: 2, success: 0.5, cycleH: 60, rework: 0.5 } }, overrideRate: 0.04,
  onboarding: { attempts: 3, ready: 2, successRate: 0.667, medianDays: 1.5, p90Days: 2, failedReasons: [["No CI", 1]] }, gateRejections: [["Missing tests", 3]], humanOverride: { G2: 0.05 }, onboardingStages: { ready: 2, assessed: 1 }, counts: { workOrders: 10, classified: 10, decisions: 20, attempts: 14 },
};
const project = (id: string, name: string, regulated = false) => ({ id, name, key: id.toUpperCase(), status: "active", teams: [], owner: "p-asha", template: "t", regulated, desc: "", approvers: {}, flow: { order: [], stations: {}, gates: {}, classes: [], bays: [] }, version: 1 });
const ME = { person, session: { id: "s1", person: "p-asha", method: "sso", device: "x", ip: "1", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "", tz: "IST" }, projects: [{ id: "payments", name: "Payments" }], nav: [], badges: {} };
const SKILLS = [{ id: "sk-a", name: "Test design", version: "1.2.0", coverage: { suite: "SUITE-BUILD", cases: 4, pass: 3 }, projects: "all", versions: [], desc: "", when: "", owner: "p-asha", body: "", resources: [] }];
const VENDORS = [{ id: "anthropic", name: "Anthropic", connected: true, models: [{ id: "claude-opus-5-5", name: "Opus 5.5", enabled: true }, { id: "claude-sonnet-5-5", name: "Sonnet 5.5", enabled: true }] }];

function setup(extra: Record<string, Handler> = {}, denied: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: ME }),
    "GET /api/v1/projects": () => ({ body: [project("payments", "Payments"), project("risk", "Risk", true)] }),
    "GET /api/v1/agents": () => ({ body: AGENTS }),
    "GET /api/v1/suites": () => ({ body: SUITES }),
    "GET /api/v1/evals/runs": () => ({ body: RUNS_BUILD }),
    "GET /api/v1/evals/scorecards": () => ({ body: SCORECARDS }),
    "GET /api/v1/evals/factory": () => ({ body: EXTRA }),
    "GET /api/v1/skills": () => ({ body: SKILLS }),
    "GET /api/v1/vendors": () => ({ body: VENDORS }),
    "GET /api/v1/catalog": () => ({ body: DEFAULT_CATALOG }),
    "GET /api/v1/trust/cells": () => ({ body: { sampleRate: 5, criteria: {}, ceilings: [], cells: [{ id: "ag-build|bug|payments", agent: "ag-build", cls: "bug", project: "payments", repo: null, level: 2, since: 0, cleanRuns: 0, history: [{ at: NOW - DAY, from: 3, to: 1, by: "system", kind: "demote", reason: "Post-release incident on WO-1", cause: { type: "incident", wo: "WO-1" } }] }], proposals: [], nextProposal: 1, seededAt: 0 } }),
    "GET /api/v1/learning/findings": () => ({ body: [{ id: "F-1", title: "Builder misses tests", agent: "ag-build", status: "open", count: 3 }] }),
    "GET /api/v1/projects/payments/repos": () => ({ body: [{ id: "payments-api", name: "payments-api", project: "payments", version: 1 }] }),
    "GET /api/v1/projects/risk/repos": () => ({ body: [] }),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x");
    const method = init?.method ?? "GET";
    const hdr: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (hdr[k] = v));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body, headers: hdr, query: u.searchParams });
    if (u.pathname === "/api/v1/can") {
      const checks = (body as { checks: Array<{ action: string }> }).checks;
      return new Response(JSON.stringify({ results: checks.map((c) => (denied.includes(c.action) ? { allowed: false, reason: `No role holds ${c.action}.`, needs: "Needs Factory Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "", needs: "", rule: { id: "ok" } })) }), { status: 200 });
    }
    const h = base[`${method} ${u.pathname}`];
    const r = h ? h(url, init) : { status: 404, body: { ok: false, msg: `no mock ${method} ${u.pathname}` } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
  return calls;
}
const byId = (id: string) => waitFor(() => { const e = document.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; });
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider><EvalsView /></OverlayProvider></QueryClientProvider>);
}
const writes = (calls: Call[], method: string) => calls.filter((c) => c.method === method && c.path !== "/api/v1/can");
const reasonOf = (e: HTMLElement) => e.getAttribute("data-reason") ?? "";

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  Object.assign(evalsUi, { tab: "agents", agent: null, suite: null, run: null, a: null, b: null, runVersion: null, runModel: null, repeats: 1 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Evals screen: scorecards", () => {
  it("lists agents with their eval score, marks one below its gate, and shows the live scorecard with its count", async () => {
    setup();
    mount();
    const row = await byId("ev-ag-ag-review");
    expect(row.textContent).toContain("▼ 70%");
    expect((await byId("ev-ag-ag-build")).textContent).toContain("90%");
    expect(document.querySelector(".ev-tiles")!.textContent).toContain("Task success90%");
    expect((await byId("ev-n")).textContent).toContain("Based on 12 finished attempts on 12 work orders and 12 gate decisions");
    fireEvent.click(row);
    await waitFor(() => expect(document.getElementById("ev-n")!.textContent).toContain("Insufficient data: 2 finished attempts"));
    expect(document.querySelector(".ev-tiles")!.textContent).toContain("Task success90%");
  });
  it("shows the headline numbers: suites, runs, regressions, eligible candidates", async () => {
    setup();
    mount();
    await byId("ev-ag-ag-build");
    const head = document.querySelector(".titleblock")!.textContent!;
    expect(head).toContain("Suites2");
    expect(head).toContain("Runs2");
    expect(head).toContain("Candidates eligible1");
  });
  it("blocks promotion with the reason until the suite passed, and promotes an eligible candidate with the agent's version", async () => {
    const calls = setup({ "POST /api/v1/agents/ag-build/versions/2.8.0-rc1/promote": () => ({ body: { ok: true, msg: "Builder 2.8.0-rc1 is on the floor." } }) });
    mount();
    const blocked = await byId("ev-promote-ag-build-270rc1");
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(reasonOf(blocked)).toContain("Blocked: 60% vs 85%");
    fireEvent.click(blocked);
    expect(writes(calls, "POST")).toHaveLength(0);
    const go = (await waitFor(() => { const e = document.querySelectorAll("[id='ev-promote-ag-build-280rc1']")[0]; if (!e) throw new Error("none"); return e; })) as HTMLElement;
    fireEvent.click(go);
    await waitFor(() => expect(writes(calls, "POST")).toHaveLength(1));
    expect(writes(calls, "POST")[0]!.headers["if-match"]).toBe("7");
  });
  it("lists trust demotions and learning findings for the agent, with links to Trust and Learning", async () => {
    setup();
    mount();
    expect((await byId("ev-tl-dem-0")).textContent).toContain("Builder · bug · Payments");
    expect(document.body.textContent).toContain("Post-release incident on WO-1");
    fireEvent.click(document.getElementById("ev-tl-dem-0")!);
    expect(window.location.hash).toBe("#trust");
    expect((await byId("ev-tl-f-F-1")).textContent).toContain("F-1 Builder misses tests");
  });
});

describe("Evals screen: regressions", () => {
  it("finds a run that scored well under the floor version's and calls it out, linking to the comparison", async () => {
    setup();
    mount();
    const btn = await byId("ev-reg-0");
    expect(btn.textContent).toContain("SUITE-BUILD: Builder 2.7.0-rc1 on claude-opus-5-5 scored 50% vs 83% for the floor version");
    expect(document.querySelector(".ev-regs")!.textContent).toContain("1 regression");
    fireEvent.click(btn);
    await byId("ev-run-btn");
    expect((document.getElementById("h2h-a") as HTMLSelectElement).value).toBe("RUN-2");
    expect((document.getElementById("h2h-b") as HTMLSelectElement).value).toBe("RUN-1");
  });
  it("does not count a model override or an old run as a regression", () => {
    const d = { suites: SUITES, agents: AGENTS, runsOf: (id: string) => RUNS_BUILD.filter((r) => r.suite === id).map((r) => ({ ...r, override: true })) } as never;
    expect(regressionsOf(d)).toHaveLength(0);
    const old = { suites: SUITES, agents: AGENTS, runsOf: (id: string) => RUNS_BUILD.filter((r) => r.suite === id).map((r) => ({ ...r, at: NOW - 30 * DAY })) } as never;
    expect(regressionsOf(old)).toHaveLength(0);
  });
});

describe("Evals screen: suites and runs", () => {
  const openSuites = async () => { fireEvent.click(await byId("ev-tab-suites")); await byId("ev-run-btn"); };
  it("lists suites with the last score and its task count, and shows the run's task count and range", async () => {
    setup();
    mount();
    await openSuites();
    const row = await byId("ev-su-SUITE-BUILD");
    expect(row.textContent).toContain("▼ 50%");
    expect(row.textContent).toContain("n=6");
    expect(row.textContent).toContain("6");
    fireEvent.click(await byId("ev-run-RUN-1"));
    expect((await byId("ev-range")).textContent).toContain("5 of 6 tasks passed");
    expect(document.getElementById("ev-range")!.textContent).toContain("95% range 53% to 93%");
    expect(document.getElementById("ev-range")!.textContent).toContain("Few tasks");
    fireEvent.click(await byId("ev-run-RUN-2"));
    await waitFor(() => expect(document.getElementById("ev-range")!.textContent).toContain("each run 2 times"));
    expect(document.querySelector(".ev-run-detail")!.textContent).toContain("2/2");
    expect(document.querySelector(".ev-run-detail")!.textContent).toContain("Advisory: Is it polite?");
  });
  it("starts a real run with the version, model and repeats picked, as a keyed create, and nothing is simulated", async () => {
    const calls = setup({ "POST /api/v1/suites/SUITE-BUILD/runs": () => ({ body: { ok: true, msg: "RUN-3 started: 6 cases.", run: "RUN-3", total: 12 } }) });
    mount();
    await openSuites();
    expect(document.body.textContent).not.toMatch(/simulated/i);
    fireEvent.change(await byId("ev-run-ver"), { target: { value: "2.8.0-rc1" } });
    fireEvent.change(await byId("ev-run-model"), { target: { value: "claude-sonnet-5-5" } });
    fireEvent.change(await byId("ev-run-repeats"), { target: { value: "3" } });
    fireEvent.click(await byId("ev-run-btn"));
    await waitFor(() => expect(writes(calls, "POST")).toHaveLength(1));
    const c = writes(calls, "POST")[0]!;
    expect(c.path).toBe("/api/v1/suites/SUITE-BUILD/runs");
    expect(c.body).toEqual({ agent: "ag-build", version: "2.8.0-rc1", model: "claude-sonnet-5-5", repeats: 3 });
    expect(c.headers["idempotency-key"]).toBeTruthy();
  });
  it("shows a run in progress from the server, disables a second run with the reason, and cancels it", async () => {
    const running = run("RUN-9", "SUITE-BUILD", "ag-build", "2.8.0-rc1", "claude-opus-5-5", 0, [res("BLD-01", true)], { status: "running", count: 0, passed: 0, done: 3, total: 12, range: [0, 0] });
    const calls = setup({ "GET /api/v1/evals/runs": () => ({ body: [...RUNS_BUILD, running] }), "POST /api/v1/suites/SUITE-BUILD/runs/RUN-9/cancel": () => ({ body: { ok: true, msg: "RUN-9 cancelled." } }) });
    mount();
    await openSuites();
    const btn = await byId("ev-run-btn");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(reasonOf(btn)).toBe("A run is already in progress on SUITE-BUILD (RUN-9).");
    expect(document.querySelector(".run-progress")!.textContent).toContain("3 / 12 runs");
    fireEvent.click(await byId("ev-run-cancel"));
    await waitFor(() => expect(writes(calls, "POST")).toHaveLength(1));
    expect(writes(calls, "POST")[0]!.path).toBe("/api/v1/suites/SUITE-BUILD/runs/RUN-9/cancel");
  });
  it("locks running and adding cases for someone without eval.run, with the reason", async () => {
    setup({}, ["eval.run"]);
    mount();
    await openSuites();
    await waitFor(() => expect(document.getElementById("ev-run-btn")!.getAttribute("aria-disabled")).toBe("true"));
    expect(reasonOf(document.getElementById("ev-run-btn")!)).toContain("No role holds eval.run");
    expect(document.querySelector(".lock-note")!.textContent).toContain("running suites");
    expect(document.getElementById("ev-add-case")!.getAttribute("aria-disabled")).toBe("true");
  });
  it("adds a case with a task, a pinned repo snapshot, deterministic checks and the person's own note", async () => {
    const calls = setup({ "POST /api/v1/suites/SUITE-BUILD/cases": () => ({ body: { ok: true, msg: "BLD-07 added to SUITE-BUILD." } }) });
    mount();
    await openSuites();
    fireEvent.click(await byId("ev-add-case"));
    fireEvent.change(await byId("ev-case-name"), { target: { value: "Spec without a rollback section" } });
    fireEvent.change(await byId("ev-case-task"), { target: { value: "Write the spec" } });
    fireEvent.change(await byId("ev-case-repo"), { target: { value: "payments-api" } });
    fireEvent.change(await byId("ev-case-commit"), { target: { value: "b".repeat(40) } });
    fireEvent.change(await byId("ev-case-mention"), { target: { value: "rollback\n\nacceptance criteria" } });
    fireEvent.change(await byId("ev-case-notouch"), { target: { value: "secrets/" } });
    fireEvent.change(await byId("ev-case-checks"), { target: { value: "Asks about rollback" } });
    fireEvent.click(await byId("ev-case-ok"));
    await waitFor(() => expect(writes(calls, "POST")).toHaveLength(1));
    expect(writes(calls, "POST")[0]!.body).toEqual({ name: "Spec without a rollback section", task: "Write the spec", checks: "Asks about rollback", repo: "payments-api", commit: "b".repeat(40), mustMention: ["rollback", "acceptance criteria"], mustNotMention: [], mustNotTouch: ["secrets/"] });
  });
  it("shows a refused case inline and keeps the dialog open", async () => {
    setup({ "POST /api/v1/suites/SUITE-BUILD/cases": () => ({ status: 422, body: { ok: false, msg: "Name the case." } }) });
    mount();
    await openSuites();
    fireEvent.click(await byId("ev-add-case"));
    fireEvent.click(await byId("ev-case-ok"));
    await waitFor(() => expect(document.querySelector(".form-err")!.textContent).toBe("Name the case."));
  });
  it("lists the golden cases with their pinned snapshot, and the head-to-head compares two runs task by task with the range overlap", async () => {
    setup();
    mount();
    await openSuites();
    expect((await byId("ev-cases-SUITE-BUILD")).textContent).toContain("golden payments-api@aaaaaaa");
    const t = document.querySelector(".ev-h2h")!;
    expect(t.textContent).toContain("Head-to-head on SUITE-BUILD");
    expect(t.textContent).toContain("Only B passes");
    expect(t.textContent).toContain("5 of 6 tasks");
    expect(document.getElementById("ev-h2h-note")?.textContent ?? "").toContain("ranges overlap");
  });
  it("asks for two runs when there is only one", async () => {
    setup({ "GET /api/v1/evals/runs": () => ({ body: [RUNS_BUILD[0]] }) });
    mount();
    await openSuites();
    expect(document.querySelector(".ev-suites-main")!.textContent).toContain("Need two runs");
  });
});

describe("Evals screen: factory-wide", () => {
  it("shows the matrix, the project heat grid, per-class figures with counts, onboarding with counts and the skill coverage", async () => {
    setup();
    mount();
    fireEvent.click(await byId("ev-tab-factory"));
    const mx = await byId("ev-mx-ag-build");
    expect(mx.textContent).toContain("90%");
    expect(document.getElementById("ev-mx-ag-review")!.textContent).toContain("n=2");
    const heat = document.querySelector(".ev-heat")!;
    expect(heat.textContent).toContain("▼ 60%");
    expect(heat.querySelector(".is-none")).not.toBeNull();
    expect(document.querySelector(".ev-pc")!.textContent).toContain("n=8");
    expect(document.querySelector(".ev-pc")!.textContent).toContain("insufficient data");
    expect(document.querySelector(".ev-onb")!.textContent).toContain("2 of 3 repos reached Ready");
    expect(document.querySelector(".ev-onb")!.textContent).toContain("No CI");
    expect(document.getElementById("ev-sk-sk-a")!.closest("tr")!.textContent).toContain("75%");
    expect(document.body.textContent).toContain("No classified requests yet");
    fireEvent.click(mx);
    await byId("ev-n");
  });
});
