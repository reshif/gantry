import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("Home: one page", () => {
  it("says Home is not visible on a 403, and shows a retry on other failures", async () => {
    setup(ASHA, adminHome(), { extra: { "GET /api/v1/home": () => ({ status: 403, body: { ok: false, msg: "Needs a role on this project." } }) } });
    mount();
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
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
    expect(screen.getAllByText(/restore approvals 1 of 2/).length).toBeGreaterThan(0);
    expect(screen.getByRole("alert").textContent).toMatch(/Factory stopped\./);
    expect(screen.getByRole("alert").textContent).toMatch(/Restore needs two Factory Admins/);
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






});

describe("Home: by role", () => {



  it("no access: one sentence and nothing else", async () => {
    setup(VERA, { approvals: [], conversations: [], badges: {}, sections: { access: "none" } });
    mount();
    expect(await screen.findByText("No access yet")).toBeTruthy();
    expect(document.querySelectorAll("section")).toHaveLength(0);
  });
});

describe("Home: Control Room", () => {
  it("shows what needs a person, the live feed, the belt at a glance and the projects, once each", async () => {
    setup(ASHA, adminHome(), { extra: { "GET /api/v1/activity": () => ({ body: [] }) } });
    mount();
    expect(await screen.findByText("Nautobot-Jobs onboarding needs you: verification failed")).toBeTruthy();
    expect(screen.getAllByText("Nautobot-Jobs onboarding needs you: verification failed")).toHaveLength(1);
    for (const t of ["Needs your attention", "Live activity", "Belt at a glance", "Throughput, last 24 hours", "Projects"]) expect(screen.getByRole("heading", { name: t })).toBeTruthy();
    expect(document.querySelectorAll(".minibelt .mb-st").length).toBe(DEFAULT_CATALOG.stations.length);
    expect(document.querySelectorAll(".proj-grid .ptile").length).toBe(2);
  });

  it("the stat row counts what the sections below hold", async () => {
    setup(ASHA, adminHome({}, { motion: { ...MOTION, inFlight: 12, running: 5, shippedToday: 3, shippedWeek: 9 } }));
    mount();
    await screen.findByText("Needs your attention");
    const tile = (l: string) => screen.getByText(l).closest(".stat");
    expect(tile("On the belt")?.querySelector(".v")?.textContent).toBe("12");
    expect(tile("Released today")?.querySelector(".v")?.textContent).toBe("3");
    expect(tile("On the belt")?.textContent).toMatch(/5 running · 7 queued/);
    expect(tile("Blocked")).toBeTruthy();
    expect(tile("Waiting for a person")?.textContent).toMatch(/at gates/);
  });

  it("the sub line names the project and the head has only Open floor and Submit work order; Review opens the decision dialog", async () => {
    const gate = { wo: "WO-9", title: "Add limits", gate: "G2", gateLabel: "G2", gateName: "Spec approved", project: "payments", projectName: "Payments Platform", waitMs: 3_600_000 };
    setup(ASHA, adminHome({}, { attention: [], setup: undefined, waiting: { approvals: [gate], conversations: [] } }), { extra: { "GET /api/v1/work-orders/WO-9": () => ({ body: { id: "WO-9", project: "payments", version: 1, allowed: { approve: { gate: "G2", instance: "WO-9:G2:1", allowed: true, reason: "", needs: "" } } } }), "GET /api/v1/work-orders/WO-9/gates/G2/approvers": () => ({ body: { label: "Spec", rule: { text: "One approver.", conditions: [] }, progress: { have: 0, need: 1, approvals: [], unmet: [] }, satisfiable: true, warning: "", eligible: [], overrides: [], viewerCanOverride: false, can: { editRule: false, editWhy: "", grantRole: false, grantWhy: "" } } }) } });
    mount();
    expect(await screen.findByText(/Plant overview for .*\. Agents propose, people approve\./)).toBeTruthy();
    await waitFor(() => expect(document.querySelector("#hm-projects #hm-new-project")).toBeTruthy());
    expect(screen.getByText("WO-9 · Add limits · waiting 1h 00m ago")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(await screen.findByRole("button", { name: "Request changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("an item in Attention is not repeated among the waiting rows", async () => {
    const wait = { approvals: [{ repo: "nautobot-jobs", repoName: "Nautobot-Jobs", project: "nautobot", projectName: "Nautobot-Jobs", pr: 4 }], conversations: [] };
    setup(ASHA, adminHome({ approvals: wait.approvals }, { waiting: wait }));
    mount();
    await screen.findByText("Needs your attention");
    expect(screen.queryByText(/Merge onboarding PR/)).toBeNull();
  });

  it("shows the setup checklist only while the API sends one", async () => {
    setup(ASHA, adminHome({}, { setup: undefined }));
    mount();
    await screen.findByText("Needs your attention");
    expect(screen.queryByText("Step repo")).toBeNull();
  });

  it("a person with no waiting section sees an empty attention card and no waiting tile", async () => {
    setup(SAM, adminHome({}, { attention: undefined, waiting: undefined, setup: undefined }));
    mount();
    expect(await screen.findByText("Nothing waiting for you")).toBeTruthy();
    expect(screen.queryByText("Waiting for a person")).toBeNull();
  });
});
