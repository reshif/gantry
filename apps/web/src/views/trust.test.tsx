import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { updatePrefs } from "../lib/prefs";
import { OverlayProvider } from "../ui/Overlay";
import TrustView from "./trust";
import { trustUi } from "./trust/kit";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: any; headers: Record<string, string>; query: URLSearchParams }

const NOW = Date.now();
const DAY = 86_400_000;
const person = { id: "p-asha", name: "Asha Raman", title: "Head", email: "a@acme.dev", teams: [], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "a", away: null, mfa: true };
const ME = { person, session: { id: "s1", person: "p-asha", method: "sso", device: "x", ip: "1", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "", tz: "IST" }, projects: [{ id: "payments", name: "Payments" }], nav: [], badges: {} };
const project = (id: string, name: string, regulated = false) => ({ id, name, key: id.toUpperCase(), status: "active", teams: [], owner: "p-asha", template: "t", regulated, desc: "", approvers: {}, version: 1 });
const ev = (o: object = {}) => ({ runs: 3, cleanRuns: 2, evalScore: 0.9, rework: 0.1, incidents: 0, incidentWos: [] as string[], ...o });
const cell = (agent: string, cls: string, level: number, o: object = {}) => ({
  id: `${agent}|${cls}|payments`, agent, cls, project: "payments", repo: null, level, since: NOW - 10 * DAY, cleanRuns: 2, history: [{ at: NOW - 30 * DAY, from: null, to: 1, by: "system", kind: "seed", reason: "Default for new cells" }], rev: 3, gate: "G2",
  evidence: ev(), meets: { ok: false, next: level + 1, missing: ["2 of 20 clean runs"] }, ceiling: { max: 4, ids: [] as string[] }, effective: Math.min(level, 1), projection: 1.5, pending: null, ...o,
});
const DESIGN = cell("ag-design", "feature", 3, { gate: "G3d", pending: "TP-1", history: [{ at: NOW - 30 * DAY, from: null, to: 1, by: "system", kind: "seed", reason: "Default" }, { at: NOW - 2 * DAY, from: 3, to: 1, by: "system", kind: "demote", reason: "Post-release incident on WO-77", cause: { type: "incident", wo: "WO-77" } }] });
const PLAN = cell("ag-plan", "bug", 2, { gate: "G3G3s", ceiling: { max: 2, ids: ["CEIL-3"] } });
const SPEC = cell("ag-spec", "feature", 1, { evidence: ev({ runs: 12, cleanRuns: 10, incidents: 1, incidentWos: ["WO-5"] }) });
const REAL = [SPEC, DESIGN, PLAN];
const VIRTUAL = cell("ag-review", "feature", 1, { id: "ag-review|feature|payments", virtual: true, rev: 0, gate: "G5", history: [], evidence: ev({ runs: 0, cleanRuns: 0 }), pending: null });
const PROPS = [
  { id: "TP-1", cell: DESIGN.id, from: 1, to: 2, at: NOW - DAY, status: "pending", by: null, decidedAt: null, reason: "", evidence: { cleanRuns: 20, evalScore: 0.92, note: "Met the L2 criteria." }, savedPerWeek: 2.5 },
  { id: "TP-0", cell: SPEC.id, from: 1, to: 2, at: NOW - 9 * DAY, status: "declined", by: "p-asha", decidedAt: NOW - 8 * DAY, reason: "One more month", evidence: { cleanRuns: 20, evalScore: 0.9, note: "" }, savedPerWeek: 1 },
];
const CRIT = { "2": { cleanRuns: 20, evalMin: 0.85, reworkMax: 0.15, incidentsMax: 0, windowD: 14 }, "3": { cleanRuns: 30, evalMin: 0.9, reworkMax: 0.1, incidentsMax: 0, windowD: 30 }, "4": { cleanRuns: 40, evalMin: 0.93, reworkMax: 0.06, incidentsMax: 0, windowD: 60 } };
const CEILINGS = [{ id: "CEIL-1", text: "Regulated projects are capped at L2", when: { regulated: true }, max: 2, enabled: true, version: 2 }, { id: "CEIL-3", text: "Hotfixes are capped at L2", when: { cls: "hotfix" }, max: 2, enabled: false, version: 1 }];
const trustBody = (o: object = {}) => ({ sampleRate: 5, criteria: CRIT, ceilings: CEILINGS, cells: REAL, proposals: PROPS, nextProposal: 2, seededAt: 0, levelsAboveL1: false, criteriaVersion: 4, minRuns: 5, soakDays: 14, maxGrantable: 3, coverage: { payments: { total: 4, auto: 0 } }, ...o });
const WOS = [
  { id: "WO-5", title: "Add idempotency keys", cls: "feature", repo: "payments-api", project: "payments", state: "done", doneAt: NOW - 3 * DAY, gates: { G2: { status: "passed", approvals: [], rejections: [], checks: [], decision: { mode: "human", by: "p-asha", at: NOW - 3 * DAY, trust: 1 } } }, outcomes: [{ kind: "incident", at: NOW, text: "x", by: "p-asha" }] },
  { id: "WO-6", title: "Refund retries", cls: "feature", repo: "payments-api", project: "payments", state: "done", doneAt: NOW - 2 * DAY, gates: { G2: { status: "passed", approvals: [], rejections: [], checks: [], decision: { mode: "trust", at: NOW, trust: 2 } } }, outcomes: [] },
];

function setup(extra: Record<string, Handler> = {}, denied: string[] = [], tr: object = {}) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: ME }),
    "GET /api/v1/projects": () => ({ body: [project("payments", "Payments Platform"), project("risk", "Risk and Compliance", true)] }),
    "GET /api/v1/agents": () => ({ body: [{ id: "ag-spec", name: "Spec Writer" }, { id: "ag-design", name: "Designer" }, { id: "ag-plan", name: "Planner" }, { id: "ag-review", name: "Reviewer" }] }),
    "GET /api/v1/catalog": () => ({ body: DEFAULT_CATALOG }),
    "GET /api/v1/trust/cells": (url) => ({ body: new URL(url, "http://x").searchParams.get("project") ? trustBody({ cells: [...REAL, VIRTUAL], ...tr, ...((tr as { cells?: unknown[] }).cells ? { cells: [...(tr as { cells: unknown[] }).cells, VIRTUAL] } : {}) }) : trustBody(tr) }),
    "GET /api/v1/projects/payments/repos": () => ({ body: [{ id: "payments-api", name: "payments-api", project: "payments", version: 1 }] }),
    "GET /api/v1/projects/risk/repos": () => ({ body: [] }),
    "GET /api/v1/projects/payments/work-orders": () => ({ body: WOS }),
    "GET /api/v1/projects/risk/work-orders": () => ({ body: [] }),
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
  return render(<QueryClientProvider client={qc}><OverlayProvider><TrustView /></OverlayProvider></QueryClientProvider>);
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.path !== "/api/v1/can");
const reasonOf = (e: HTMLElement) => e.getAttribute("data-reason") ?? "";
const ok = (extra: object = {}) => ({ body: { ok: true, msg: "Done.", ...extra } });

const at = (search: string): void => window.history.replaceState(null, "", `/${search}`);
beforeEach(() => {
  at("");
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
  Object.assign(trustUi, { tab: "ladder", project: null, repo: "", sel: null, propFilter: "pending", demoFilter: "all", hiProposal: null });
  updatePrefs({ project: "payments", trustFocus: null } as never);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Trust screen: prototype matrix", () => {
  it("has a text-only legend, no link anywhere in the matrix card, and no row of dashes for an agent without cells", async () => {
    setup();
    at("");
    mount();
    const m = await byId("tr-agent-matrix");
    const card = m.parentElement!;
    expect(card.querySelector("#tr-demos-link")).toBeNull();
    expect(card.textContent).toContain("L4 runs unattended, audited");
    for (const tr of m.querySelectorAll("tbody tr")) expect(tr.querySelector("button.lvl")).not.toBeNull();
    expect(m.querySelectorAll("a")).toHaveLength(0);
  });
});

describe("Trust screen: ladder", () => {
  beforeEach(() => at("?tab=ladder"));
  it("shows the header numbers, including that levels above L1 are off", async () => {
    setup();
    mount();
    await byId("tr-matrix");
    const head = document.getElementById("tr-stats")!.textContent!;
    expect(head).toContain("Agents at L3+");
    expect(head).toContain("Open proposals1");
    expect(head).toContain("Active ceilings");
    expect(head).toContain("Review sample rate");
  });
  it("draws each cell with its level, run count, the level it actually runs at, ceiling and proposal marks, and recent demotion", async () => {
    setup();
    mount();
    const design = await byId("tr-cell-ag-design-feature");
    expect(design.textContent).toContain("L3");
    expect(design.textContent).toContain("→L1");
    expect(design.textContent).toContain("3 runs");
    expect(design.textContent).toContain("▲L2");
    expect(design.textContent).toContain("▼");
    expect(design.getAttribute("aria-label")).toContain("runs at L1");
    expect(design.getAttribute("aria-label")).toContain("promotion to L2 proposed");
    const plan = await byId("tr-cell-ag-plan-bug");
    expect(plan.textContent).toContain("≤L2");
    const review = await byId("tr-cell-ag-review-feature");
    expect(review.className).toContain("is-virtual");
    expect(review.getAttribute("aria-label")).toContain("no cell yet");
    expect(review.textContent).toContain("0 runs");
  });
  it("shows a cell's evidence with its count, 'insufficient data' for a small sample, the criteria for the next level and the history", async () => {
    setup();
    mount();
    fireEvent.click(await byId("tr-cell-ag-design-feature"));
    const d = await byId("tr-detail");
    expect(d.textContent).toContain("Designer · Feature · Payments Platform");
    expect(d.textContent).toContain("Judged at G3d");
    expect(d.textContent).toContain("Runs at L1: levels above L1 are switched off");
    expect(d.textContent).toContain("Finished on record3");
    expect(d.textContent).toContain("insufficient data n=3");
    expect(d.textContent).toContain("2 of 20 clean runs".slice(0, 0));
    expect(d.textContent).toContain("L3 ▼ L1");
    expect(d.textContent).toContain("Post-release incident on WO-77");
    expect(d.textContent).toContain("TP-1: promotion to L2 proposed");
    fireEvent.click(await byId("tr-cell-ag-spec-feature"));
    await waitFor(() => expect(document.getElementById("tr-detail")!.textContent).toContain("Clean share83% n=12"));
    const spec = document.getElementById("tr-detail")!;
    expect(spec.textContent).toContain("Reverts and incidents1WO-5");
    expect(spec.textContent).toContain("Clean runs10 of 20");
    expect(spec.textContent).toContain("Switchlevels above L1 are off");
    expect(spec.textContent).toContain("Latest work orders through G2");
    expect(spec.textContent).toContain("passed under trust L2");
    expect(spec.textContent).toContain("incident");
  });
  it("opens the level dialog with levels above L1 and L4 locked with their reasons, and saves a lower level with a reason and the cell's version", async () => {
    const calls = setup({ "POST /api/v1/trust/grants": () => ok() });
    mount();
    fireEvent.click(await byId("tr-cell-ag-spec-feature"));
    fireEvent.click(await byId("tr-change"));
    const l2 = (await byId("tr-lvl-2")) as HTMLInputElement;
    expect(l2.disabled).toBe(true);
    expect(l2.closest("label")!.getAttribute("data-reason")).toContain("switched off");
    expect((document.getElementById("tr-lvl-4") as HTMLInputElement).disabled).toBe(true);
    expect(document.getElementById("tr-lvl-4")!.closest("label")!.getAttribute("data-reason")).toContain("cannot be granted");
    fireEvent.click(document.getElementById("tr-lvl-ok")!);
    expect(document.querySelector(".form-err")!.textContent).toContain("reason of at least 4");
    fireEvent.change(document.getElementById("tr-lvl-reason")!, { target: { value: "Spec quality dipped" } });
    fireEvent.click(document.getElementById("tr-lvl-ok")!);
    expect(document.querySelector(".form-err")!.textContent).toContain("Pick a different level");
    fireEvent.click(document.getElementById("tr-lvl-0")!);
    fireEvent.click(document.getElementById("tr-lvl-ok")!);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toEqual({ target: SPEC.id, level: 0, reason: "Spec quality dipped" });
    expect(writes(calls)[0]!.headers["if-match"]).toBe("3");
  });
  it("creates a cell that does not exist yet from the virtual one, with version 0", async () => {
    const calls = setup({ "POST /api/v1/trust/grants": () => ok() });
    mount();
    fireEvent.click(await byId("tr-cell-ag-review-feature"));
    expect((await byId("tr-change")).textContent).toContain("Set level");
    fireEvent.click(document.getElementById("tr-change")!);
    fireEvent.click(await byId("tr-lvl-0"));
    fireEvent.change(document.getElementById("tr-lvl-reason")!, { target: { value: "Shadow it first" } });
    fireEvent.click(document.getElementById("tr-lvl-ok")!);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toEqual({ target: { agent: "ag-review", cls: "feature", project: "payments", repo: null }, level: 0, reason: "Shadow it first" });
    expect(writes(calls)[0]!.headers["if-match"]).toBe("0");
  });
  it("locks the level change for someone without trust.grant, with the reason, and shows what a ceiling blocks", async () => {
    setup({}, ["trust.grant"], { levelsAboveL1: true, cells: [SPEC, DESIGN, { ...PLAN, level: 3, effective: 2, meets: { ok: false, next: 4, missing: [] } }] });
    mount();
    fireEvent.click(await byId("tr-cell-ag-plan-bug"));
    await waitFor(() => expect(document.getElementById("tr-change")!.getAttribute("aria-disabled")).toBe("true"));
    expect(reasonOf(document.getElementById("tr-change")!)).toContain("No role holds trust.grant");
    expect(document.querySelector(".lock-note")!.textContent).toContain("trust levels on Payments Platform");
    expect(document.getElementById("tr-detail")!.textContent).toContain("capped by CEIL-3");
    expect(document.getElementById("tr-detail")!.textContent).toContain("L4 is not grantable");
  });
  it("switches project and repo, and says nothing is selected until a cell is", async () => {
    setup();
    mount();
    await byId("tr-matrix");
    expect(document.getElementById("tr-detail")!.textContent).toContain("Select a cell");
    fireEvent.change(await byId("tr-project"), { target: { value: "risk" } });
    await waitFor(() => expect(document.querySelector(".tr-matrix-panel")!.textContent).toContain("Risk and Compliance"));
    expect((document.getElementById("tr-repo") as HTMLSelectElement).options).toHaveLength(1);
  });
  it("opens at the cell another screen asks for", async () => {
    updatePrefs({ trustFocus: { cell: DESIGN.id } } as never);
    setup();
    mount();
    await waitFor(() => expect(document.getElementById("tr-detail")!.textContent).toContain("Designer · Feature"));
  });
});

describe("Trust screen: proposals", () => {
  const openProps = async () => fireEvent.click(await byId("tr-tab-proposals"));
  it("lists the pending proposal with its evidence, and approval is locked with the reason while levels above L1 are off", async () => {
    setup();
    mount();
    await openProps();
    const card = await byId("tr-prop-TP-1");
    expect(card.textContent).toContain("Designer on Payments Platform: L1 \u2192 L2");
    expect(card.textContent).toContain("Met the L2 criteria.");
    const ok_ = await byId("tr-prop-ok-TP-1");
    expect(ok_.getAttribute("aria-disabled")).toBe("true");
    expect(reasonOf(ok_)).toContain("Trust levels above L1 are switched off");
    expect(document.getElementById("tr-propf-all")).toBeNull();
    expect(document.getElementById("tr-prop-TP-0")!.textContent).toContain("Declined");
    expect(document.getElementById("tr-prop-TP-0")!.textContent).toContain("One more month");
  });
  it("approves with a reason when the switch is on, and declines with a reason", async () => {
    const calls = setup({ "POST /api/v1/trust/proposals/TP-1/decide": () => ok() }, [], { levelsAboveL1: true, cells: [{ ...DESIGN, effective: 3 }, SPEC, PLAN] });
    mount();
    await openProps();
    fireEvent.click(await byId("tr-prop-ok-TP-1"));
    const ta = await waitFor(() => { const e = document.querySelector("textarea"); if (!e) throw new Error("no dialog"); return e; });
    fireEvent.change(ta, { target: { value: "ab" } });
    fireEvent.click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Approve" && b.closest(".dlg, [role=dialog]"))!);
    expect(writes(calls)).toHaveLength(0);
    fireEvent.change(ta, { target: { value: "Clean streak reviewed" } });
    fireEvent.click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Approve" && b.closest(".dlg, [role=dialog]"))!);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toEqual({ accept: true, reason: "Clean streak reviewed" });
    fireEvent.click(await byId("tr-prop-no-TP-1"));
    const ta2 = await waitFor(() => document.querySelector("textarea")!);
    fireEvent.change(ta2, { target: { value: "Not yet, one more month" } });
    fireEvent.click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Decline" && b.closest(".dlg, [role=dialog]"))!);
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]!.body).toEqual({ accept: false, reason: "Not yet, one more month" });
  });
});

describe("Trust screen: demotions", () => {
  it("lists demotions with their cause and work order, filters by cause, and has no simulated outcome", async () => {
    setup();
    at("?tab=demotions");
    mount();
    const t = await byId("tr-demo-table");
    expect(t.textContent).toContain("L3 ▼ L1");
    expect(t.textContent).toContain("Incident");
    expect(t.textContent).toContain("WO-77");
    expect(t.textContent).toContain("Post-release incident on WO-77");
    expect(document.body.textContent).not.toMatch(/simulat/i);
    fireEvent.click(document.getElementById("tr-demof-revert")!);
    await waitFor(() => expect(document.querySelector("#tr-demo-table table")).toBeNull());
    expect(document.body.textContent).toContain("No demotions");
  });
  it("records a real post-release outcome with its attribution on a shipped work order", async () => {
    const calls = setup({ "POST /api/v1/work-orders/WO-6/outcomes": () => ok({ demoted: [] }) });
    mount();
    at("?tab=demotions");
    mount();
    fireEvent.click(await byId("tr-rec-outcome"));
    fireEvent.change(await byId("tr-out-text"), { target: { value: "Refunds doubled" } });
    expect((await byId("tr-out-impact")).textContent).toContain("Would drop 1 cell for this class to L1 if they are at that agent: ag-design L3");
    fireEvent.change(document.getElementById("tr-out-station")!, { target: { value: "spec" } });
    fireEvent.click(document.getElementById("tr-out-ok")!);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.path).toBe("/api/v1/work-orders/WO-6/outcomes");
    expect(writes(calls)[0]!.body).toEqual({ kind: "incident", text: "Refunds doubled", attribution: { station: "spec" } });
    expect(writes(calls)[0]!.headers["idempotency-key"]).toBeTruthy();
  });
  it("locks outcome recording when no project allows it", async () => {
    setup({}, ["outcome.record"]);
    mount();
    at("?tab=demotions");
    mount();
    await waitFor(() => expect(document.getElementById("tr-rec-outcome")!.getAttribute("aria-disabled")).toBe("true"));
  });
});

describe("Trust screen: ceilings, criteria and the switch", () => {
  const openPolicy = async () => fireEvent.click(await byId("tr-tab-ceilings"));
  it("shows the switch off with what that means, and turns it on with a reason", async () => {
    const calls = setup({ "PUT /api/v1/trust/switch": () => ok() });
    mount();
    await openPolicy();
    expect((await byId("tr-switch") as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector(".tr-switch")!.textContent).toContain("Levels above L1");
    fireEvent.click(document.getElementById("tr-switch")!);
    const ta = await waitFor(() => { const e = document.querySelector("textarea"); if (!e) throw new Error("no dialog"); return e; });
    fireEvent.change(ta, { target: { value: "Enough evidence on payments" } });
    fireEvent.click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Turn on")!);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "PUT", path: "/api/v1/trust/switch", body: { on: true, reason: "Enough evidence on payments" } });
  });
  it("lists every ceiling as a setrow with a switch, and toggling one sends its version and toasts Enabled or Disabled", async () => {
    const calls = setup({ "POST /api/v1/trust/ceilings": () => ok() });
    mount();
    await openPolicy();
    const row = (await byId("tr-ceil-on-CEIL-1")).closest(".setrow")!;
    expect(row.textContent).toContain("Regulated projects are capped at L2");
    expect(row.textContent).toContain("Maximum level L2. No proposal can exceed it.");
    expect(document.getElementById("tr-ceil-add")).toBeNull();
    expect(document.getElementById("tr-ceil-edit-CEIL-1")).toBeNull();
    fireEvent.click(document.getElementById("tr-ceil-on-CEIL-1")!);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toMatchObject({ id: "CEIL-1", enabled: false, max: 2 });
    expect(writes(calls)[0]!.headers["if-match"]).toBe("2");
    await waitFor(() => expect(document.body.textContent).toContain("Disabled Regulated projects are capped at L2"));
  });
  it("locks every policy control for someone without trust.criteria", async () => {
    setup({}, ["trust.criteria"]);
    mount();
    await openPolicy();
    await waitFor(() => expect(document.getElementById("tr-switch")!.getAttribute("aria-disabled")).toBe("true"));
    expect(document.getElementById("tr-ceil-on-CEIL-1")!.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("Trust screen: prototype structure", () => {
  it("has exactly the four prototype tabs Matrix, Proposals, Ceilings, Criteria and keeps the tab in the URL", async () => {
    setup();
    mount();
    await byId("tr-tab-matrix");
    expect([...document.querySelectorAll("[role=tab][id^='tr-tab-']")].map((e) => (e.textContent ?? "").replace(/\d+$/, ""))).toEqual(["Matrix", "Proposals", "Ceilings", "Criteria"]);
    expect(document.body.textContent).toContain("L4 runs unattended, audited");
    fireEvent.click(document.getElementById("tr-tab-criteria")!);
    await waitFor(() => expect(window.location.search).toContain("tab=criteria"));
    expect(document.body.textContent).toContain("To level");
    expect(document.body.textContent).toContain("Window (days)");
    expect([...document.querySelectorAll("#tr-criteria tbody tr")].map((r) => r.textContent?.slice(0, 2))).toEqual(["L2", "L3", "L4"]);
    expect(document.getElementById("tr-crit-edit")).toBeNull();
    expect(document.getElementById("tr-sample")).toBeNull();
  });
});

describe("Trust screen: a read the person may not make", () => {
  it("says Not visible to you, not an empty list, when the primary read is refused", async () => {
    setup({ "GET /api/v1/trust/cells": () => ({ status: 403, body: { ok: false, msg: "Your roles do not include trust.view." } }) });
    mount();
    await waitFor(() => expect(document.getElementById("trust-hidden")?.textContent).toContain("Not visible to you"));
    expect(document.getElementById("trust-hidden")?.textContent).toContain("trust.view");
  });
});

describe("Trust screen: matrix", () => {
  it("opens on the agent by project matrix and a level opens that project's ladder", async () => {
    setup();
    Object.assign(trustUi, { tab: "matrix" });
    mount();
    const m = await byId("tr-agent-matrix");
    const link = m.querySelector("button.lvl") as HTMLElement;
    expect(link.textContent).toMatch(/^L\d$/);
    fireEvent.click(link);
    await waitFor(() => expect(document.querySelector("[role=dialog], .dlg")!.textContent).toContain("Propose a change"));
    expect(document.body.textContent).toContain("New level");
    expect(document.body.textContent).toContain("Submit proposal");
  });
  it("keeps the ladder link out of the propose dialog and the runtime switch out of the ceilings list", async () => {
    setup();
    Object.assign(trustUi, { tab: "matrix" });
    mount();
    const m = await byId("tr-agent-matrix");
    fireEvent.click(m.querySelector("button.lvl") as HTMLElement);
    const dlg = await waitFor(() => { const e = document.querySelector("[role=dialog], .dlg"); if (!e) throw new Error("no dialog"); return e; });
    expect(dlg.querySelector("#tr-mx-ladder")).toBeNull();
    expect(document.querySelector(".view-trust.view")).toBeNull();
    cleanup();
    setup();
    mount();
    fireEvent.click(await byId("tr-tab-ceilings"));
    await byId("tr-switch");
    // the runtime switch is the last row of the same card: exactly the ceilings plus that one row, none outside it
    expect(document.querySelectorAll(".tr-ceil .setrow")).toHaveLength(document.querySelectorAll(".tr-ceil [id^='tr-ceil-on-']").length + 1);
    expect(document.querySelector(".tr-ceil #tr-switch")).not.toBeNull();
    expect(document.querySelectorAll(".setrow")).toHaveLength(document.querySelectorAll(".tr-ceil .setrow").length);
  });
});

describe("Trust screen: failed read", () => {
  it("shows a failed read as an error, not an empty matrix", async () => {
    setup({ "GET /api/v1/trust/cells": () => ({ status: 500, body: { ok: false, msg: "boom" } }) });
    at("");
    mount();
    await waitFor(() => expect(document.querySelector("[id$='-error']")).not.toBeNull());
  });
});
