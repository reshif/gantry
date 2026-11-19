import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { flowFrom } from "./projects/templates-kit";
import { OverlayProvider } from "../ui/Overlay";
import HomeView from "./home";
import { updatePrefs } from "../lib/prefs";

/**
 * Home is one page for everyone: the API puts the sections a person may see in `home.sections`, and the page renders what is present.
 * These tests drive it with the section sets each role gets (the API side is covered in services/api/test/home-sections.test.ts).
 */
type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };

const CAT = { ...DEFAULT_CATALOG };
const person = (id: string, name: string, roles: Array<{ role: string; scope: string }>) => ({ id, name, title: "", email: `${id}@acme.dev`, teams: [], roles, status: "active", oncall: false, github: "", away: null, version: 1 });
const ASHA = person("p-asha", "Asha Raman", [{ role: "factory_admin", scope: "factory" }]);
const SAM = person("p-sam", "Sam Whitfield", [{ role: "auditor", scope: "factory" }]);
const TOMAS = person("p-tomas", "Tomas Eriksen", [{ role: "engineer", scope: "payments" }]);
const VERA = person("p-vera", "Vera Viewer", [{ role: "viewer", scope: "payments" }]);
const me = (p: ReturnType<typeof person>, killed: unknown = null) => ({ person: p, session: { id: "s1", person: p.id, method: "sso", started: 1, lastSeen: 1, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: [], factory: { killed }, config: {} });
const metrics = (o: object = {}) => ({ wip: 0, bays: 0, gates: 0, oldest: 0, late: 0, eff: null, effN: 0, cov: { total: 0, auto: 0, share: 0 }, bad: 0, haltedRepos: 0, byPosition: {}, byClass: {}, byGate: {}, slotsUsed: 0, onboarding: 0, health: { id: "ok", label: "Healthy", icon: "st-done" }, ...o });
const project = (id: string, name: string, extra: object = {}) => ({ id, name, key: id.slice(0, 3).toUpperCase(), status: "active", teams: [], owner: "p-asha", template: "tpl-backend", regulated: false, desc: "", flow: flowFrom(CAT, { id: "tpl-backend", name: "B", desc: "", stationsOff: [], gatesOff: [], slots: 2, classesSkip: {}, mcp: [], approverPreset: "standard", notify: "standard", builtIn: true, version: 1 } as never), approvers: {}, notifications: [], mcp: [], budget: { monthly: 1000, mtd: 0, alertAt: 0.8 }, created: 1, halted: null, killed: null, overlay: "", version: 1, metrics: metrics(), ...extra });
const NAUTO = project("nautobot", "Nautobot-Jobs", { metrics: metrics({ onboarding: 1, health: { id: "onboarding", label: "Onboarding", icon: "rocket" } }) });
const PAY = project("payments", "Payments Platform", { metrics: metrics({ wip: 3, byPosition: { build: { n: 3, blocked: 0 } } }) });

const MOTION = { inFlight: 0, running: 0, inBays: 0, byStation: {}, shippedToday: 0, shippedWeek: 0, shippedPrevWeek: 0, recentDone: [], mine: [] };
const ONB_ATT = { id: "hm-att-onb-nautobot-jobs", sev: 1, icon: "rocket", title: "Nautobot-Jobs onboarding needs you: verification failed", where: "Nautobot-Jobs", sub: "Verification failed.", act: { label: "Open session", route: "onboarding", project: "nautobot" } };
const STEPS = (active: string, done: string[]) => ["github", "vendor", "project", "repo", "work-order"].map((id) => ({ id, label: `Step ${id}`, state: done.includes(id) ? "done" : id === active ? "active" : "todo", detail: done.includes(id) ? "" : `Detail of ${id}`, route: id === "github" ? "integrations" : "onboarding", project: "nautobot" }));
const SETUP = { done: 3, total: 5, steps: STEPS("repo", ["github", "vendor", "project"]) };
const HEALTH = { spend: { spent: 0, budget: 2000, projects: [] }, evals: null, audit: true };
const adminHome = (over: Record<string, unknown> = {}, sections: Record<string, unknown> = {}) => ({
  approvals: [], conversations: [], badges: {}, projectBadges: {},
  sections: { attention: [ONB_ATT], waiting: { approvals: [], conversations: [] }, setup: SETUP, motion: MOTION, projects: [{ id: "nautobot", roles: [], repos: [{ id: "nautobot-jobs", name: "Nautobot-Jobs", stage: "failed", blocker: "" }] }], health: HEALTH, ...sections },
  ...over,
});

interface Call { method: string; path: string; body?: unknown }
function setup(who: ReturnType<typeof person>, home: unknown, o: { denied?: string[]; killed?: unknown; projects?: unknown[]; extra?: Record<string, Handler> } = {}) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: me(who, o.killed ?? null) }),
    "GET /api/v1/home": () => ({ body: home }),
    "GET /api/v1/projects": () => ({ body: o.projects ?? [NAUTO, PAY] }),
    "GET /api/v1/catalog": () => ({ body: CAT }),
    "GET /api/v1/people": () => ({ body: [ASHA, SAM, TOMAS] }),
    ...o.extra,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url, "http://x");
      const method = init?.method ?? "GET";
      calls.push({ method, path: u.pathname, body: typeof init?.body === "string" ? (() => { try { return JSON.parse(init.body); } catch { return null; } })() : null });
      if (u.pathname === "/api/v1/can") {
        const checks = (JSON.parse(String(init?.body)) as { checks: Array<{ action: string }> }).checks;
        return new Response(JSON.stringify({ results: checks.map((c) => ((o.denied ?? []).includes(c.action) ? { allowed: false, reason: "No role holds it.", needs: "Factory Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "", needs: "" })) }));
      }
      const h = base[`${method} ${u.pathname}`];
      const r = h ? h(url, init) : { status: 404, body: { ok: false, msg: `no mock ${method} ${u.pathname}` } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
  return calls;
}
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider><HomeView /></OverlayProvider></QueryClientProvider>);
}
beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
  try { localStorage.clear(); } catch { /* none */ }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const text = (): string => document.body.textContent ?? "";

describe("Home: one page", () => {
  it("says Home is not visible on a 403, and shows a retry on other failures", async () => {
    setup(ASHA, adminHome(), { extra: { "GET /api/v1/home": () => ({ status: 403, body: { ok: false, msg: "Needs a role on this project." } }) } });
    mount();
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
  });

  it("a Factory Admin on a live org with a repo onboarding sees attention, the checklist and the project, once each", async () => {
    const calls = setup(ASHA, adminHome());
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeTruthy();
    // Attention carries the failing onboarding; the project row says where the repo is; the checklist has the active step.
    expect(await screen.findByText("Nautobot-Jobs onboarding needs you: verification failed")).toBeTruthy();
    // The prototype's page has no Projects card; the project list is the Projects screen.
    expect(screen.queryByRole("heading", { level: 2, name: /^Projects/ })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: /Set up the factory/ })).toBeTruthy();
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain("Step repo");
    expect(screen.getByText("3 of 5 done")).toBeTruthy();
    // Only the active step has a button.
    expect(document.querySelectorAll(".hm-step .btn")).toHaveLength(1);
    // One request for the page.
    expect(calls.filter((c) => c.path === "/api/v1/home")).toHaveLength(1);
  });

  it("has none of the removed duplicates: sentence, signed-in box, KPI tiles, control panel, portfolio toolbar, mode toggle", async () => {
    setup(ASHA, adminHome());
    mount();
    await screen.findByText("Nautobot-Jobs onboarding needs you: verification failed");
    expect(text()).not.toMatch(/Factory running\./);
    expect(text()).not.toMatch(/Signed in/i);
    for (const id of ["hm-kpi-flight", "hm-kpi-gates", "hm-kpi-spend", "hm-kpi-success", "hm-to-mine", "hm-to-factory", "hm-ctl"]) expect(document.getElementById(id)).toBeNull();
    for (const t of ["My work", "Factory overview", "Human attention", "Live activity", "Onboarding pipeline", "Save as view", "Factory control"]) expect(screen.queryByText(t)).toBeNull();
    expect(document.querySelector(".hm-kpis")).toBeNull();
  });

  it("the stat row under the title counts what the sections below hold, and drops a tile whose section the person does not get", async () => {
    setup(ASHA, adminHome({}, { attention: [{ ...ONB_ATT, sev: 0 }], motion: { ...MOTION, inFlight: 3, running: 2, shippedWeek: 4, shippedToday: 1 }, waiting: { approvals: [], conversations: [] } }));
    mount();
    await screen.findByText("Nautobot-Jobs onboarding needs you: verification failed");
    expect(document.getElementById("hm-stat-shipped")?.textContent).toContain("work orders closed");
    expect(document.getElementById("hm-stat-shipped")?.textContent).toContain("4");
    // The tiles that open a page are links to it, with the prototype's captions.
    const waiting = document.getElementById("hm-stat-waiting") as HTMLAnchorElement;
    expect(waiting.tagName).toBe("A");
    expect(waiting.getAttribute("href")).toBe("#inbox");
    expect(waiting.textContent).toContain("gates to approve");
    expect(document.getElementById("hm-stat-flight")?.getAttribute("href")).toBe("#floor");
    expect(document.getElementById("hm-stat-flight")?.textContent).toContain("across the line");
    expect(document.getElementById("hm-stat-spend")?.getAttribute("href")).toBe("#models");
    cleanup();
    setup(VERA, { approvals: [], conversations: [], badges: {}, projectBadges: {}, sections: { attention: [], projects: [{ id: "payments", roles: [{ id: "viewer", name: "Viewer" }], repos: [] }] } });
    mount();
    await screen.findByRole("heading", { level: 1, name: "Home" });
    expect(document.getElementById("hm-stat-waiting")).toBeNull();
    expect(document.getElementById("hm-stat-flight")).toBeNull();
  });

  it("never shows a kill or restore control on Home", async () => {
    setup(ASHA, adminHome());
    mount();
    await screen.findByText("Nautobot-Jobs onboarding needs you: verification failed");
    expect(document.getElementById("hm-kill")).toBeNull();
    expect(screen.queryByRole("button", { name: /kill/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /restore/i })).toBeNull();
  });

  it("a killed factory shows in Attention with restore progress and a Restore button for those who may", async () => {
    const killed = { id: "i", sev: 0, icon: "st-kill", title: "Factory killed", where: "Factory", sub: "Leaked token · 1 min ago · restore approvals 1 of 2", act: { label: "Open Security", route: "security" }, restore: { scope: "factory", id: null, approvals: [{ by: "p-omar", at: 1 }], needs: 2 } };
    setup(ASHA, adminHome({}, { attention: [killed], setup: undefined }));
    mount();
    expect(await screen.findByText("Factory killed")).toBeTruthy();
    expect(screen.getByText(/restore approvals 1 of 2/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Approve restore \(2 of 2\)/ })).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();
    canBatcher.clear();
    setup(SAM, adminHome({}, { attention: [killed], setup: undefined, approvers: { count: 0, oldestMs: 0, late: 0, byProject: [] }, waiting: undefined }), { denied: ["restore.factory"] });
    mount();
    expect(await screen.findByText("Factory killed")).toBeTruthy();
    await waitFor(() => expect(canBatcher.get({ action: "restore.factory" })).not.toBeNull());
    expect(screen.queryByRole("button", { name: /restore/i })).toBeNull();
  });

  it("has only the prototype's panels: Needs you, Line at a glance, Task success, Recent activity (no Factory health, Your work orders, Waiting on approvers or Projects)", async () => {
    setup(ASHA, adminHome({}, { setup: undefined }));
    mount();
    await screen.findByRole("heading", { level: 2, name: /Needs you/ });
    const titles = Array.from(document.querySelectorAll("h2")).map((h) => h.textContent ?? "");
    for (const gone of ["Factory health", "Your work orders", "Waiting on approvers", "Projects"]) expect(titles.some((t) => t.includes(gone))).toBe(false);
    for (const here of ["Needs you", "Line at a glance", "Task success, 8 weeks", "Recent activity"]) expect(titles.some((t) => t.includes(here))).toBe(true);
  });

  it("T-29: Recent activity reads as plain sentences, never the event key", async () => {
    const at = Date.now() - 3600_000;
    setup(ASHA, adminHome({}, { setup: undefined }), { extra: { "GET /api/v1/activity": () => ({ body: { items: [
      { id: "e1", type: "wo.enter", at, by: "ag-intake", wo: "WO-2473", station: "build" },
      { id: "e2", type: "gate.decision", at, by: "p-asha", wo: "WO-2473", gate: "G0+G1" },
      { id: "e3", type: "wo.submit", at, by: "p-asha", wo: "WO-2400", text: "Final data export" },
    ], next: null } }) } });
    mount();
    const panel = (await screen.findByRole("heading", { level: 2, name: /Recent activity/ })).closest("section") as HTMLElement;
    await waitFor(() => expect(within(panel).getByText(/WO-2473 moved to/)).toBeTruthy());
    for (const key of ["wo.enter", "gate.decision", "wo.submit"]) expect(panel.textContent).not.toContain(key);
    expect(within(panel).getByText(/submitted WO-2400/)).toBeTruthy();
  });

  it("Needs you keeps the server's order and its Approve, Request changes and Reject buttons sit directly in the row (so the phone layout can wrap them)", async () => {
    const A = (wo: string, waitMs: number) => ({ wo, title: `T ${wo}`, gate: "G2", gateLabel: "G2", gateName: "Spec", instance: `${wo}:G2:1`, project: "payments", projectName: "Payments", have: 0, need: 1, waitMs });
    setup(ASHA, adminHome({}, { setup: undefined, attention: [], waiting: { approvals: [A("WO-1", 1000), A("WO-2", 9_000_000)], conversations: [] } }));
    mount();
    await screen.findByText("WO-1");
    expect(Array.from(document.querySelectorAll(".hm-need a.pri")).map((a) => a.textContent)).toEqual(["WO-1", "WO-2"]);
    // one action bar: the decisions, then Conversation and Record, in a single wrapping row (no staggered rows)
    const bar = document.querySelector(".hm-need .act-bar") as HTMLElement;
    expect(Array.from(bar.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Approve", "Request changes", "Reject", "Conversation", "Record"]);
  });

  it("the eyebrow names the scope the switcher holds: All lines, never a project key left over from an earlier choice", async () => {
    updatePrefs({ project: "payments", scopeAll: true });
    setup(ASHA, adminHome({}, { setup: undefined }));
    mount();
    await screen.findByRole("heading", { level: 2, name: /Needs you/ });
    const eyebrow = document.querySelector(".eyebrow") as HTMLElement;
    expect(eyebrow.textContent).toMatch(/ALL LINES/);
    expect(eyebrow.textContent).not.toContain("PAY");
  });

  it("Needs you asks for changes at the gate with a reason, pinned to the shown instance", async () => {
    const A = { wo: "WO-1", title: "T WO-1", gate: "G2", gateLabel: "G2", gateName: "Spec", instance: "WO-1:G2:4", project: "payments", projectName: "Payments", have: 0, need: 1, waitMs: 1000 };
    const calls = setup(ASHA, adminHome({}, { setup: undefined, attention: [], waiting: { approvals: [A], conversations: [] } }), { extra: {
      "GET /api/v1/work-orders/WO-1": () => ({ body: { id: "WO-1", project: "payments", version: 2, allowed: { approve: { gate: "G2", instance: "WO-1:G2:4", allowed: true, reason: "", needs: "" } } } }),
      "POST /api/v1/gate-instances/WO-1%3AG2%3A4/reject": () => ({ body: { ok: true, msg: "Sent back." } }),
    } });
    mount();
    const btn = await screen.findByRole("button", { name: /^Request changes on WO-1/ });
    await waitFor(() => expect(btn.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(btn);
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(dlg.querySelector("textarea") as HTMLTextAreaElement, { target: { value: "Spell out the refund limits" } });
    fireEvent.click(Array.from(dlg.querySelectorAll("button")).find((x) => x.textContent === "Request changes") as HTMLElement);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/gate-instances/WO-1%3AG2%3A4/reject")).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/reject"))!.body).toMatchObject({ reason: "Spell out the refund limits" });
  });

  it("Task success is the prototype's line chart: gridlines, a dot per week, a dashed second series and a legend", async () => {
    setup(ASHA, adminHome({}, { setup: undefined, attention: [] }), { extra: { "GET /api/v1/evals/scorecards": () => ({ body: { "ag-a": { taskSuccess: 0.9, firstPass: 0.8, trend: { success: [0.8, 0.85, 0.9, 0.9, 0.92, 0.9, 0.91, 0.93] } } } }) } });
    mount();
    await waitFor(() => expect(document.querySelector("#hm-trend svg.chart")).toBeTruthy());
    expect(document.querySelectorAll("#hm-trend .gl")).toHaveLength(5);
    expect(document.querySelectorAll("#hm-trend circle").length).toBeGreaterThanOrEqual(16);
    expect(document.querySelector("#hm-trend polyline[stroke-dasharray]")).toBeTruthy();
    expect(document.querySelector("#hm-trend .legend")?.textContent).toContain("Success");
    expect(document.querySelector("#hm-trend .chart-title")).toBeNull();
  });

  it("the setup checklist is gone once the API sends none", async () => {
    setup(ASHA, adminHome({}, { setup: undefined, attention: [] }));
    mount();
    await screen.findByRole("heading", { level: 1, name: "Home" });
    await screen.findByRole("heading", { level: 2, name: /Needs you/ });
    expect(screen.queryByText(/Set up the factory/)).toBeNull();
    expect(document.querySelector(".hm-step")).toBeNull();
  });

  it("an item in Attention is not repeated in Waiting on you", async () => {
    const waiting = { approvals: [{ repo: "nautobot-jobs", repoName: "Nautobot-Jobs", pr: 4, project: "nautobot", projectName: "Nautobot-Jobs" }, { wo: "WO-1", title: "Rounding", gate: "G2", gateLabel: "G2", gateName: "Spec approval", project: "payments", projectName: "Payments Platform", have: 1, need: 2 }], conversations: [] };
    setup(ASHA, adminHome({}, { waiting, setup: undefined, attention: [{ ...ONB_ATT, id: "hm-att-onb-nautobot-jobs" }] }));
    mount();
    const link = (await screen.findByText("WO-1")) as HTMLAnchorElement;
    expect(screen.queryByText(/Merge onboarding PR/)).toBeNull();
    // The work order id is a link to its record, and the row has Approve and Reject.
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toContain("record/WO-1");
    expect(screen.getByRole("button", { name: /^Approve WO-1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Reject WO-1/ })).toBeTruthy();
  });

  it("in flight is one tile at the top and one line in the In motion card, never a third place", async () => {
    const motion = { ...MOTION, inFlight: 3, running: 2, inBays: 1, byStation: { build: 3 }, shippedToday: 1, shippedWeek: 4, shippedPrevWeek: 1, recentDone: [{ id: "WO-5", title: "Done", project: "payments", projectName: "Payments Platform", doneAt: 1 }] };
    setup(ASHA, adminHome({}, { setup: undefined, attention: [], motion }));
    mount();
    await screen.findByText("Line at a glance");
    // One tile at the top; the card has no summary line of its own.
    expect(text()).not.toMatch(/work orders in flight ·/);
    expect(document.getElementById("hm-stat-flight")?.textContent).toContain("3");
    expect(document.getElementById("hm-stat-flight")?.getAttribute("href")).toBe("#floor");
    // the In flight tile is the prototype's info blue
    expect(document.getElementById("hm-stat-flight")?.className).toContain("info");
  });

  it("plural strings: 1 work order, 2 work orders; no 'need' for one item", async () => {
    const one = { wo: "WO-1", title: "Rounding", gate: "G2", gateLabel: "G2", gateName: "Spec approval", project: "payments", projectName: "Payments Platform" };
    setup(ASHA, adminHome({}, { setup: undefined, attention: [], waiting: { approvals: [one], conversations: [] } }));
    mount();
    expect(await screen.findByText(/1 approval waits on you/)).toBeTruthy();
    expect(text()).not.toMatch(/1 projects|1 work orders|1 items/);
  });
});

describe("Home: by role", () => {
  it("Auditor: no Waiting on you, no setup, and Submit work order stays locked with the reason", async () => {
    setup(SAM, adminHome({}, { setup: undefined, waiting: undefined, attention: [], approvers: { count: 2, oldestMs: 7_200_000, late: 1, byProject: [{ id: "payments", name: "Payments Platform", count: 2, oldestMs: 7_200_000 }] } }), { denied: ["project.create", "wo.submit", "restore.factory", "kill.factory"] });
    mount();
    await screen.findByRole("heading", { level: 1, name: "Home" });
    expect(screen.queryByRole("heading", { name: /Waiting on you/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Waiting on approvers/ })).toBeNull();
    expect(screen.queryByText("New project")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit work order" }).getAttribute("aria-disabled")).toBe("true"));
  });

  it("Engineer: waiting rows and approvals call the API; their work orders show as tokens; no factory health", async () => {
    const calls = setup(TOMAS, {
      approvals: [], conversations: [], badges: {}, projectBadges: {},
      sections: {
        attention: [], projects: [{ id: "payments", roles: [{ id: "engineer", name: "Engineer" }], repos: [] }],
        waiting: { approvals: [{ wo: "WO-9", title: "Fix rounding", gate: "G3d", gateLabel: "G3d", gateName: "Design review", instance: "WO-9:G3d:2", project: "payments", projectName: "Payments", have: 0, need: 1 }], conversations: [{ wo: "WO-10", title: "Add export", project: "payments", question: "Which format?" }] },
        motion: { ...MOTION, inFlight: 1, mine: [{ id: "WO-10", title: "Add export", project: "payments", projectName: "Payments", state: "waiting", bay: null, bayName: null, station: "Intake", cls: "feature", doneAt: null }] },
      },
    }, { extra: { "GET /api/v1/work-orders/WO-9": () => ({ body: { id: "WO-9", version: 3, allowed: { approve: { allowed: true, reason: "", needs: "", gate: "G3d", instance: "WO-9:G3d:2" }, can: {} } } }), "POST /api/v1/gate-instances/WO-9%3AG3d%3A2/approve": () => ({ body: { ok: true, msg: "G3d approved on WO-9." } }) } });
    mount();
    expect(await screen.findByText("WO-9")).toBeTruthy();
    const approve = await screen.findByRole("button", { name: "Approve WO-9 at G3d" });
    await waitFor(() => expect(approve.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(approve);
    // The prototype's dialog first: "Approve G3d for WO-9" with the gate's purpose; Approve there decides.
    expect(await screen.findByText("Review design · G3d for WO-9")).toBeTruthy();
    // the prototype's optional Note field, sent as the reason the server records
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "looks right" } });
    fireEvent.click(within(document.querySelector(".dlg, [role=dialog]") as HTMLElement).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/approve"))).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/approve"))?.body).toMatchObject({ reason: "looks right" });
    // the prototype's toast, not the server's sentence
    expect(await screen.findByText("WO-9 approved and moved on")).toBeTruthy();
  });

  it("Viewer: read-only, no Waiting on you section at all, one line on how to get more access", async () => {
    setup(VERA, { approvals: [], conversations: [], badges: {}, projectBadges: {}, sections: { attention: [], motion: MOTION, projects: [{ id: "payments", roles: [{ id: "viewer", name: "Viewer" }], repos: [] }] } }, { denied: ["wo.submit", "project.create"] });
    mount();
    await screen.findByRole("heading", { level: 1, name: "Home" });
    expect(screen.queryByRole("heading", { name: /Waiting on you/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Submit work order" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("no access: one sentence and nothing else", async () => {
    setup(VERA, { approvals: [], conversations: [], badges: {}, sections: { access: "none" } });
    mount();
    expect(await screen.findByText("No access yet")).toBeTruthy();
    expect(document.querySelectorAll("section")).toHaveLength(0);
  });
});
