import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updatePrefs } from "../lib/prefs";
import { DEFAULT_CATALOG, type WorkOrder } from "@gantry/domain";
import FloorView from "./floor";
import RecordView from "./record";
import { NOW, PAYMENTS, WOS, floorRead, mockApi, mount, resetApp } from "./floor/testkit";
import { readsFor, travelerOf } from "./traveler/testkit";

beforeEach(() => {
  resetApp();
  updatePrefs({ project: "payments", floorView: "board", boardSwim: "none", replay: null, collapsedBays: false, activeClass: null, boardFilters: { cls: "all", repo: "all", assignee: "all", prio: "all" } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const at = (sid: string) => DEFAULT_CATALOG.stations.findIndex((s) => s.id === sid);
const base = WOS.find((w) => w.state === "running" && !w.bay) as WorkOrder;
/** Two orders live at Verify, one finished Build and waits for Verify, in a project whose Verify limit is 2. */
const stationed = (limit: number): { project: typeof PAYMENTS; wos: WorkOrder[]; waiting: WorkOrder } => {
  const mk = (id: string, o: Partial<WorkOrder>): WorkOrder => ({ ...base, id, title: `Order ${id}`, bay: null, bayFrom: null, killed: null, doneAt: null, ...o }) as WorkOrder;
  const waiting = mk("WO-8003", { station: at("build"), state: "waiting", wipWait: { station: "verify", since: NOW, live: 2, limit } });
  const wos = [mk("WO-8001", { station: at("verify"), state: "running" }), mk("WO-8002", { station: at("verify"), state: "waiting" }), waiting];
  const project = { ...PAYMENTS, flow: { ...PAYMENTS.flow, stations: { ...PAYMENTS.flow.stations, verify: { enabled: true, wip: limit } } } };
  return { project, wos, waiting };
};

describe("WIP limits on the Floor", () => {
  it("the Board shows n/wip in the column header, amber when full, and the waiting chip on the order", async () => {
    const s = stationed(2);
    mockApi({ "GET /api/v1/projects/payments/floor": () => ({ body: floorRead({ project: s.project, workOrders: s.wos }) }) });
    window.location.hash = "#/p/payments/floor?view=board";
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    const head = await waitFor(() => {
      const el = document.querySelector('#floor-board [data-station="verify"] h3 span:last-child');
      if (!el) throw new Error("no header yet");
      return el;
    });
    expect(head.textContent).toBe("2/2");
    expect(head.className).toBe("chip warn");
    expect(document.querySelector('#floor-board [data-wo="WO-8003"]')?.textContent).toContain("Waiting: Verify is full (2/2)");
  });

  it("a station with no limit (0) shows only the count and is never full", async () => {
    const s = stationed(0);
    mockApi({ "GET /api/v1/projects/payments/floor": () => ({ body: floorRead({ project: s.project, workOrders: s.wos.slice(0, 2) }) }) });
    window.location.hash = "#/p/payments/floor?view=board";
    mount(<FloorView />);
    await waitFor(() => expect(document.querySelector('#floor-board [data-station="verify"]')).toBeTruthy());
    expect(document.querySelector('#floor-board [data-station="verify"] h3')?.textContent).toMatch(/Verify2$/);
    expect(document.querySelector('#floor-board [data-station="verify"] h3 .chip')).toBeNull();
  });

  it("the Belt marks the waiting order's balloon and gives a station its limit; a station with no limit says so and is never over", async () => {
    updatePrefs({ floorView: "belt" });
    const s = stationed(2);
    const free = stationed(0);
    mockApi({ "GET /api/v1/projects/payments/floor": () => ({ body: floorRead({ project: s.project, workOrders: s.wos }) }) });
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    await waitFor(() => expect(document.querySelector('[data-station="verify"]')).toBeTruthy());
    expect(document.getElementById("floor-st-verify")?.getAttribute("aria-label")).toMatch(/2 work orders, limit 2/);
    expect(document.getElementById("floor-tok-WO-8003")?.getAttribute("aria-label")).toMatch(/Waiting: Verify is full \(2\/2\)/);
    expect(document.querySelector("#floor-tok-WO-8003 .wipw")).toBeTruthy();
    cleanup();
    mockApi({ "GET /api/v1/projects/payments/floor": () => ({ body: floorRead({ project: free.project, workOrders: free.wos.slice(0, 2) }) }) });
    mount(<FloorView />);
    await waitFor(() => expect(document.querySelector('[data-station="verify"]')).toBeTruthy());
    expect(document.getElementById("floor-st-verify")?.getAttribute("aria-label")).toMatch(/limit none(?!, over)/);
  });
});

describe("WIP limits on the Record", () => {
  const waitingRead = (override: { allowed: boolean; reason: string }) => {
    const w = stationed(3).waiting;
    const t = travelerOf(w, { allowed: { ...travelerOf(w).allowed, approve: null, wipOverride: override } as never, wipWait: { station: "verify", since: NOW, live: 3, limit: 3 } });
    return { w, t };
  };

  it("says why the order waits and, when the server allows it, offers Move in anyway (with a reason), which posts the reason", async () => {
    const { w, t } = waitingRead({ allowed: true, reason: "" });
    const calls = mockApi({ ...readsFor(w, t), [`POST /api/v1/work-orders/${w.id}/wip-override`]: () => ({ body: { ok: true, msg: "moved in" } }) });
    window.location.hash = `#record/${w.id}`;
    mount(<RecordView />);
    await screen.findByRole("toolbar", { name: "Work order actions" }, { timeout: 4000 });
    expect((await screen.findByText(/Waiting: Verify is full \(3\/3\)/, {}, { timeout: 4000 })).textContent).toContain("Waiting: Verify is full (3/3)");
    const btn = (await screen.findByRole("button", { name: "Move in anyway (with a reason)" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    const box = await screen.findByRole("textbox");
    fireEvent.change(box, { target: { value: "Hotfix for the outage" } });
    fireEvent.click(await screen.findByRole("button", { name: "Move in anyway" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === `/api/v1/work-orders/${w.id}/wip-override`)?.body).toEqual({ reason: "Hotfix for the outage" }));
  });

  it("locks the button with the server's reason for anyone the server does not allow", async () => {
    const { w, t } = waitingRead({ allowed: false, reason: "Only a Factory Admin can move a work order past a station's WIP limit." });
    mockApi(readsFor(w, t));
    window.location.hash = `#record/${w.id}`;
    mount(<RecordView />);
    await screen.findByRole("toolbar", { name: "Work order actions" }, { timeout: 4000 });
    const btn = (await screen.findByRole("button", { name: "Move in anyway (with a reason)" })) as HTMLButtonElement;
    expect(btn.getAttribute("aria-disabled") === "true" || btn.disabled).toBe(true);
    expect(btn.getAttribute("data-reason") ?? btn.title ?? "").toMatch(/Factory Admin/);
  });

  it("also explains a send-back that waits, and an order that waits in its bay, and offers the override for both", async () => {
    for (const [kind, text, over] of [["back", /It was sent back and goes in when a place frees/, {}], ["unpark", /It is in its bay and goes in when a place frees/, { state: "parked", bay: "hold", bayFrom: "verify" }]] as const) {
      cleanup();
      resetApp();
      const w = stationed(3).waiting;
      const base = travelerOf(w);
      const t = travelerOf(w, { ...over, allowed: { ...base.allowed, approve: null, wipOverride: { allowed: true, reason: "" } } as never, wipWait: { station: "verify", since: NOW, live: 3, limit: 3, kind } } as never);
      mockApi(readsFor(w, t));
      window.location.hash = `#record/${w.id}`;
      mount(<RecordView />);
      await screen.findByRole("toolbar", { name: "Work order actions" }, { timeout: 4000 });
      expect((await screen.findByText(text, {}, { timeout: 4000 })).textContent).toMatch(/Waiting: Verify is full \(3\/3\)/);
      expect(await screen.findByRole("button", { name: "Move in anyway (with a reason)" })).toBeTruthy();
    }
  });
});

describe("the Belt counts like the server", () => {
  it("W-1: failed and blocked orders are not counted against the limit, so the station is full (1/1), not over", async () => {
    updatePrefs({ floorView: "belt" });
    const mk = (id: string, o: Partial<WorkOrder>): WorkOrder => ({ ...base, id, title: `Order ${id}`, bay: null, bayFrom: null, killed: null, doneAt: null, ...o }) as WorkOrder;
    const wos = [mk("WO-8001", { station: at("verify"), state: "running" }), mk("WO-8002", { station: at("verify"), state: "failed" }), mk("WO-8003", { station: at("verify"), state: "blocked" })];
    const project = { ...PAYMENTS, flow: { ...PAYMENTS.flow, stations: { ...PAYMENTS.flow.stations, verify: { enabled: true, wip: 1 } } } };
    mockApi({ "GET /api/v1/projects/payments/floor": () => ({ body: floorRead({ project, workOrders: wos }) }) });
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    await waitFor(() => expect(document.getElementById("floor-st-verify")).toBeTruthy());
    const label = document.getElementById("floor-st-verify")?.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/Verify: 1 work order, limit 1(?!, over)/);
    expect(label).not.toMatch(/over limit/);
    expect(document.getElementById("floor-st-verify")?.textContent).toMatch(/1 \/ 1/);
  });

  it("an over-limit station (a merge returned from a bay) is red on the Board until it drains", async () => {
    updatePrefs({ floorView: "board" });
    const mk = (id: string, o: Partial<WorkOrder>): WorkOrder => ({ ...base, id, title: `Order ${id}`, bay: null, bayFrom: null, killed: null, doneAt: null, ...o }) as WorkOrder;
    const wos = [mk("WO-8001", { station: at("verify"), state: "running" }), mk("WO-8002", { station: at("verify"), state: "waiting" })];
    const project = { ...PAYMENTS, flow: { ...PAYMENTS.flow, stations: { ...PAYMENTS.flow.stations, verify: { enabled: true, wip: 1 } } } };
    mockApi({ "GET /api/v1/projects/payments/floor": () => ({ body: floorRead({ project, workOrders: wos }) }) });
    window.location.hash = "#/p/payments/floor?view=board";
    mount(<FloorView />);
    const head = await waitFor(() => { const el = document.querySelector('#floor-board [data-station="verify"] h3 .chip'); if (!el) throw new Error("no chip"); return el; });
    expect(head.className).toBe("chip bad");
    expect(head.textContent).toBe("2/1");
    expect(head.getAttribute("title")).toMatch(/Over the WIP limit of 1/);
  });
});
