/** The All projects scope: the URL form, the merged Floor, Home, Inbox, Work orders, and project-only actions that ask which project. */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CATALOG, devSeed, type Project, type WorkOrder } from "@gantry/domain";
import { getPrefs, updatePrefs } from "../lib/prefs";
import { formatHash, hashFor, parseHash } from "../lib/router";
import { resolveScope } from "../lib/scope";
import { clearDecided } from "../lib/decided";
import type { Me } from "../api/types";
import FloorView from "./floor";
import HomeView from "./home";
import InboxView from "./inbox";
import ConsoleSubmitView from "./console-submit";
import WorkOrdersView from "./work-orders";
import { mergeFloors, mergeProjects } from "./floor/kit";
import { NOW, PAYMENTS, WOS, floorRead, mockApi, mount, resetApp } from "./floor/testkit";

const SEED = devSeed(NOW).state;
const RISK = SEED.projects.find((p) => p.id === "risk") as Project;
const RISK_WOS = SEED.workOrders.filter((w) => w.project === "risk") as WorkOrder[];
/** The catalogue as the server serves it: Risk's custom Compliance station sits after Review. */
const review = DEFAULT_CATALOG.stations.find((x) => x.id === "review") as (typeof DEFAULT_CATALOG.stations)[number];
const CAT = { ...DEFAULT_CATALOG, stations: DEFAULT_CATALOG.stations.flatMap((x) => (x.id === "review" ? [x, { ...review, id: "compliance", name: "Compliance", custom: true }] : [x])) };
const lite = (p: Project) => ({ id: p.id, name: p.name, key: p.key, status: p.status, halted: p.halted, killed: p.killed });
const TWO = { projects: [lite(PAYMENTS), lite(RISK)] };
const BOTH: Record<string, (c: never) => { body: unknown }> = {
  "GET /api/v1/catalog": () => ({ body: CAT }),
  "GET /api/v1/projects": () => ({ body: [{ ...PAYMENTS, version: 1 }, { ...RISK, version: 1 }] }),
  "GET /api/v1/projects/risk": () => ({ body: { ...RISK, version: 1 } }),
  "GET /api/v1/projects/risk/repos": () => ({ body: [] }),
  "GET /api/v1/projects/risk/floor": () => ({ body: floorRead({ project: RISK, workOrders: RISK_WOS, slots: { used: 0, total: 1, holders: [] }, queue: [] }) }),
  "GET /api/v1/projects/risk/events": () => ({ body: [] }),
};

beforeEach(() => {
  resetApp();
  clearDecided();
  updatePrefs({ scopeAll: true, project: null, floorView: "belt", replay: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("All projects: the URL", () => {
  it("holds the scope as #/p/all/<route> and parses it back", () => {
    expect(formatHash("floor", null, "all")).toBe("#/p/all/floor");
    expect(parseHash("#/p/all/work-orders?st=running")).toMatchObject({ id: "work-orders", project: "all", query: "st=running" });
    expect(parseHash(formatHash("floor", null, "all")).project).toBe("all");
  });

  it("a project link without a project carries the chosen scope, never the last project", () => {
    updatePrefs({ scopeAll: true, project: "risk" });
    expect(hashFor("floor")).toBe("#/p/all/floor");
    updatePrefs({ scopeAll: false, project: "risk" });
    expect(hashFor("floor")).toBe("#/p/risk/floor");
    expect(hashFor("agents")).toBe("#agents");
  });

  it("resolves All from the URL or, on factory pages, from the stored choice; a picked project narrows", () => {
    const me = { projects: [lite(PAYMENTS), lite(RISK)] } as unknown as Me;
    expect(resolveScope(me, "all", false, "risk")).toMatchObject({ all: true, projectId: null });
    expect(resolveScope(me, null, true, "risk").projects.map((p) => p.id)).toEqual(["payments", "risk"]);
    expect(resolveScope(me, null, false, "risk")).toMatchObject({ all: false, projectId: "risk" });
    expect(resolveScope(me, "payments", true, null)).toMatchObject({ all: false, projectId: "payments" });
    expect(resolveScope(me, "hidden", true, null)).toMatchObject({ all: false, projectId: null, projects: [] });
  });
});

describe("All projects: the merged line", () => {
  it("merges stations by id in catalogue order, sums slots and keeps a gate a person's when projects differ", () => {
    const risk = { ...RISK, flow: { ...RISK.flow, gates: { ...RISK.flow.gates, G2: { ...(RISK.flow.gates.G2 as object), enabled: true, mode: "auto" } } } } as Project;
    const pay = { ...PAYMENTS, flow: { ...PAYMENTS.flow, gates: { ...PAYMENTS.flow.gates, G2: { ...(PAYMENTS.flow.gates.G2 as object), enabled: true, mode: "human" } } } } as Project;
    const m = mergeProjects(CAT, [pay, risk]);
    const catOrder = CAT.stations.map((s) => s.id).filter((id) => m.flow.order.includes(id));
    expect(m.flow.order).toEqual(catOrder);
    expect(m.flow.order).toContain("compliance"); // only Risk has it
    expect(m.flow.slots).toBe(PAYMENTS.flow.slots + RISK.flow.slots);
    expect(m.flow.gates.G2?.mode).toBe("human");
    const f = mergeFloors(CAT, [floorRead() as never, floorRead({ project: RISK, workOrders: RISK_WOS }) as never]);
    expect(f.workOrders.length).toBe(WOS.length + RISK_WOS.length);
    expect(f.slots.total).toBe(2 + 2);
  });
});

describe("All projects: Floor", () => {
  it("draws the work orders of every visible project on one belt, with the stations of both flows", async () => {
    mockApi(BOTH as never, { me: TWO });
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    const open = (list: WorkOrder[]) => list.filter((w) => w.state !== "done" && w.state !== "killed" && w.bay !== "declined").length;
    await waitFor(() => expect(document.querySelectorAll(".belt .tok, .belt .qc").length).toBe(open(WOS) + open(RISK_WOS)));
    expect(document.querySelector('.belt .stn[data-s="compliance"]')).toBeTruthy();
    expect(document.querySelector('.belt .stn[data-s="build"]')).toBeTruthy();
  });

  it("narrows to one project when it is picked", async () => {
    updatePrefs({ scopeAll: false, project: "risk" });
    mockApi(BOTH as never, { me: TWO });
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    const open = RISK_WOS.filter((w) => w.state !== "done" && w.state !== "killed" && w.bay !== "declined").length;
    await waitFor(() => expect(document.querySelectorAll(".belt .tok, .belt .qc").length).toBe(open));
  });

  it("Halt line asks which project before it opens the stop dialog, and Line control says to pick a project", async () => {
    mockApi(BOTH as never, { me: TWO });
    mount(<FloorView />);
    const halt = await screen.findByRole("button", { name: /Emergency stop/ });
    fireEvent.click(halt);
    const risk = await screen.findByRole("menuitem", { name: new RegExp(RISK.name) });
    expect(screen.getByRole("menuitem", { name: new RegExp(PAYMENTS.name) })).toBeTruthy();
    expect(screen.queryByLabelText(/Type STOP to confirm/)).toBeNull(); // nothing is stopped until a project is chosen
    fireEvent.click(risk);
    expect(await screen.findByLabelText(/Type STOP to confirm/)).toBeTruthy();
    const line = document.getElementById("floor-line") as HTMLButtonElement;
    expect(line.getAttribute("aria-disabled") === "true" || line.disabled).toBe(true);
  });

  it("New work order asks which project, then opens the Console for that one", async () => {
    mockApi(BOTH as never, { me: TWO });
    mount(<FloorView />);
    fireEvent.click(await screen.findByRole("button", { name: /New work order/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: new RegExp(RISK.name) }));
    expect(window.location.hash).toBe("#console/submit");
    expect(getPrefs().scopeAll).toBe(true); // the choice is this work order's, not a new scope
    cleanup();
    mount(<ConsoleSubmitView />);
    await screen.findByLabelText(/^Title/);
    expect((document.getElementById("nwo-project") as HTMLSelectElement).value).toBe("risk");
  });
});

describe("All projects: Console", () => {
  it("asks which project instead of taking the last one", async () => {
    updatePrefs({ scopeAll: true, project: "payments" });
    mockApi(BOTH as never, { me: TWO });
    mount(<ConsoleSubmitView />);
    expect(await screen.findByText("Pick a project for this work order")).toBeTruthy();
    expect(screen.queryByLabelText(/^Title/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: RISK.name }));
    await screen.findByLabelText(/^Title/);
    expect((document.getElementById("nwo-project") as HTMLSelectElement).value).toBe("risk");
  });
});

const GATE = (project: string, projectName: string, wo: string) => ({ wo, title: `Work ${wo}`, gate: "G2", gateLabel: "G2", gateName: "Spec approved", project, projectName, have: 0, need: 1, waitMs: 3_600_000 });
const HOME = { approvals: [], conversations: [], badges: {}, sections: { waiting: { approvals: [GATE("payments", "Payments Platform", "WO-1"), GATE("risk", "Risk Engine", "WO-2")], conversations: [] } } };

describe("All projects: Inbox and Home", () => {
  it("the Inbox lists approvals from every visible project, and a picked project narrows it", async () => {
    mockApi({ ...BOTH, "GET /api/v1/home": () => ({ body: HOME }) } as never, { me: TWO });
    mount(<InboxView />);
    expect((await screen.findAllByText(/for WO-1$/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/for WO-2$/).length).toBeGreaterThan(0);
    cleanup();
    updatePrefs({ scopeAll: false, project: "risk" });
    mockApi({ ...BOTH, "GET /api/v1/home": () => ({ body: HOME }) } as never, { me: TWO });
    mount(<InboxView />);
    expect((await screen.findAllByText(/for WO-2$/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/for WO-1$/)).toBeNull();
  });

  it("Home reads 'Plant overview for All projects', shows every project's approvals and tiles, then narrows", async () => {
    mockApi({ ...BOTH, "GET /api/v1/home": () => ({ body: HOME }), "GET /api/v1/activity": () => ({ body: [] }) } as never, { me: TWO });
    mount(<HomeView />);
    expect(await screen.findByText(/Plant overview for All projects\./)).toBeTruthy();
    expect(await screen.findByText("G2 Spec approved for WO-1")).toBeTruthy();
    expect(screen.getByText("G2 Spec approved for WO-2")).toBeTruthy();
    expect(document.querySelectorAll("#hm-projects .ptile").length).toBe(2);
    cleanup();
    updatePrefs({ scopeAll: false, project: "risk" });
    mockApi({ ...BOTH, "GET /api/v1/home": () => ({ body: HOME }), "GET /api/v1/activity": () => ({ body: [] }) } as never, { me: TWO });
    mount(<HomeView />);
    expect(await screen.findByText(/Plant overview for Risk/)).toBeTruthy();
    expect(screen.queryByText("G2 Spec approved for WO-1")).toBeNull();
    expect(document.querySelectorAll("#hm-projects .ptile").length).toBe(1);
  });
});

describe("All projects: Work orders", () => {
  it("lists the work orders of every visible project with a project column", async () => {
    mockApi({
      ...BOTH,
      "GET /api/v1/projects/payments/work-orders": () => ({ body: { items: WOS.slice(0, 2), next: null } }),
      "GET /api/v1/projects/risk/work-orders": () => ({ body: { items: RISK_WOS.slice(0, 2), next: null } }),
    } as never, { me: TWO });
    mount(<WorkOrdersView />);
    const first = WOS[0] as WorkOrder;
    const other = RISK_WOS[0] as WorkOrder;
    expect(await screen.findByText(first.title)).toBeTruthy();
    expect(screen.getByText(other.title)).toBeTruthy();
    const tags = Array.from(document.querySelectorAll("#wo-table td .tag")).map((t) => t.textContent);
    expect(tags).toEqual(expect.arrayContaining([PAYMENTS.key, RISK.key]));
  });

  it("New work order asks which project under All", async () => {
    mockApi({
      ...BOTH,
      "GET /api/v1/projects/payments/work-orders": () => ({ body: { items: [], next: null } }),
      "GET /api/v1/projects/risk/work-orders": () => ({ body: { items: [], next: null } }),
    } as never, { me: TWO });
    mount(<WorkOrdersView />);
    fireEvent.click(await screen.findByRole("button", { name: /New work order/ }));
    expect(await screen.findByRole("menuitem", { name: new RegExp(RISK.name) })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: new RegExp(PAYMENTS.name) })).toBeTruthy();
  });
});
