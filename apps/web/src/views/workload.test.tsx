import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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

  it("shows the title block, the bus-factor note and the people table with counts beside every rate", async () => {
    setup();
    mount();
    const t = await byId("wl-people");
    expect(document.body.textContent).toContain("Gates waiting3");
    expect(document.body.textContent).toContain("Median wait1h 35m");
    expect(document.body.textContent).toContain("After hours33%");
    expect(document.body.textContent).toContain("Human minutes61");
    expect(document.querySelector(".wl-bus")?.textContent).toContain("2 of 3 waiting gates have exactly one eligible approver; 1 have nobody eligible except break-glass. That person is the bus factor for that work.");
    const priya = t.querySelector("tr[data-key='p-priya']")!;
    await waitFor(() => expect(priya.textContent).toContain("Priya Nair"));
    expect(priya.textContent).toContain("on call");
    expect(priya.textContent).toContain("+1 break-glass");
    expect(priya.textContent).toContain("1h 35m");
    expect(priya.textContent).toContain("n=8");
    expect(priya.textContent).toContain("1.39 in 7d"); // 1.3 a day, 9 in 7d
    expect(priya.textContent).toContain("36%");
    expect(priya.textContent).toContain("2 of 2");
    expect(priya.textContent).toContain("100%");
    const meera = t.querySelector("tr[data-key='p-meera']")!;
    expect(meera.textContent).toContain("away");
    // two timed approvals and two acts are not enough for a rate
    expect(meera.textContent).toContain("insufficient data, n=2");
    expect(meera.textContent).toContain("0/2");
    expect(meera.textContent).toContain("none waiting");
    expect(document.querySelector(".footnote")?.textContent).toContain("Out of hours means outside Mon to Fri 09:00 to 19:00 IST.");
  });

  it("asks the server for the chosen project and window", async () => {
    const calls = setup();
    mount();
    await byId("wl-people");
    expect(reads(calls)[0]!.query.get("scope")).toBe("all");
    expect(reads(calls)[0]!.query.get("days")).toBe("7");
    type(await byId("wl-project"), "risk");
    await waitFor(() => expect(reads(calls).some((c) => c.query.get("scope") === "risk")).toBe(true));
    fireEvent.click(document.getElementById("wl-days-1")!);
    await waitFor(() => expect(reads(calls).some((c) => c.query.get("days") === "1" && c.query.get("scope") === "risk")).toBe(true));
    const before = reads(calls).length;
    fireEvent.click(await byId("wl-refresh"));
    await waitFor(() => expect(reads(calls).length).toBe(before + 1));
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
    expect(window.location.hash).toBe("#people/p-priya");
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

  it("opens a person's drawer with what waits on them and their recent acts, and ends a delegation", async () => {
    const calls = setup({ "PUT /api/v1/people/p-meera/away": () => ({ body: { ok: true, msg: "Meera Iyer is back." } }) });
    mount();
    const t = await byId("wl-people");
    fireEvent.click(t.querySelector("tr[data-key='p-priya']")!);
    const dr = await byId("wl-drawer-close");
    const drawer = dr.closest(".wl-drawer")!;
    await waitFor(() => expect(drawer.textContent).toContain("Reviewer · on call"));
    expect(drawer.textContent).toContain("Priya Nair");
    expect(drawer.textContent).toContain("Reviewer · on call");
    expect(drawer.querySelectorAll(".titleblock dd")).toHaveLength(5);
    expect(drawer.textContent).toContain("Waiting on Priya");
    expect(drawer.querySelector("#wl-dr-wo-w-WO-1042")).toBeTruthy();
    expect(drawer.textContent).toContain("only approver");
    expect(drawer.textContent).toContain("2 others eligible");
    expect(drawer.textContent).toContain("approved G2");
    expect(drawer.textContent).toContain("after 12m");
    expect(drawer.textContent).toContain("answered a question");
    fireEvent.click(dr);
    await waitFor(() => expect(document.getElementById("wl-drawer-close")).toBeNull());
    fireEvent.click(t.querySelector("tr[data-key='p-meera']")!);
    expect((await byId("wl-dr-delegate")).textContent).toContain("Change delegation");
    fireEvent.click(await byId("wl-dr-delegate"));
    fireEvent.click(await byId("wl-dl-end"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ path: "/api/v1/people/p-meera/away", body: { away: null } });
  });

  it("shows teams, where work waits and the minutes per work order, with small samples marked", async () => {
    setup();
    mount();
    fireEvent.click(await byId("wl-tab-teams"));
    const teams = await byId("wl-teams");
    expect(teams.textContent).toContain("Payments");
    expect(teams.textContent).toContain("1.6");
    fireEvent.click(await byId("wl-tab-waits"));
    const b = await byId("wl-bottlenecks");
    expect(b.querySelector("tr[data-key='payments:G2']")?.textContent).toContain("2h 10m");
    expect(b.querySelector("tr[data-key='payments:G2']")?.textContent).toContain("only 1");
    expect(b.querySelector("tr[data-key='payments:G2']")?.textContent).toContain("3h 00m");
    expect(document.getElementById("wl-bn-cfg-payments-G2")).toBeTruthy();
    expect(document.getElementById("wl-np-WO-1050")?.textContent).toBe("WO-1050");
    expect(document.body.textContent).toContain("Waiting on a decision");
    fireEvent.click(document.getElementById("wl-bn-cfg-risk-G5")!);
    expect(window.location.hash).toMatch(/^#(\/p\/[^/]+\/)?project-config$/);
    fireEvent.click(await byId("wl-tab-minutes"));
    const cls = await byId("wl-min-cls");
    expect(cls.querySelector("tr[data-key='bug']")?.textContent).toContain("insufficient data");
    expect(document.getElementById("wl-min-proj")).toBeTruthy();
    expect(document.querySelector(".wl-mins")?.textContent).toContain("an approval counts 6 minutes, a brief confirmation 4 and a conversation answer 3");
  });

  it("sorts a column and keeps the sort across tabs", async () => {
    setup();
    mount();
    const t = await byId("wl-people");
    expect(Array.from(t.querySelectorAll("tbody tr")).map((r) => r.getAttribute("data-key"))).toEqual(["p-priya", "p-meera"]);
    fireEvent.click(await byId("wl-people-sort-name"));
    expect(Array.from(document.querySelectorAll("#wl-people tbody tr")).map((r) => r.getAttribute("data-key"))).toEqual(["p-meera", "p-priya"]);
    fireEvent.click(await byId("wl-tab-teams"));
    fireEvent.click(await byId("wl-tab-people"));
    expect(Array.from(document.querySelectorAll("#wl-people tbody tr")).map((r) => r.getAttribute("data-key"))).toEqual(["p-meera", "p-priya"]);
  });
});
