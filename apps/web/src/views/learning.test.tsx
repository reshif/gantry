import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import LearningView, { learningFocus } from "./learning";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: any; headers: Record<string, string>; query: URLSearchParams }

const NOW = Date.now();
const DAY = 86_400_000;
const person = (id: string, name: string) => ({ id, name, title: "Engineer", email: `${id}@acme.dev`, teams: ["payments"], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "", away: null, version: 2 });
const ASHA = person("p-asha", "Asha Raman");
const OMAR = person("p-omar", "Omar Haddad");
const project = (id: string, name: string) => ({ id, name, key: id.toUpperCase(), status: "active", teams: [], owner: "p-asha", template: "t", regulated: false, desc: "", approvers: {}, notifications: [], mcp: [], budget: { monthly: 1000, mtd: 0, alertAt: 0.8 }, created: 0, halted: null, killed: null, overlay: "", version: 1 });
const PAYMENTS = project("payments", "Payments Platform");
const SKILL_BODY = "Write the spec from the brief. List the files to change.";
const SKILLS = [{ id: "sk-spec", name: "Spec writing", version: "1.2.0", body: SKILL_BODY, rev: 3, versions: [], projects: "all" }];
const AGENTS = [{ id: "ag-spec", name: "Spec agent", station: "spec", skills: ["sk-spec"], suite: "SUITE-SPEC", guardrails: { paths: [".github/workflows/**"], maxDiff: 800 }, initials: "S" }, { id: "ag-build", name: "Builder", station: "build", skills: [], suite: "SUITE-BUILD", guardrails: { paths: [], maxDiff: 0 }, initials: "B" }];
const SUITES = [{ id: "SUITE-SPEC", name: "Spec suite", station: "spec", threshold: 0.85, agent: "ag-spec", cases: [{ id: "c1" }, { id: "c2" }] }];
const FINDINGS = [
  { id: "F-1", title: "Gate rejections: missing rollback note", signal: "rejection", agent: "ag-spec", project: "payments", evidence: ["WO-1001", "WO-1002", "WO-1003"], count: 3, firstAt: NOW - 6 * DAY, lastAt: NOW - DAY, status: "open", rev: 1 },
  { id: "F-2", title: "Send-backs: unclear scope", signal: "sendback", agent: "ag-build", project: "payments", evidence: ["WO-1004", "WO-1005"], count: 2, firstAt: NOW - 5 * DAY, lastAt: NOW - 2 * DAY, status: "open", rev: 1 },
  { id: "F-3", title: "Eval regressions: Spec suite fell", signal: "regression", agent: "ag-spec", project: null, evidence: ["RUN-9"], count: 1, firstAt: NOW - DAY, lastAt: NOW - DAY, status: "addressed", rev: 2 },
];
const metric = { signal: "rejection", project: "payments", agent: "ag-spec", target: 1 };
const prop = (o: object) => ({ id: "LP-1", finding: "F-1", kind: "skill", title: "Spec writing: always include a rollback section", owner: "p-omar", status: "proposed", at: NOW - 3600_000, expected: "Fewer rejections for missing rollback notes.",
  change: { skill: "sk-spec", before: SKILL_BODY, after: `${SKILL_BODY} Always add a Rollback section.` }, history: [{ at: NOW - 3600_000, by: "p-omar", text: "Drafted from finding F-1" }], rev: 1, metric, windowDays: 14, baseline: null, appliedAt: null, appliedBy: null, rollback: null, verification: null, ...o });
const PROPOSALS = [
  prop({}),
  prop({ id: "LP-2", finding: "F-2", kind: "guardrail", title: "Builder guardrail", owner: "p-asha", change: { agent: "ag-build", path: "infra/**" }, metric: { ...metric, signal: "sendback", agent: "ag-build" } }),
  prop({ id: "LP-3", kind: "skill", status: "accepted", appliedAt: NOW - 20 * DAY, appliedBy: "p-asha", baseline: { count: 4, from: NOW - 34 * DAY, to: NOW - 20 * DAY }, rollback: { summary: "Saves Spec writing again with the text it had before as a new version.", available: true }, history: [{ at: NOW - 20 * DAY, by: "p-asha", text: "Accepted and applied. Spec writing saved as v1.2.0." }] }),
  prop({ id: "LP-4", kind: "route", status: "accepted", appliedAt: NOW - 2 * DAY, change: { project: "payments", cls: "refactor", addSkip: "build" }, rollback: { summary: "Puts Refactor back.", available: true }, history: [{ at: NOW - 2 * DAY, by: "p-asha", text: "Accepted and applied." }] }),
  prop({ id: "LP-5", status: "verified", verification: { measured: 0, target: 1, baseline: 4, at: NOW, by: "p-asha" }, appliedAt: NOW - 30 * DAY, rollback: { summary: "x", available: true } }),
  prop({ id: "LP-6", status: "declined", reason: "One incident is not enough.", history: [{ at: NOW, by: "p-asha", text: "Declined: One incident is not enough." }] }),
];
const SIGNALS = [
  { signal: "rejection", wo: "WO-1001", project: "payments", agent: "ag-spec", gate: "G2", text: "No rollback note", at: NOW - DAY },
  { signal: "sendback", wo: "WO-1004", project: "payments", agent: "ag-build", text: "Unclear scope", at: NOW - 2 * DAY },
  { signal: "regression", wo: "", ref: "RUN-9", project: null, agent: "ag-spec", text: "Spec suite fell from 90% to 80% (RUN-9)", at: NOW - 3 * DAY },
  { signal: "miss", wo: "WO-0900", project: "payments", agent: "ag-intake", text: "Old miss", at: NOW - 20 * DAY },
];

function me(p: typeof ASHA) {
  return { person: p, session: { id: "s1", person: p.id, method: "sso", device: "Chrome", ip: "1", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: [PAYMENTS], factory: { killed: null }, config: {} };
}

function setup(extra: Record<string, Handler> = {}, o: { denied?: string[]; as?: typeof ASHA; settings?: object; proposals?: unknown[] } = {}) {
  const calls: Call[] = [];
  const who = o.as ?? ASHA;
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: me(who) }),
    "GET /api/v1/people": () => ({ body: [ASHA, OMAR] }),
    "GET /api/v1/projects": () => ({ body: [PAYMENTS] }),
    "GET /api/v1/agents": () => ({ body: AGENTS }),
    "GET /api/v1/skills": () => ({ body: SKILLS }),
    "GET /api/v1/suites": () => ({ body: SUITES }),
    "GET /api/v1/catalog": () => ({ body: DEFAULT_CATALOG }),
    "GET /api/v1/learning/findings": () => ({ body: FINDINGS }),
    "GET /api/v1/learning/proposals": () => ({ body: o.proposals ?? PROPOSALS }),
    "GET /api/v1/learning/signals": () => ({ body: SIGNALS }),
    "GET /api/v1/learning/settings": () => ({ body: { proposalsOn: true, otherDeciders: 1, ...(o.settings ?? {}) } }),
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
      return new Response(JSON.stringify({ results: checks.map((c) => ((o.denied ?? []).includes(c.action) ? { allowed: false, reason: `No role holds ${c.action}.`, needs: "Needs Factory Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "", needs: "" })) }));
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
  learningFocus({ tab: "proposals" });
  return render(<QueryClientProvider client={qc}><OverlayProvider><LearningView /></OverlayProvider></QueryClientProvider>);
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.path !== "/api/v1/can");
const type = (el: HTMLElement, v: string) => fireEvent.change(el, { target: { value: v } });

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Learning screen (legacy learning.js on the real API)", () => {
  beforeEach(() => window.history.replaceState(null, "", "/?tab=proposals"));
  it("shows the title block, the status strip and one card per proposal with its change, metric and pipeline", async () => {
    setup();
    mount();
    const card = await byId("ln-prop-LP-1");
    expect(document.body.textContent).toContain("Open findings2");
    expect(document.body.textContent).toContain("Proposals waiting2");
    expect(document.body.textContent).toContain("Accepted, 30d");
    expect(document.body.textContent).toContain("Avg eval lift");
    expect(document.body.textContent).not.toContain("To review");
    expect(document.querySelector("label[for=ln-st-open]")).toBeNull();
    expect(document.getElementById("ln-off")).toBeNull();
    expect(Array.from(document.querySelectorAll(".ln-list > div")).map((e) => e.id).slice(0, 2)).toEqual(["ln-prop-LP-1", "ln-prop-LP-2"]);
    expect(card.textContent).toContain("LP-1");
    expect(card.textContent).toContain("From finding");
    expect(card.textContent).toContain("Proposed");
    expect(card.querySelector(".chip.plain")?.textContent).toBe("eval lift not available");
    const diff = card.querySelector("pre.code.diff")!;
    expect(diff.querySelector(".del")?.textContent?.startsWith("- ")).toBe(true);
    expect(diff.querySelector(".add")?.textContent).toContain("Always add a Rollback section.");
    expect(card.querySelector(".ln-kv")).toBeNull();
    expect(document.querySelectorAll("#ln-prop-LP-6").length).toBe(1);
    expect((await byId("ln-prop-LP-6")).textContent).toContain("Declined");
  });

  it("locks Accept for the drafter while a second person exists, and says why", async () => {
    setup();
    mount();
    const b = await byId("ln-accept-LP-2");
    await waitFor(() => expect(b.getAttribute("data-reason")).toMatch(/You drafted this proposal, so someone else decides it/));
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect((await byId("ln-accept-LP-1")).getAttribute("aria-disabled")).toBeNull();
  });

  it("lets the only eligible person accept their own draft", async () => {
    setup({}, { settings: { otherDeciders: 0 } });
    mount();
    await byId("ln-prop-LP-2");
    await waitFor(() => expect(document.getElementById("ln-accept-LP-2")?.getAttribute("aria-disabled")).toBeNull());
  });

  it("accepts through the real command with a note, and shows a refusal inline", async () => {
    let n = 0;
    const calls = setup({ "POST /api/v1/learning/proposals/LP-1/accept": () => (++n === 1 ? { status: 409, body: { ok: false, msg: "Spec writing changed since this was drafted. Decline it and draft it again from the current text." } } : { body: { ok: true, msg: "LP-1 applied. Spec writing saved as v1.3.0." } }) });
    mount();
    fireEvent.click(await byId("ln-accept-LP-1"));
    const ok = await byId("ln-acc-ok");
    expect(document.querySelector(".dlg")?.textContent).toContain("Applies the change now through the normal operation");
    type(await byId("ln-acc-note"), "Looks right");
    fireEvent.click(ok);
    await waitFor(() => expect(document.querySelector(".form-err")?.textContent).toMatch(/changed since this was drafted/));
    fireEvent.click(ok);
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]).toMatchObject({ method: "POST", path: "/api/v1/learning/proposals/LP-1/accept", body: { note: "Looks right" } });
    await waitFor(() => expect(document.getElementById("ln-acc-ok")).toBeNull());
  });

  it("declines with a reason of at least four characters", async () => {
    const calls = setup({ "POST /api/v1/learning/proposals/LP-1/decline": () => ({ body: { ok: true, msg: "LP-1 declined." } }) });
    mount();
    fireEvent.click(await byId("ln-decline-LP-1"));
    const ta = await waitFor(() => { const e = document.querySelector<HTMLTextAreaElement>("#rsn-text"); if (!e) throw new Error("no field"); return e; });
    type(ta, "no");
    const ok = Array.from(document.querySelectorAll<HTMLButtonElement>(".dlg .btn")).find((b) => b.textContent === "Decline")!;
    fireEvent.click(ok);
    expect(writes(calls)).toHaveLength(0);
    type(ta, "Not now");
    fireEvent.click(ok);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ path: "/api/v1/learning/proposals/LP-1/decline", body: { reason: "Not now" } });
  });

  it("verifies only once the declared window has run, and the server's refusal is shown", async () => {
    const calls = setup({ "POST /api/v1/learning/proposals/LP-3/verify": () => ({ status: 409, body: { ok: false, msg: "Not verified: 3 rejection signals in the 14 days after it was applied, against a target of at most 1." } }) });
    mount();
    const early = await byId("ln-verify-LP-4");
    expect(early.getAttribute("data-reason")).toMatch(/The window runs until/);
    fireEvent.click(await byId("ln-verify-LP-3"));
    expect(document.querySelector(".dlg")?.textContent).toContain("at most 1 gate rejection signal in the 14 days after it was applied; before it there were 4 in 14 days");
    fireEvent.click(await byId("ln-ver-ok"));
    await waitFor(() => expect(document.querySelector(".form-err")?.textContent).toMatch(/Not verified: 3 rejection signals/));
    expect(writes(calls)[0]).toMatchObject({ method: "POST", path: "/api/v1/learning/proposals/LP-3/verify" });
  });

  it("rolls an applied change back with a reason, and offers it for a verified one too", async () => {
    const calls = setup({ "POST /api/v1/learning/proposals/LP-3/rollback": () => ({ body: { ok: true, msg: "LP-3 rolled back." } }) });
    mount();
    expect(await byId("ln-rollback-LP-5")).toBeTruthy();
    expect(document.getElementById("ln-rollback-LP-1")).toBeNull();
    fireEvent.click(await byId("ln-rollback-LP-3"));
    const ta = await waitFor(() => { const e = document.querySelector<HTMLTextAreaElement>("#rsn-text"); if (!e) throw new Error("no field"); return e; });
    expect(document.querySelector(".dlg")?.textContent).toContain("Saves Spec writing again with the text it had before");
    type(ta, "It slowed the specs down");
    fireEvent.click(Array.from(document.querySelectorAll<HTMLButtonElement>(".dlg .btn")).find((b) => b.textContent === "Roll back")!);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ path: "/api/v1/learning/proposals/LP-3/rollback", body: { reason: "It slowed the specs down" } });
  });

  it("locks every control with the reason when the person lacks the right", async () => {
    setup({}, { denied: ["learning.apply"] });
    mount();
    const b = await byId("ln-accept-LP-1");
    await waitFor(() => expect(b.getAttribute("data-reason")).toMatch(/Needs Factory Admin. No role holds learning.apply/));
    expect((await byId("ln-decline-LP-1")).getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById("ln-switch")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("says proposals are switched off, locks drafting, accepting and verifying, and turns them on with a reason", async () => {
    let on = false;
    const calls = setup({
      "GET /api/v1/learning/settings": () => ({ body: { proposalsOn: on, otherDeciders: 1 } }),
      "PUT /api/v1/learning/switch": () => { on = true; return { body: { ok: true, msg: "Learning proposals are on." } }; },
    });
    mount();
    expect((await byId("ln-switch")).textContent).toContain("Turn on proposals");
    expect((await byId("ln-accept-LP-1")).getAttribute("data-reason")).toMatch(/Learning proposals are switched off/);
    expect((await byId("ln-decline-LP-1")).getAttribute("data-reason")).toMatch(/switched off/);
    fireEvent.click(await byId("ln-switch"));
    const ta = await waitFor(() => { const e = document.querySelector<HTMLTextAreaElement>("#rsn-text"); if (!e) throw new Error("no field"); return e; });
    type(ta, "Trying the loop");
    fireEvent.click(Array.from(document.querySelectorAll<HTMLButtonElement>(".dlg .btn")).find((b) => b.textContent === "Turn on")!);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "PUT", path: "/api/v1/learning/switch", body: { on: true, reason: "Trying the loop" } });
    await waitFor(() => expect(document.getElementById("ln-switch")!.textContent).toContain("Turn off proposals"));
  });

  it("lists findings with their agent, project, signals and evidence, marks a small sample, and refreshes", async () => {
    setup();
    mount();
    fireEvent.click(await byId("ln-tab-findings"));
    const f1 = await byId("ln-f-F-1");
    expect(f1.textContent).toContain("Spec agent");
    expect(f1.textContent).toContain("Open");
    const f3 = await byId("ln-f-F-3");
    expect(f3.textContent).toContain("Addressed");
    expect(f3.querySelector("a[href*='record']") ?? f3.querySelector(".mono")).not.toBeNull();
    expect(Array.from(document.querySelectorAll("#ln-f-table tbody tr")).map((e) => e.id)).toEqual(["ln-f-F-1", "ln-f-F-2", "ln-f-F-3"]);
    fireEvent.change(await byId("ln-search"), { target: { value: "zzz" } });
    await waitFor(() => expect(window.location.search).toContain("q=zzz"));
    expect(document.body.textContent).toContain("Nothing matches");
    fireEvent.click(await byId("ln-clear-empty"));
    await waitFor(() => expect(window.location.search).not.toContain("q="));
    expect(document.querySelector("#ln-f-table thead")!.textContent).not.toContain("Draft");
    expect(f1.querySelector(".chip.plain")!.textContent).toBe("rejection");
  });

  it("drafts a proposal: declares the metric and window before anything is applied, and sends the change", async () => {
    const calls = setup({ "POST /api/v1/learning/proposals": () => ({ body: { ok: true, msg: "LP-7 drafted.", proposal: prop({ id: "LP-7", owner: "p-asha" }) } }) });
    mount();
    fireEvent.click(await byId("ln-tab-findings"));
    fireEvent.click(await byId("ln-open-F-1"));
    await byId("ln-draft-form");
    expect((document.getElementById("ln-d-kind") as HTMLSelectElement).value).toBe("skill");
    expect((document.getElementById("ln-d-metric") as HTMLInputElement).value).toBe("1");
    expect((document.getElementById("ln-d-window") as HTMLInputElement).value).toBe("14");
    // validation before the call
    fireEvent.click(await byId("ln-d-ok"));
    expect(document.querySelector(".form-err")?.textContent).toBe("Give the proposal a title.");
    fireEvent.click(await byId("ln-d-local"));
    await waitFor(() => expect((document.getElementById("ln-d-title") as HTMLInputElement).value).toContain("Spec writing: address gate rejections: missing rollback note"));
    expect(document.getElementById("ln-draft-stream")?.textContent).toContain("Review every field before saving.");
    expect((document.getElementById("ln-d-after") as HTMLTextAreaElement).value).toContain("Check for this before finishing");
    type(document.getElementById("ln-d-window")!, "0");
    fireEvent.click(await byId("ln-d-ok"));
    expect(document.querySelector(".form-err")?.textContent).toBe("State the window in days, from 1 to 90.");
    type(document.getElementById("ln-d-window")!, "7");
    type(document.getElementById("ln-d-metric")!, "0");
    fireEvent.click(await byId("ln-d-ok"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const w = writes(calls)[0]!;
    expect(w).toMatchObject({ method: "POST", path: "/api/v1/learning/proposals", body: { finding: "F-1", kind: "skill", change: { skill: "sk-spec" }, metric: { target: 0 }, windowDays: 7 } });
    expect(w.body.change.after).toContain("Check for this before finishing");
    expect(w.headers["idempotency-key"]).toBeTruthy();
    // back on the proposals tab with the new one highlighted
    await waitFor(() => expect(document.getElementById("ln-tab-proposals")?.getAttribute("aria-selected")).toBe("true"));
  });

  it("offers only stations a route proposal may skip, and sends the other kinds' changes in their shapes", async () => {
    const calls = setup({ "POST /api/v1/learning/proposals": () => ({ body: { ok: true, msg: "LP-8 drafted.", proposal: prop({ id: "LP-8" }) } }) });
    mount();
    fireEvent.click(await byId("ln-tab-findings"));
    fireEvent.click(await byId("ln-open-F-2"));
    await byId("ln-draft-form");
    expect((document.getElementById("ln-d-kind") as HTMLSelectElement).value).toBe("guardrail");
    type(document.getElementById("ln-d-title")!, "Builder: no ledger");
    type(document.getElementById("ln-d-path")!, "services/ledger/**");
    fireEvent.click(await byId("ln-d-ok"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toMatchObject({ kind: "guardrail", change: { agent: "ag-build", path: "services/ledger/**" }, title: "Builder: no ledger" });
  });

  it("lists the route options without any station a human gate follows", async () => {
    setup();
    mount();
    fireEvent.click(await byId("ln-tab-findings"));
    fireEvent.click(await byId("ln-open-F-1"));
    await byId("ln-draft-form");
    type(await byId("ln-d-kind"), "route");
    const skip = await byId("ln-d-skip");
    const options = Array.from(skip.querySelectorAll("option")).map((o) => o.getAttribute("value"));
    expect(options).toContain("research");
    expect(options).toContain("build");
    for (const bad of ["intake", "spec", "design", "plan", "verify", "review", "close"]) expect(options).not.toContain(bad);
  });
});

describe("Learning screen: prototype structure", () => {
  it("has exactly the Findings and Proposals tabs, with the tab in the URL, and evidence links go to the record route by work order id alone", async () => {
    setup();
    window.history.replaceState(null, "", "/");
    mount();
    fireEvent.click(await byId("ln-tab-findings"));
    await byId("ln-f-table");
    expect([...document.querySelectorAll("[role=tab][id^='ln-tab-']")].map((e) => (e.textContent ?? "").replace(/\d+$/, ""))).toEqual(["Findings", "Proposals"]);
    const a = document.querySelector("#ln-f-table a.mono") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toMatch(/record\/WO-[0-9]+$/);
    fireEvent.click(document.getElementById("ln-tab-proposals")!);
    await waitFor(() => expect(window.location.search).toContain("tab=proposals"));
  });
});

describe("Learning screen: round 3 fidelity", () => {
  it("has no header action and no nested .view wrapper; the proposals switch lives on the Proposals tab", async () => {
    setup();
    window.history.replaceState(null, "", "/");
    mount();
    await byId("ln-stats");
    expect(document.querySelector(".ph .acts")).toBeNull();
    expect(document.querySelector(".view-learning.view")).toBeNull();
    expect(document.querySelector(".ph #ln-switch")).toBeNull();
    fireEvent.click(await byId("ln-tab-proposals"));
    expect((await byId("ln-switch")).closest("#ln-switch-row")).not.toBeNull();
    expect(document.getElementById("ln-switch")!.closest(".ph")).toBeNull();
  });
  it("draws a skill proposal with no earlier text as one added line, not an empty removed line", async () => {
    setup({}, { proposals: [prop({ change: { skill: "sk-spec", before: "", after: "Always end a spec with a rollback note." } })] });
    window.history.replaceState(null, "", "/?tab=proposals");
    mount();
    const pre = (await waitFor(() => { const e = document.querySelector("pre.diff"); if (!e) throw new Error("no diff"); return e; }));
    expect([...pre.children].map((c) => c.textContent)).toEqual(["+ Always end a spec with a rollback note."]);
  });
});

describe("Learning screen: a read the person may not make", () => {
  it("says Not visible to you, not an empty list, when the primary read is refused", async () => {
    setup({ "GET /api/v1/learning/proposals": () => ({ status: 403, body: { ok: false, msg: "Your roles do not include learning.view." } }) });
    mount();
    await waitFor(() => expect(document.getElementById("ln-proposals-hidden")?.textContent).toContain("Not visible to you"));
    expect(document.getElementById("ln-proposals-hidden")?.textContent).toContain("learning.view");
  });
});

describe("Learning screen: evidence", () => {
  it("shows a work order id alone and links the record of that id, even when the evidence is a sentence", async () => {
    setup({ "GET /api/v1/learning/findings": () => ({ body: [{ ...FINDINGS[0]!, evidence: ["WO-1004 rejected at G2", "WO-1013 rejected at G2"] }] }) });
    window.history.replaceState(null, "", "/");
    mount();
    fireEvent.click(await byId("ln-tab-findings"));
    await byId("ln-f-table");
    const links = [...document.querySelectorAll<HTMLAnchorElement>("#ln-f-table a.mono")];
    expect(links.map((a) => a.textContent)).toEqual(["WO-1004", "WO-1013"]);
    expect(links[0]!.getAttribute("href")).toMatch(/record\/WO-1004$/);
  });
});
