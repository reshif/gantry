import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import WorkloadView from "./workload";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: any; headers: Record<string, string>; query: URLSearchParams }

const NOW = Date.now();
const person = (id: string, name: string, o: object = {}) => ({ id, name, title: "Engineer", email: `${id}@acme.dev`, teams: ["payments"], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "", away: null, version: 2, ...o });
const ASHA = person("p-asha", "Asha Raman");
const PRIYA = person("p-priya", "Priya Nair", { title: "Reviewer" });
const MEERA = person("p-meera", "Meera Iyer", { title: "Lead" });
const project = (id: string, name: string) => ({ id, name, key: id.toUpperCase(), status: "active", teams: [], owner: "p-asha", template: "t", regulated: false, desc: "", approvers: {}, notifications: [], mcp: [], budget: { monthly: 1000, mtd: 0, alertAt: 0.8 }, created: 0, halted: null, killed: null, overlay: "", version: 1 });
const PAYMENTS = project("payments", "Payments Platform");
const RISK = project("risk", "Risk and Compliance");

const wo = (id: string, title: string, cls = "feature") => ({ id, title, project: "payments", cls });
const row = (o: object) => ({ person: "p-x", name: "X", team: "payments", waiting: 0, glass: 0, approvals: 0, perDay: 0, answered: 0, waitN: 0, medianResponseMin: null, afterHours: 0, n: 0, sole: 0, minutes: 0, away: null, oncall: false, waitingGates: [], recent: [], ...o });
const WORKLOAD = {
  at: NOW, days: 7, scope: "all", minN: 5, projects: [{ id: "payments", name: "Payments Platform" }, { id: "risk", name: "Risk and Compliance" }], factoryWide: true, ids: ["payments", "risk"],
  totals: { gatesWaiting: 3, soleGates: 2, noneGates: 1, timedN: 8, medianWaitMin: 95, acts: 12, afterHours: 4, minutes: 61 },
  rows: [
    row({ person: "p-priya", name: "Priya Nair", waiting: 2, glass: 1, approvals: 9, perDay: 1.3, answered: 2, waitN: 8, medianResponseMin: 95, afterHours: 4, n: 11, sole: 2, minutes: 52, oncall: true,
      waitingGates: [{ wo: wo("WO-1042", "Add refund keys"), gate: "G2", since: NOW - 3 * 3600_000, eligible: 1 }, { wo: wo("WO-1043", "Retry payouts"), gate: "G5", since: NOW - 40 * 60_000, eligible: 3 }],
      recent: [{ kind: "approve", at: NOW - 3600_000, wo: "WO-1040", gate: "G2", waitMin: 12 }, { kind: "answer", at: NOW - 7200_000, wo: "WO-1041", waitMin: null }] }),
    row({ person: "p-meera", name: "Meera Iyer", waiting: 0, approvals: 2, perDay: 0.3, answered: 0, waitN: 2, medianResponseMin: 20, afterHours: 0, n: 2, sole: 0, minutes: 9, away: { from: NOW - 3600_000, to: NOW + 86_400_000, delegate: "p-asha" } }),
  ],
  teams: [{ team: "payments", name: "Payments", people: 2, waiting: 2, approvals: 11, answered: 2, minutes: 61, waitN: 10, medianResponseMin: 80, afterHours: 4, n: 13, sole: 2 }],
  byCls: [{ key: "feature", minutes: 40, workOrders: 6, perWO: 6.7 }, { key: "bug", minutes: 12, workOrders: 2, perWO: 6 }],
  byProject: [{ key: "payments", minutes: 52, workOrders: 8, perWO: 6.5 }, { key: "risk", minutes: 9, workOrders: 1, perWO: 9 }],
  bottlenecks: [{ project: "payments", gate: "G2", decisions: 6, medianWaitMin: 130, open: 2, oldestMin: 180, station: "spec", minEligible: 1 }, { project: "risk", gate: "G5", decisions: 2, medianWaitMin: 20, open: 0, oldestMin: 0, station: "review", minEligible: null }],
  needsPerson: [{ id: "WO-1050", title: "Needs a call", project: "payments", bayReason: "Waiting on a decision" }],
  suggestions: [
    { key: "sole:p-priya", kind: "approver", icon: "people", weight: 5, text: "Priya Nair is the only eligible approver on 2 waiting gates (WO-1042 at G2). Add a second approver to those rules.", action: { id: "wl-sg-sole-p-priya", label: "Open approver rules", type: "config", project: "payments", gate: "G2" } },
    { key: "away:p-meera", kind: "delegate", icon: "swap", weight: 4, text: "Meera Iyer is away with 3 approvals waiting and no delegate.", action: { id: "wl-sg-away-p-meera", label: "Set a delegate", type: "delegate", person: "p-meera" } },
    { key: "tp:TP-1", kind: "trust", icon: "trust", weight: 3, text: "Raise trust for Builder · Feature · Payments Platform from L1 to L2.", action: { id: "wl-sg-tp-TP-1", label: "Review proposal TP-1", type: "trust", project: "payments", cell: "c1", proposal: "TP-1", cls: "feature" } },
    { key: "ah:p-priya", kind: "approver", icon: "clock", weight: 2, text: "Priya Nair did 4 of 11 acts (36%) out of hours.", action: { id: "wl-sg-ah-p-priya", label: "Open Priya in People", type: "person", person: "p-priya" } },
    { key: "load:p-x", kind: "delegate", icon: "swap", weight: 1.5, text: "X has 5 approvals waiting.", action: { id: "wl-sg-del-p-x", label: "Delegate while away", type: "delegate", person: "p-priya" } },
    { key: "bn:risk", kind: "approver", icon: "gate", weight: 1.2, text: "Add an approver to share the load.", action: { id: "wl-sg-ba-risk-G5", label: "Open approver rules", type: "config", project: "risk", gate: "G5" } },
  ],
};

function me() {
  return { person: ASHA, session: { id: "s1", person: "p-asha", method: "sso", device: "Chrome", ip: "1", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: [PAYMENTS, RISK], factory: { killed: null }, config: {} };
}

function setup(extra: Record<string, Handler> = {}, denied: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: me() }),
    "GET /api/v1/people": () => ({ body: [ASHA, PRIYA, MEERA] }),
    "GET /api/v1/projects": () => ({ body: [PAYMENTS, RISK] }),
    "GET /api/v1/catalog": () => ({ body: DEFAULT_CATALOG }),
    "GET /api/v1/agents": () => ({ body: [] }),
    "GET /api/v1/access/matrix": () => ({ body: { matrix: { factory_admin: { "gate.approve": true }, reviewer: { "gate.approve": true } }, roles: [{ id: "factory_admin", name: "Factory Admin", level: "factory" }, { id: "reviewer", name: "Reviewer", level: "project" }], actions: [], version: 1 } }),
    "GET /api/v1/projects/payments/work-orders": () => ({ body: [{ id: "WO-1", title: "A", project: "payments", state: "waiting", requestedBy: "p-meera", gates: { G2: { status: "waiting" } } }, { id: "WO-2", title: "B", project: "payments", state: "running", requestedBy: "p-meera", gates: {} }, { id: "WO-3", title: "C", project: "payments", state: "done", requestedBy: "p-meera", gates: {} }] }),
    "GET /api/v1/projects/risk/work-orders": () => ({ body: [{ id: "WO-4", title: "D", project: "risk", state: "waiting", requestedBy: "p-meera", gates: { G5: { status: "waiting" } } }] }),
    "GET /api/v1/workload": (url) => {
      const q = new URL(url, "http://x").searchParams;
      return { body: { ...WORKLOAD, days: Number(q.get("days") ?? 7), scope: q.get("scope") ?? "all" } };
    },
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
      const checks = (body as { checks: Array<{ action: string; project?: string }> }).checks;
      return new Response(JSON.stringify({ results: checks.map((c) => (denied.includes(c.action) ? { allowed: false, reason: `No role holds ${c.action}.`, needs: "Needs Project Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "", needs: "" })) }));
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
  return render(<QueryClientProvider client={qc}><OverlayProvider><WorkloadView /></OverlayProvider></QueryClientProvider>);
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.path !== "/api/v1/can");
const reads = (calls: Call[]) => calls.filter((c) => c.method === "GET" && c.path === "/api/v1/workload");
const type = (el: HTMLElement, v: string) => fireEvent.change(el, { target: { value: v } });

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
  window.history.replaceState(null, "", "/"); // view state lives in the query string
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Workload screen (legacy workload.js on the real API)", () => {
  it("says Not visible to you when the workload read is refused", async () => {
    setup({ "GET /api/v1/workload": () => ({ status: 403, body: { ok: false, msg: "Needs workload.view." } }) });
    mount();
    await waitFor(() => expect(document.getElementById("wl-hidden")?.textContent).toContain("Not visible to you"));
    expect(document.getElementById("wl-hidden")?.textContent).toContain("Needs workload.view.");
  });

  it("shows the prototype sheet: four stats, the two charts and a §3 People table with Can approve, Open requests, At a gate, Actions logged and On call", async () => {
    setup();
    mount();
    const t = await byId("wl-people");
    expect(document.body.textContent).toContain("Approvals waiting3");
    expect(document.body.textContent).toContain("Oldest wait3 h");
    // approvers are the people whose role the matrix lets approve gates (Priya, Meera hold the factory role here)
    expect(document.getElementById("wl-stats")?.textContent).toContain("Approvers3");
    expect(Array.from(t.querySelectorAll("thead th")).map((h) => h.textContent?.replace(/\s*[\u2191\u2193\u2195\u25b2\u25bc]/g, ""))).toEqual(["Person", "Can approve", "Open requests", "At a gate", "Actions logged", "On call"]);
    // prototype sort hints: a dim hint on sortable headers, a filled triangle on the active one (Open requests, newest first), no 24 h / 7 d switch, no Sort by select
    expect(t.querySelector("thead th")?.textContent).toContain("\u2195");
    expect(t.querySelector("thead th .th-arrow.sorthint")).toBeTruthy();
    expect(Array.from(t.querySelectorAll("thead th")).map((h) => h.textContent).join("|")).toContain("Open requests \u25bc");
    expect(document.getElementById("wl-days-1")).toBeNull();
    expect(document.querySelector(".dtable-sortsel")).toBeNull();
    // no old controls: project select, tabs, bus-factor callout
    expect(document.getElementById("wl-project")).toBeNull();
    expect(document.getElementById("wl-tab-teams")).toBeNull();
    expect(document.querySelector(".wl-bus")).toBeNull();
    // Meera asked for 3 open orders over both projects (WO-3 is done), 2 of them at a gate; the list is sorted by open requests, newest first
    const meera = await waitFor(() => { const r = t.querySelector("tr[data-key='p-meera']"); if (!r?.textContent?.includes("2")) throw new Error("no counts"); return r; });
    expect(meera.querySelector("td[data-label='Open requests']")?.textContent).toBe("3");
    expect(meera.querySelector("td[data-label='At a gate']")?.textContent).toBe("2");
    expect(t.querySelector("tr[data-key='p-priya'] td[data-label='On call']")?.textContent).toBe("on call");
    expect(Array.from(t.querySelectorAll("tbody tr"))[0]?.getAttribute("data-key")).toBe("p-meera");
    expect(screen.getByText("3 persons")).toBeTruthy();
    expect(screen.getByText("1\u20133 of 3")).toBeTruthy();
  });

  it("links a person to their page, filters by approver in the address bar, and keeps a readable sort key", async () => {
    const calls = setup();
    mount();
    await byId("wl-people");
    expect(reads(calls)[0]!.query.get("scope")).toBe("all");
    expect(reads(calls)[0]!.query.get("days")).toBe("7");
    const link = await screen.findByRole("link", { name: "Priya Nair" });
    expect(link.getAttribute("href")).toBe("#person/p-priya");
    fireEvent.click(link);
    expect(window.location.hash).toBe("#person/p-priya");
    type(await byId("wl-f-approver"), "no");
    expect(window.location.hash).toContain("wl.approver=no");
    expect(await screen.findByText("Nothing matches these filters")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(window.location.hash).not.toContain("wl.approver");
    // sorting keeps a readable key in the address bar
    fireEvent.click(document.getElementById("wl-people-sort-person")!);
    expect(window.location.hash).toContain("wl.sort=person");
  });

  it("lists suggestions with the top five, and a link to show them all", async () => {
    setup();
    mount();
    await byId("wl-sg-sole-p-priya");
    expect(document.querySelectorAll(".wl-sugg-list li")).toHaveLength(5);
    expect(document.querySelector(".wl-sg-approver .chip")?.textContent).toBe("Add an approver");
    expect(document.querySelector(".wl-sg-trust .chip")?.textContent).toBe("Raise trust");
    expect(document.querySelector(".wl-sg-delegate .chip")?.textContent).toBe("Delegate");
    fireEvent.click(await byId("wl-sugg-all"));
    expect(document.querySelectorAll(".wl-sugg-list li")).toHaveLength(6);
    expect(document.getElementById("wl-sugg-all")?.textContent).toBe("Show top 5");
  });

  it("opens the approver rules of the right project from a suggestion, and the trust screen from another", async () => {
    setup();
    mount();
    fireEvent.click(await byId("wl-sg-sole-p-priya"));
    expect(window.location.hash).toMatch(/^#(\/p\/[^/]+\/)?project-config$/);
    fireEvent.click(await byId("wl-sg-tp-TP-1"));
    expect(window.location.hash).toBe("#trust");
    fireEvent.click(await byId("wl-sg-ah-p-priya"));
    expect(window.location.hash).toBe("#person/p-priya");
  });

  it("locks the approver-rule suggestion with the reason when the person cannot edit rules", async () => {
    setup({}, ["approvers.edit"]);
    mount();
    const b = await byId("wl-sg-sole-p-priya");
    await waitFor(() => expect(b.getAttribute("data-reason")).toMatch(/Needs Project Admin. No role holds approvers.edit/));
    expect(b.getAttribute("aria-disabled")).toBe("true");
  });

  it("sets a delegate through the real command, from a suggestion", async () => {
    const calls = setup({ "PUT /api/v1/people/p-meera/away": () => ({ body: { ok: true, msg: "Meera Iyer is away; Asha Raman approves instead." } }) });
    mount();
    fireEvent.click(await byId("wl-sg-away-p-meera"));
    await byId("wl-dl-save");
    expect(document.querySelector(".dlg-title")?.textContent).toBe("Delegate approvals for Meera Iyer");
    type(await byId("wl-dl-person"), "p-priya");
    type(await byId("wl-dl-until"), "2020-01-01");
    fireEvent.click(await byId("wl-dl-save"));
    expect(document.querySelector(".form-err")?.textContent).toBe("Pick a date in the future.");
    expect(writes(calls)).toHaveLength(0);
    type(await byId("wl-dl-until"), "2999-01-01");
    fireEvent.click(await byId("wl-dl-save"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "PUT", path: "/api/v1/people/p-meera/away", body: { away: { delegate: "p-priya", to: expect.any(Number) }, project: null } });
  });
});
