import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updatePrefs } from "../lib/prefs";
import { DEFAULT_CATALOG } from "@gantry/domain";
import FloorView from "./floor";
import { convWaiting } from "./floor/Drawers";
import { NOW, PAYMENTS, WOS, floorRead, mockApi, mount, resetApp, type Call } from "./floor/testkit";

beforeEach(() => {
  resetApp();
  updatePrefs({ project: "payments", floorView: "belt", boardSwim: "none", replay: null, collapsedBays: false, activeClass: null, boardFilters: { cls: "all", repo: "all", assignee: "all", prio: "all" } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bodyOf = (calls: Call[], method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const live = WOS.filter((w) => w.state !== "done" && w.state !== "killed" && w.bay !== "declined");

describe("Floor: belt", () => {
  it("says the floor is not visible on a 403", async () => {
    mockApi({ "GET /api/v1/projects/payments/floor": () => ({ status: 403, body: { ok: false, msg: "Needs a role on this project." } }) });
    mount(<FloorView />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
  });

  it("draws every station and its gate valve, the work-order tags, the bays and the released block from the floor read", async () => {
    mockApi();
    mount(<FloorView />);
    expect(await screen.findByRole("heading", { name: "Floor" })).toBeTruthy();
    for (const sid of ["intake", "research", "spec", "design", "plan", "build", "verify", "review", "close"]) expect(document.querySelector(`[data-station="${sid}"]`), sid).toBeTruthy();
    // gates are valves with the number waiting; G0+G1 has one waiting work order in the seed
    expect(document.querySelector('[data-gate="G0G1"] .fp-vn')?.textContent).toBe("1");
    // the build station's balloons carry the work orders in the coding slots
    expect(document.querySelector('[data-station="build"] [data-wo="WO-2401"]')).toBeTruthy();
    expect(document.querySelector('[data-station="build"] [data-wo="WO-2402"]')).toBeTruthy();
    // bays hold what left the belt, as trays under the station that parked them
    expect(document.querySelector('[data-bay="sechold"] .fp-bay-c')?.textContent).toBe("1");
    expect(document.querySelector('[data-bay="person"] [data-wo="WO-2409"]')).toBeTruthy();
    expect(document.getElementById("floor-out")?.textContent).toMatch(/RELEASED/);
    // the ticker: on the line, bottleneck, oldest at the gate, released
    const cells = Array.from(document.querySelectorAll("#floor-kpis .tk .k")).map((k) => k.textContent);
    expect(cells).toHaveLength(4);
    expect(cells[0]).toBe("ON THE LINE");
    expect(cells[1]).toBe("BOTTLENECK");
    expect(cells[2]).toMatch(/^OLDEST AT /);
    expect(cells[3]).toBe("RELEASED");
    expect(document.querySelector("#floor-kpis .tk .v")?.textContent).toMatch(new RegExp(`^${live.length}`));
    // no footer under the line; slots and spend ride on the On the line cell's tooltip
    expect(document.getElementById("floor-facts")).toBeNull();
    expect(document.querySelector("#floor-kpis .tk")?.getAttribute("title")).toMatch(/Coding slots 2\/2/);
    // the primary action stays and the title block names the project
    expect(screen.getByRole("button", { name: /Submit work order/ })).toBeTruthy();
    expect(document.querySelector("#floor-head")?.textContent).toMatch(/flow v1/);
  });

  it("names each gate with its code, kind and what it waits for in the valve's label and tooltip", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    const g1 = document.querySelector('[data-gate="G0G1"]') as HTMLElement;
    expect(g1.getAttribute("aria-label")).toMatch(/G0\+G1 · Brief confirmed/);
    expect(g1.querySelector("title")?.textContent).toMatch(/a person approves/);
    expect(g1.textContent).toMatch(/G0\+G1/);
    const auto = document.querySelector('[data-gate="G4"]') as HTMLElement;
    expect(auto.querySelector("title")?.textContent).toMatch(/automatic check/);
  });

  it("shows a gate that is turned off as off, never hides it", async () => {
    const off = { ...PAYMENTS, version: 1, flow: { ...PAYMENTS.flow, gates: { ...PAYMENTS.flow.gates, G3d: { ...PAYMENTS.flow.gates.G3d, enabled: false } } } };
    mockApi({ "GET /api/v1/projects": () => ({ body: [off] }), "GET /api/v1/projects/payments": () => ({ body: off }), "GET /api/v1/projects/payments/floor": () => ({ body: { ...floorRead(), project: off } }) });
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    const g = document.querySelector('[data-gate="G3d"]') as HTMLElement;
    expect(g).toBeTruthy();
    expect(g.classList.contains("off")).toBe(true);
    expect(g.getAttribute("aria-label")).toMatch(/off/);
  });

  it("draws a station with no work faintly (name, limit, agent, idle)", async () => {
    const one = WOS.filter((w) => w.station === 3 && !w.bay).slice(0, 1);
    mockApi({ "GET /api/v1/projects/payments/floor": () => ({ body: floorRead({ workOrders: one, gates: [] }) }) });
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    const idle = document.querySelector('[data-station="research"]') as HTMLElement;
    expect(idle.classList.contains("calm")).toBe(true);
    expect(idle.textContent).toMatch(/IDLE/);
    expect(idle.textContent).toMatch(/NO WAIT/);
    expect(idle.textContent).toMatch(/S1/);
    expect(idle.textContent).toMatch(/WIP0 \/ \d/);
    expect(document.querySelector('[data-station="design"] [data-wo]')).toBeTruthy();
  });

  it("leaves a station that is switched off out of the line", async () => {
    const off = { ...PAYMENTS, version: 1, flow: { ...PAYMENTS.flow, stations: { ...PAYMENTS.flow.stations, research: { ...PAYMENTS.flow.stations.research, enabled: false } } } };
    mockApi({ "GET /api/v1/projects": () => ({ body: [off] }), "GET /api/v1/projects/payments": () => ({ body: off }), "GET /api/v1/projects/payments/floor": () => ({ body: { ...floorRead({ workOrders: [], gates: [] }), project: off } }) });
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    expect(document.querySelector('[data-station="research"]')).toBeNull();
    expect(document.querySelector('[data-station="intake"]')).toBeTruthy();
  });

  it("pins a class route and dims the stations it bypasses", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    fireEvent.click(document.getElementById("floor-routes-toggle") as HTMLElement);
    fireEvent.click(document.getElementById("floor-route-docs") as HTMLElement);
    expect(document.querySelector(".fl-belt")?.classList.contains("has-route")).toBe(true);
    expect(document.querySelector('[data-station="research"]')?.classList.contains("bypass")).toBe(true);
    expect(document.querySelector('[data-station="intake"]')?.classList.contains("bypass")).toBe(false);
    expect(document.getElementById("floor-route-docs")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("lists routes by short class name with the explanation on the pill, behind the Routes toggle", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    const toggle = document.getElementById("floor-routes-toggle") as HTMLElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const docs = document.getElementById("floor-route-docs") as HTMLElement;
    expect(docs.querySelector(".fl-route-n")?.textContent).toBe("Docs");
    expect(docs.getAttribute("aria-label")).toMatch(/^Docs: /);
  });

  it("opens the gate drawer and approves a waiting work order through the gate instance (Approve only, no Reject)", async () => {
    const calls = mockApi({
      "GET /api/v1/work-orders/WO-2408": () => ({ body: { ...WOS.find((w) => w.id === "WO-2408"), version: 3, allowed: { approve: { allowed: true, reason: "Approver rule allows Line Lead.", needs: "", gate: "G3d", instance: "WO-2408:G3d:1" }, moves: {}, can: {} } } }),
      "POST /api/v1/gate-instances/WO-2408%3AG3d%3A1/approve": () => ({ body: { ok: true, msg: "G3d approved." } }),
    });
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    fireEvent.click(document.getElementById("floor-gate-G3d") as HTMLElement);
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    await waitFor(() => expect(approve.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(approve);
    await waitFor(() => expect(bodyOf(calls, "POST", "/api/v1/gate-instances/WO-2408%3AG3d%3A1/approve")).toHaveLength(1));
    expect(await screen.findByText("WO-2408 moved on")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("shows the approvals count and, on click, the approver rule for each work order waiting at the gate", async () => {
    mockApi({
      "GET /api/v1/work-orders/WO-2408": () => ({ body: { ...WOS.find((w) => w.id === "WO-2408"), version: 3, gateProgress: { G3d: { have: 1, need: 2 } }, allowed: { approve: { allowed: true, reason: "", needs: "", gate: "G3d", instance: "WO-2408:G3d:1" }, moves: {}, can: {} } } }),
      "GET /api/v1/work-orders/WO-2408/gates/G3d/approvers": () => ({ body: { gate: "G3d", label: "G3d", name: "Design", rule: { text: "Needs 2 approvals from Line Lead", required: 2, base: 2, sod: true, roles: [], people: [], conditions: [] }, progress: { have: 1, need: 2, approvals: [], unmet: [], onlyRequester: false }, eligible: [], overrides: [], satisfiable: true, warning: "", viewerCanOverride: false, can: { editRule: false, editWhy: "", grantRole: false, grantWhy: "" } } }),
      "GET /api/v1/work-orders/WO-2408/dialogue": () => ({ body: { questions: [], assumptions: [], objections: [] } }),
    });
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    fireEvent.click(document.getElementById("floor-gate-G3d") as HTMLElement);
    expect(await screen.findByText("1 of 2 approvals")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Who may approve" }));
    expect(await screen.findByText("Needs 2 approvals from Line Lead")).toBeTruthy();
  });

  it("locks Approve with the server's reason when this person may not approve (separation of duties)", async () => {
    mockApi({
      "GET /api/v1/work-orders/WO-2408": () => ({ body: { ...WOS.find((w) => w.id === "WO-2408"), version: 3, allowed: { approve: { allowed: false, reason: "Separation of duties on G3d: the author cannot approve.", needs: "Someone other than the author", gate: "G3d", instance: "WO-2408:G3d:1" }, moves: {}, can: {} } } }),
    });
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    fireEvent.click(document.getElementById("floor-gate-G3d") as HTMLElement);
    const approve = await screen.findByRole("button", { name: "Approve" });
    await waitFor(() => expect(approve.getAttribute("aria-disabled")).toBe("true"));
    expect(approve.getAttribute("data-reason")).toMatch(/Separation of duties/);
  });

  it("shows a stale approval as the server's refusal, not as success", async () => {
    mockApi({
      "GET /api/v1/work-orders/WO-2408": () => ({ body: { ...WOS.find((w) => w.id === "WO-2408"), version: 3, allowed: { approve: { allowed: true, reason: "ok", needs: "", gate: "G3d", instance: "WO-2408:G3d:1" }, moves: {}, can: {} } } }),
      "POST /api/v1/gate-instances/WO-2408%3AG3d%3A1/approve": () => ({ status: 409, body: { ok: false, msg: "WO-2408 is not waiting at G3d.", current: { instance: "WO-2408:G3d:2", gate: "G3d", wo: "WO-2408" } } }),
    });
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    fireEvent.click(document.getElementById("floor-gate-G3d") as HTMLElement);
    const approve = await screen.findByRole("button", { name: "Approve" });
    await waitFor(() => expect(approve.getAttribute("aria-disabled")).toBeNull()); // the instance shown is known before a decision can be sent
    fireEvent.click(approve);
    expect(await screen.findByText(/WO-2408 is not waiting at G3d\. It is now at instance 2\. Nothing was decided/)).toBeTruthy();
    expect(document.querySelector(".toast-ok")).toBeNull();
  });
});

describe("Floor: replay", () => {
  it("rebuilds the floor at a past time from the server, locks every control and returns to live", async () => {
    const at = NOW - 3 * 3_600_000;
    const calls = mockApi({
      "GET /api/v1/projects/payments/floor": (c) =>
        c.query.get("at")
          ? { body: floorRead({ at: Number(c.query.get("at")), workOrders: WOS.filter((w) => w.id !== "WO-2400"), gates: [], slots: { used: 0, total: 2, holders: [] }, stop: null, stops: [], replay: { at: Number(c.query.get("at")), workOrders: [], halted: null, killed: null, haltedRepos: {} } }) }
          : { body: floorRead() },
      "GET /api/v1/projects/payments/events": () => ({
        body: [
          { id: 1, at: at - 3_600_000, type: "gate.decision", project: "payments", wo: "WO-2399", gate: "G2", by: "p-meera", trust: null },
          { id: 2, at: at + 3_600_000, type: "halt", project: "payments", scope: "project", by: "p-asha", text: "Duplicate refunds" },
        ],
      }),
    });
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    fireEvent.click(document.getElementById("floor-mode-replay") as HTMLElement);
    const bar = await screen.findByRole("region", { name: "Replay controls" });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/projects/payments/floor" && c.query.has("at"))).toBe(true));
    expect(within(bar).getByText("Replay · not live")).toBeTruthy();
    // acting on the past is locked, with the reason
    expect(document.getElementById("floor-new-wo")?.getAttribute("aria-disabled")).toBe("true");
    // event marks come from the project's event log
    await waitFor(() => expect(document.querySelectorAll(".fl-mk").length).toBeGreaterThan(0));
    expect(document.querySelector(".fl-rp-axis")?.textContent).toMatch(/events marked/);
    fireEvent.click(document.getElementById("floor-rp-live") as HTMLElement);
    await waitFor(() => expect(document.getElementById("floor-replay")).toBeNull());
    expect(document.getElementById("floor-new-wo")?.getAttribute("aria-disabled")).toBeNull();
  });
});

describe("Floor: prototype drawers and links", () => {
  it("opens the station drawer as eyebrow, kv rows, bordered work-order list and a Work orders here footer", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    fireEvent.click(document.getElementById("floor-st-build") as HTMLElement);
    await screen.findByText(/S\d · STATION/);
    expect(document.querySelector("#floor-station-kv dt")?.textContent).toBe("Agent");
    expect(document.querySelector("#floor-station-kv a")?.getAttribute("href")).toMatch(/#\/?.*agents/);
    expect(document.querySelector("#floor-station-wos a.pri")?.getAttribute("href")).toMatch(/record/);
    expect(document.getElementById("floor-drawer-wos")?.textContent).toBe("Work orders here");
    expect(document.getElementById("floor-drawer-wos")?.getAttribute("href")).toBe("#/p/payments/work-orders?station=build");
    // nothing beyond the prototype's drawer: no trust, skills or instructions sections
    expect(screen.queryByText("Skills")).toBeNull();
    expect(screen.queryByText("Instructions")).toBeNull();
    expect(screen.queryByText(/Trust for/)).toBeNull();
  });

  it("labels a station like the prototype: name, work order count, limit, agent", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    expect(document.getElementById("floor-st-build")?.getAttribute("aria-label")).toMatch(/^Build: 2 work orders, limit \d+(, over limit)?, agent /);
  });

  it("opens a work order tag as the compact drawer: Approve G, Open record and Traveler", async () => {
    mockApi({
      "GET /api/v1/work-orders/WO-2398": () => ({ body: { ...WOS.find((w) => w.id === "WO-2398"), version: 3, route: ["intake", "spec"], history: [], gates: {}, gateProgress: {}, allowed: { approve: { allowed: true, reason: "", needs: "", gate: "G0G1", instance: "WO-2398:G0G1:1" }, moves: {}, can: {} } } }),
    });
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    fireEvent.click(document.getElementById("floor-tok-WO-2398") as HTMLElement);
    await screen.findByText("Requested by");
    expect(Array.from(document.querySelectorAll("#floor-wo-kv dt")).map((d) => d.textContent)).toEqual(["Station", "Requested by", "Created", "Progress", "Diff", "PR"]);
    expect(screen.getByRole("button", { name: "Approve G0G1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record for WO-2398" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Conversation for WO-2398" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Journey" })).toBeNull();
    // the Traveler button opens the traveler drawer, which holds Journey, Documents and Run
    await import("./traveler"); // the drawer is a lazy chunk: load it before the click so the open is immediate
    fireEvent.click(document.getElementById("floor-wo-traveler") as HTMLElement);
    expect(await screen.findByRole("tab", { name: "Journey" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Documents" })).toBeTruthy();
  });

  it("opens the work order's conversation from the token drawer, and says why when a station question waits for a person", async () => {
    const withConv = (over: Record<string, unknown>) => () => ({ body: floorRead({ workOrders: WOS.map((w) => (w.id === "WO-2398" ? { ...w, ...over } : w)) }) });
    const base = WOS.find((w) => w.id === "WO-2398")!;
    // nothing waits: the button is there, no reason
    mockApi();
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    fireEvent.click(document.getElementById("floor-tok-WO-2398") as HTMLElement);
    const btn = (await screen.findByRole("button", { name: "Conversation for WO-2398" })) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(window.location.hash).toBe("#/p/payments/conversations/WO-2398");
    expect(document.getElementById("floor-wo-conv-why")).toBeNull();
    cleanup();
    // an open station question: the reason names the station
    mockApi({ "GET /api/v1/projects/payments/floor": withConv({ conv: { ...base.conv, raised: [{ station: "build", text: "Which table?", at: NOW, answered: false }] } }) });
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    fireEvent.click(document.getElementById("floor-tok-WO-2398") as HTMLElement);
    await screen.findByRole("button", { name: "Conversation for WO-2398" });
    expect(document.getElementById("floor-wo-conv-why")?.textContent).toBe("Build is waiting for you");
    // parked with a person (bay tags do not open this drawer on the v3 line, so the reason is checked directly)
    expect(convWaiting({ ...base, bay: "person", bayReason: "needs the table name" } as never, DEFAULT_CATALOG)).toBe("needs the table name");
    expect(convWaiting({ ...base, bay: null } as never, DEFAULT_CATALOG)).toBeNull();
  });

  it("shows the same header in Board as in Belt (Parts list, Focus, Live/Replay, view, Line control, Submit) and reads ?view=board from the hash", async () => {
    mockApi();
    window.location.hash = "#/p/payments/floor?view=board";
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    expect(document.getElementById("floor-board")).toBeTruthy();
    expect(document.getElementById("floor-view-board")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.getElementById("floor-line")).toBeNull();
    expect(screen.getByRole("button", { name: "Replay" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Live" })).toBeTruthy();
    expect(document.getElementById("floor-parts-toggle")).toBeTruthy();
    expect(document.getElementById("floor-focus")).toBeTruthy();
    expect(document.getElementById("floor-line-control")).toBeTruthy();
    expect(document.getElementById("floor-new-wo")).toBeTruthy();
    fireEvent.click(document.getElementById("floor-focus") as HTMLElement);
    expect(document.getElementById("floor-board")?.className).toMatch(/is-focus/);
    // a blocked or stuck part needs a person, so Focus on me must not dim it
    for (const c of Array.from(document.querySelectorAll("#floor-board .card"))) {
      const w = WOS.find((x) => x.id === (c as HTMLElement).dataset.wo);
      if (w && ["blocked", "failed", "killed"].includes(w.state)) expect(c.className).toMatch(/need/);
    }
    fireEvent.click(document.getElementById("floor-parts-toggle") as HTMLElement);
    expect(document.getElementById("floor-parts")).toBeTruthy();
    window.location.hash = "";
  });

  it("Line control in the header opens the halt and emergency stop entries", async () => {
    mockApi();
    mount(<FloorView />);
    fireEvent.click(await screen.findByRole("button", { name: /Line control/ }));
    expect(await screen.findByRole("menuitem", { name: /Halt line/ })).toBeTruthy();
    expect(await screen.findByText("Pause one repo")).toBeTruthy();
    expect(screen.getAllByRole("menuitem", { name: /^Pause / }).length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Emergency stop/ }));
    expect(await screen.findByText("Emergency stop the factory")).toBeTruthy();
  });

  it("keeps the view in the URL only: Board does not survive a remount without ?view=board", async () => {
    mockApi();
    window.location.hash = "#/p/payments/floor";
    const first = mount(<FloorView />);
    await screen.findAllByText("PAY");
    fireEvent.click(document.getElementById("floor-view-board") as HTMLElement);
    expect(document.getElementById("floor-board")).toBeTruthy();
    expect(window.location.hash).toMatch(/view=board/);
    (first as { unmount?: () => void } | undefined)?.unmount?.();
    window.history.replaceState(null, "", "/"); // the address without ?view=board
    window.location.hash = "#/p/payments/floor";
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    expect(document.getElementById("floor-board")).toBeNull();
    expect(document.getElementById("floor-belt")).toBeTruthy();
    window.location.hash = "";
  });

  it("draws the legend, keeps the routes toggle in the drawing's header and the live switch in the Floor header", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    expect(document.querySelectorAll(".fp-li")).toHaveLength(7);
    expect(document.querySelector("#floor-line #floor-routes-toggle")).toBeTruthy();
    expect(document.querySelector("#floor-head #floor-mode-live")).toBeTruthy();
    expect(document.querySelector(".fp-gate .hit")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Assign" })).toBeNull();
  });

  it("opens the gate drawer with Kind, After station, Checks and a Waiting now list", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    fireEvent.click(document.getElementById("floor-gate-G0G1") as HTMLElement);
    await screen.findByText("Waiting now");
    expect(Array.from(document.querySelectorAll("#floor-gate-kv dt")).map((d) => d.textContent)).toEqual(["Kind", "After station", "Checks"]);
    expect(screen.getByText(/G0\+G1 · GATE/)).toBeTruthy();
    expect(document.querySelector("#floor-gate-kv dd .chip")?.textContent).toBe("human");
  });

  it("opens Released with a Work orders footer link, a bay tray as the bay drawer and a bay balloon as the work order drawer", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    fireEvent.click(document.getElementById("floor-out") as HTMLElement);
    await screen.findByText(/OUT · TERMINUS/);
    expect(document.getElementById("floor-drawer-wos")?.textContent).toBe("Work orders");
    cleanup();
    mockApi();
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    fireEvent.click(document.getElementById("floor-bay-spec-person") as HTMLElement);
    await screen.findByText(/^S\d · SIDE BAY$/);
    await waitFor(() => expect(document.querySelector("#floor-bay-list [data-wo]")?.getAttribute("data-wo")).toBe("WO-2409"));
  });
});


describe("Request changes at a gate (floor drawer)", () => {
  it("opens the gate drawer, asks for changes and sends the pinned gate instance", async () => {
    const calls = mockApi({
      "GET /api/v1/work-orders/WO-2408": () => ({ body: { ...WOS.find((w) => w.id === "WO-2408"), version: 3, allowed: { approve: { allowed: true, reason: "", needs: "", gate: "G3d", instance: "WO-2408:G3d:1" }, moves: {}, can: {} } } }),
      "POST /api/v1/gate-instances/WO-2408%3AG3d%3A1/reject": () => ({ body: { ok: true, msg: "Sent back." } }),
    });
    mount(<FloorView />);
    await screen.findAllByText("PAY");
    fireEvent.click(document.getElementById("floor-gate-G3d") as HTMLElement);
    const btn = await screen.findByRole("button", { name: /^Request changes on WO-2408/ });
    await waitFor(() => expect(btn.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(btn);
    const dlg = await waitFor(() => { const e = document.querySelector<HTMLElement>(".dlg"); if (!e) throw new Error("no dialog"); return e; });
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Name the migration rollback" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(bodyOf(calls, "POST", "/api/v1/gate-instances/WO-2408%3AG3d%3A1/reject")).toHaveLength(1));
    expect(bodyOf(calls, "POST", "/api/v1/gate-instances/WO-2408%3AG3d%3A1/reject")[0]?.body).toMatchObject({ reason: "Name the migration rollback" });
  });
});

describe("Floor: precision sheet", () => {
  const only = (ids: string[]) => () => ({ body: floorRead({ workOrders: WOS.filter((w) => ids.includes(w.id)), gates: [] }) });

  it("hides the Parts list until its button is pressed, keeps it in the URL with its sort, and gives the drawing the full width meanwhile", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    expect(document.getElementById("floor-parts")).toBeNull();
    expect(document.querySelector(".fp-main")?.classList.contains("has-parts")).toBe(false);
    const btn = screen.getByRole("button", { name: /^Parts list \(\d+\)$/ });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(document.getElementById("floor-parts")).toBeTruthy();
    expect(window.location.hash).toMatch(/parts=open/);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".fp-main")?.classList.contains("has-parts")).toBe(true);
    // grouped by what each part needs, a part per work order
    expect(document.querySelector("#floor-parts .fp-gh")?.textContent).toMatch(/NEEDS YOU · AT G/);
    expect(document.querySelectorAll("#floor-parts .fp-pr").length).toBeGreaterThan(10);
    fireEvent.click(document.getElementById("floor-parts-sort-wait") as HTMLElement);
    expect(window.location.hash).toMatch(/psort=wait/);
    expect(document.querySelector("#floor-parts .fp-gh")).toBeNull();
    fireEvent.click(document.getElementById("floor-parts-close") as HTMLElement);
    expect(document.getElementById("floor-parts")).toBeNull();
    expect(window.location.hash).not.toMatch(/parts=/);
    window.history.replaceState(null, "", "/");
  });

  it("opens the Parts list from the address, and a part opens the same work order drawer a balloon does", async () => {
    mockApi();
    window.history.replaceState(null, "", "/?parts=open&psort=rev");
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    expect(document.getElementById("floor-parts")).toBeTruthy();
    expect(document.getElementById("floor-parts-sort-rev")?.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(document.getElementById("floor-part-WO-2398") as HTMLElement);
    expect(await screen.findByRole("button", { name: "Record for WO-2398" })).toBeTruthy();
    window.history.replaceState(null, "", "/");
  });

  it("closes the Parts list with Escape and puts focus on its close button when it opens", async () => {
    mockApi();
    window.history.replaceState(null, "", "/?parts=open");
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    expect(document.activeElement?.id).toBe("floor-parts-close");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.getElementById("floor-parts")).toBeNull());
    window.history.replaceState(null, "", "/");
  });

  it("marks the bottleneck: the station over its limit is flagged on the drawing and named in the ticker", async () => {
    const tight = { ...PAYMENTS, version: 1, flow: { ...PAYMENTS.flow, stations: { ...PAYMENTS.flow.stations, build: { ...PAYMENTS.flow.stations.build, wip: 1 } } } };
    mockApi({ "GET /api/v1/projects": () => ({ body: [tight] }), "GET /api/v1/projects/payments": () => ({ body: tight }), "GET /api/v1/projects/payments/floor": () => ({ body: { ...floorRead(), project: tight } }) });
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    const build = document.querySelector('[data-station="build"]') as HTMLElement;
    expect(build.classList.contains("over")).toBe(true);
    expect(build.querySelector(".fp-flag")?.textContent).toMatch(/BOTTLENECK 200%/);
    expect(document.querySelector('[data-station="verify"]')?.classList.contains("over")).toBe(false);
    const cell = document.querySelectorAll("#floor-kpis .tk")[1] as HTMLElement;
    expect(cell.classList.contains("bott")).toBe(true);
    expect(cell.textContent).toMatch(/S5 2\/1\+1 over/);
  });

  it("says plainly when nothing is over a limit", async () => {
    mockApi({ "GET /api/v1/projects/payments/floor": only(["WO-2398"]) });
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    expect(document.querySelector(".fp-flag.r, .fp-flag rect.r")).toBeNull();
    expect(document.querySelectorAll("#floor-kpis .tk")[1]?.textContent).toMatch(/none/);
  });

  it("lists what waits on a person, oldest first, and each Open button goes to the right place", async () => {
    mockApi({ "GET /api/v1/projects/payments/floor": only(["WO-2398", "WO-2409"]) });
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    expect(document.getElementById("floor-need-n")?.textContent).toBe("2");
    const cards = Array.from(document.querySelectorAll("#floor-need .fp-ncard")) as HTMLElement[];
    expect(cards.map((c) => c.getAttribute("data-k"))).toEqual(expect.arrayContaining(["gate:G0G1", expect.stringMatching(/^bay:spec:person$/)]));
    // a gate with people waiting opens the gate drawer
    fireEvent.click(within(document.querySelector('[data-k="gate:G0G1"]') as HTMLElement).getByRole("button"));
    expect(await screen.findByText("Waiting now")).toBeTruthy();
    cleanup();
    mockApi({ "GET /api/v1/projects/payments/floor": only(["WO-2398", "WO-2409"]) });
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    // a bay holding one work order opens that work order
    fireEvent.click(within(document.querySelector('[data-k="bay:spec:person"]') as HTMLElement).getByRole("button"));
    expect(await screen.findByRole("button", { name: "Record for WO-2409" })).toBeTruthy();
  });

  it("dims what does not need a person in Focus on me, from the URL", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findByRole("heading", { name: "Floor" });
    const btn = screen.getByRole("button", { name: "Focus on me" });
    expect(document.querySelector(".fp-main")?.classList.contains("is-focus")).toBe(false);
    fireEvent.click(btn);
    expect(document.querySelector(".fp-main")?.classList.contains("is-focus")).toBe(true);
    expect(window.location.hash).toMatch(/focus=1/);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    window.history.replaceState(null, "", "/");
  });

  it("is a stacked station list at phone width, with the same stations, gates, bays and balloons and no drawing sheet", async () => {
    const was = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      mockApi();
      mount(<FloorView />);
      await screen.findByRole("heading", { name: "Floor" });
      expect(document.querySelector("svg.fp-dw")).toBeNull();
      expect(document.querySelector(".fp-stack")).toBeTruthy();
      for (const sid of ["intake", "build", "review", "close"]) expect(document.querySelector(`.fp-stack [data-station="${sid}"]`), sid).toBeTruthy();
      expect(document.querySelector('.fp-stack [data-gate="G0G1"]')?.textContent).toMatch(/G0\+G1/);
      expect(document.querySelector('.fp-stack [data-bay="person"] [data-wo="WO-2409"]')).toBeTruthy();
      expect(document.getElementById("floor-out")).toBeTruthy();
      // a balloon chip opens the same drawer
      fireEvent.click(document.querySelector('.fp-stack [data-wo="WO-2398"]') as HTMLElement);
      expect(await screen.findByRole("button", { name: "Record for WO-2398" })).toBeTruthy();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: was });
    }
  });
});

describe("wrapText (captions are shown whole, never cut with an ellipsis)", () => {
  it("wraps on words and splits an over-long word", async () => {
    const { wrapText } = await import("./floor/Line");
    expect(wrapText("holding 1 for G0+G1 · oldest 13h 08m", 20)).toEqual(["holding 1 for G0+G1", "· oldest 13h 08m"]);
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("", 10)).toEqual([""]);
    const long = "WO-2417 · Verify needs secret SEPA_SANDBOX_KEY; the Test Engineer has no secrets access on payout service until a person grants it for this run";
    expect(wrapText(long, 20).join(" ")).toBe(long); // no line cap: the caption is whole
    expect(wrapText("WO-2407 · Support partial refunds on Amex", 20).join(" ")).not.toMatch(/…/);
  });
});
