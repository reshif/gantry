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

interface Call { method: string; path: string }
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
      calls.push({ method, path: u.pathname });
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
  it("a Factory Admin on a live org with a repo onboarding sees attention, the checklist and the project, once each", async () => {
    const calls = setup(ASHA, adminHome());
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeTruthy();
    // Attention carries the failing onboarding; the project row says where the repo is; the checklist has the active step.
    expect(await screen.findByText("Nautobot-Jobs onboarding needs you: verification failed")).toBeTruthy();
    expect(screen.getByText("Nautobot-Jobs: verification failed")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: /Set up the factory/ })).toBeTruthy();
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain("Step repo");
    expect(screen.getByText("3 of 5")).toBeTruthy();
    // Only the active step has a button.
    expect(document.querySelectorAll(".hm-step .btn")).toHaveLength(1);
    // One request for the page, and none for the removed activity feed.
    expect(calls.filter((c) => c.path === "/api/v1/home")).toHaveLength(1);
    expect(calls.some((c) => c.path === "/api/v1/activity")).toBe(false);
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

  it("shows 'No spend yet' instead of a 0% gauge, and keeps health collapsed until opened", async () => {
    setup(ASHA, adminHome({}, { setup: undefined }));
    mount();
    const toggle = await screen.findByRole("button", { name: /Factory health/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(text()).toContain("No spend yet");
    expect(text()).not.toMatch(/0%/);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="meter"]')).toBeNull();
  });

  it("reports real eval health, with the failing live versions listed; hides the row without run data", async () => {
    const evals = { scored: 3, passing: 2, unscored: 0, failing: [{ agent: "ag-spec", name: "Spec agent", version: "1.2.0", suite: "ES-spec", score: 0.7, threshold: 0.85 }] };
    setup(ASHA, adminHome({}, { setup: undefined, health: { ...HEALTH, spend: { spent: 500, budget: 2000, projects: [] }, evals } }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Factory health/ }));
    expect(screen.getByText("2 of 3 live agent versions pass their suite threshold (last run)")).toBeTruthy();
    expect(screen.getByText("Spec agent 1.2.0: 70% vs 85% on ES-spec")).toBeTruthy();
    expect(screen.getAllByText("$500 of $2,000", { exact: false })).toHaveLength(1);
    cleanup();
    vi.unstubAllGlobals();
    setup(ASHA, adminHome({}, { setup: undefined }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Factory health/ }));
    expect(screen.queryByText(/live agent versions pass/)).toBeNull();
  });

  it("the setup checklist is gone once the API sends none", async () => {
    setup(ASHA, adminHome({}, { setup: undefined, attention: [] }));
    mount();
    await screen.findByRole("heading", { level: 1, name: "Home" });
    await screen.findByRole("heading", { level: 2, name: /Waiting on you/ });
    expect(screen.queryByText(/Set up the factory/)).toBeNull();
    expect(document.querySelector(".hm-step")).toBeNull();
  });

  it("an item in Attention is not repeated in Waiting on you", async () => {
    const waiting = { approvals: [{ repo: "nautobot-jobs", repoName: "Nautobot-Jobs", pr: 4, project: "nautobot", projectName: "Nautobot-Jobs" }, { wo: "WO-1", title: "Rounding", gate: "G2", gateLabel: "G2", gateName: "Spec approval", project: "payments", projectName: "Payments Platform", have: 1, need: 2 }], conversations: [] };
    setup(ASHA, adminHome({}, { waiting, setup: undefined, attention: [{ ...ONB_ATT, id: "hm-att-onb-nautobot-jobs" }] }));
    mount();
    await screen.findByText("WO-1", { exact: false });
    expect(screen.queryByText(/Merge onboarding PR/)).toBeNull();
    // The gate row says its approvals once.
    expect(screen.getAllByText(/1 of 2 approvals/)).toHaveLength(1);
  });

  it("each count appears once: in flight is one line, not a tile plus a header plus a panel", async () => {
    const motion = { ...MOTION, inFlight: 3, running: 2, inBays: 1, byStation: { build: 3 }, shippedToday: 1, shippedWeek: 4, shippedPrevWeek: 1, recentDone: [{ id: "WO-5", title: "Done", project: "payments", projectName: "Payments Platform", doneAt: 1 }] };
    setup(ASHA, adminHome({}, { setup: undefined, attention: [], motion }));
    mount();
    expect(await screen.findByText("3 work orders in flight · 2 running · 1 in bays")).toBeTruthy();
    expect(text().match(/in flight/g) ?? []).toHaveLength(1);
    expect(screen.getByText("Shipped: 1 today, 4 this week (+3 vs previous week)")).toBeTruthy();
    expect(document.getElementById("hm-done-WO-5")).toBeTruthy();
  });

  it("plural strings: 1 work order, 2 work orders; no 'need' for one item", async () => {
    setup(ASHA, adminHome({}, { setup: undefined, attention: [], motion: { ...MOTION, inFlight: 1, running: 1 } }));
    mount();
    expect(await screen.findByText("1 work order in flight · 1 running")).toBeTruthy();
    expect(text()).not.toMatch(/1 projects|1 work orders|1 items/);
  });
});

describe("Home: by role", () => {
  it("Auditor: waiting on approvers is read-only, no Waiting on you, no setup, no disabled buttons", async () => {
    setup(SAM, adminHome({}, { setup: undefined, waiting: undefined, attention: [], approvers: { count: 2, oldestMs: 7_200_000, late: 1, byProject: [{ id: "payments", name: "Payments Platform", count: 2, oldestMs: 7_200_000 }] } }), { denied: ["project.create", "wo.submit", "restore.factory", "kill.factory"] });
    mount();
    expect(await screen.findByRole("heading", { level: 2, name: /Waiting on approvers/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Waiting on you/ })).toBeNull();
    expect(screen.getByText(/1 past SLA/)).toBeTruthy();
    expect(screen.queryByText("New project")).toBeNull();
    expect(document.querySelectorAll('[aria-disabled="true"]')).toHaveLength(0);
    expect(screen.getByText("Audit ledger", { exact: false })).toBeTruthy();
  });

  it("Engineer: waiting rows and approvals call the API; their work orders show as tokens; no factory health", async () => {
    const calls = setup(TOMAS, {
      approvals: [], conversations: [], badges: {}, projectBadges: {},
      sections: {
        attention: [], projects: [{ id: "payments", roles: [{ id: "engineer", name: "Engineer" }], repos: [] }],
        waiting: { approvals: [{ wo: "WO-9", title: "Fix rounding", gate: "G3d", gateLabel: "G3d", gateName: "Design review", project: "payments", projectName: "Payments", have: 0, need: 1 }], conversations: [{ wo: "WO-10", title: "Add export", project: "payments", question: "Which format?" }] },
        motion: { ...MOTION, inFlight: 1, mine: [{ id: "WO-10", title: "Add export", project: "payments", projectName: "Payments", state: "waiting", bay: null, bayName: null, station: "Intake", cls: "feature", doneAt: null }] },
      },
    }, { extra: { "POST /api/v1/gate-instances/WO-9%3AG3d/approve": () => ({ body: { ok: true, msg: "G3d approved on WO-9." } }) } });
    mount();
    expect(await screen.findByText("Which format?")).toBeTruthy();
    expect(document.getElementById("hm-tok-WO-10")?.className).toContain("tok-waiting");
    expect(screen.queryByRole("button", { name: /Factory health/ })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: /My projects/ })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Approve WO-9 at G3d" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/approve"))).toBe(true));
    expect(await screen.findByText("G3d approved on WO-9.")).toBeTruthy();
  });

  it("Viewer: read-only, no Waiting on you section at all, one line on how to get more access", async () => {
    setup(VERA, { approvals: [], conversations: [], badges: {}, projectBadges: {}, sections: { attention: [], motion: MOTION, projects: [{ id: "payments", roles: [{ id: "viewer", name: "Viewer" }], repos: [] }] } }, { denied: ["wo.submit", "project.create"] });
    mount();
    expect(await screen.findByText(/Ask a Project Admin for more access/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Waiting on you/ })).toBeNull();
    expect(screen.queryByText("New work order")).toBeNull();
  });

  it("no access: one sentence and nothing else", async () => {
    setup(VERA, { approvals: [], conversations: [], badges: {}, sections: { access: "none" } });
    mount();
    expect(await screen.findByText("No access yet")).toBeTruthy();
    expect(document.querySelectorAll("section")).toHaveLength(0);
  });
});
