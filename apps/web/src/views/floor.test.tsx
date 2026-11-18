import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updatePrefs } from "../lib/prefs";
import FloorView from "./floor";
import WorkOrdersView from "./work-orders";
import { NOW, WOS, floorRead, mockApi, mount, resetApp, type Call } from "./floor/testkit";

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

  it("draws the Control Room conveyor: a station per step, bays, gates between, IN and OUT caps", async () => {
    mockApi();
    mount(<FloorView />);
    expect(await screen.findByRole("button", { name: /Line control/ })).toBeTruthy();
    for (const sid of ["intake", "research", "spec", "design", "plan", "build", "verify", "review", "close"]) expect(document.querySelector(`.belt .stn[data-s="${sid}"]`), sid).toBeTruthy();
    expect(document.querySelector(".belt .cap.cin")).toBeTruthy();
    expect(document.querySelector(".belt .cap.cout")).toBeTruthy();
    expect(document.querySelectorAll(".belt .gate").length).toBeGreaterThan(0);
    // the coding station's bays are the project's slots
    expect(document.querySelectorAll('.belt .stn[data-s="build"] .bay').length).toBeGreaterThan(0);
    // every live work order is on the belt as a token or a queue chip
    expect(document.querySelectorAll(".belt .tok, .belt .qc").length).toBe(live.filter((w) => !w.bay || w.bay !== "declined").length);
  });

  it("narrows the belt with the search box and dims what does not match", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    fireEvent.change(screen.getByLabelText("Find a work order"), { target: { value: "WO-2401" } });
    await waitFor(() => expect(document.querySelectorAll(".belt .tok.hit, .belt .qc.hit").length).toBe(1));
    expect(document.querySelectorAll(".belt .tok.dim, .belt .qc.dim").length).toBeGreaterThan(0);
  });
});

// ops2 removed the Table/Board toggle from Work orders (prototype), so the board is not reachable from WorkOrdersView any more.
describe.skip("Work orders: board", () => {
  beforeEach(() => updatePrefs({ floorView: "board" }));
  it("shows a column per station and bay, cards with their gate text, and filters by class", async () => {
    mockApi();
    mount(<WorkOrdersView />);
    await screen.findByText("Add idempotency keys to refund endpoint");
    expect(document.querySelectorAll(".fl-col[data-drop]").length).toBe(9 + 5);
    const card = document.querySelector('[data-wo="WO-2400"].fl-card') as HTMLElement;
    expect(card.querySelector(".fl-gt")?.textContent).toMatch(/Plan and security waiting/);
    const all = document.querySelectorAll(".fl-card").length;
    fireEvent.change(document.getElementById("floor-f-cls") as HTMLElement, { target: { value: "bug" } });
    expect(document.querySelectorAll(".fl-card").length).toBeLessThan(all);
    for (const c of Array.from(document.querySelectorAll(".fl-card .cls"))) expect(c.className).toMatch(/cls-bug/);
    fireEvent.click(document.getElementById("floor-f-clear") as HTMLElement);
    expect(document.querySelectorAll(".fl-card").length).toBe(all);
  });

  it("checks a drag with the server first and refuses a drop it says no to", async () => {
    const calls = mockApi({
      "POST /api/v1/work-orders/WO-2401/move": (c) => (c.body?.dry_run ? { body: { ok: true, msg: "Cannot skip stations.", allowed: false, reason: "Cannot skip stations." } } : { body: { ok: true, msg: "moved" } }),
    });
    mount(<WorkOrdersView />);
    await screen.findByText("Emit ledger events for failed payouts");
    const card = document.querySelector('[data-wo="WO-2401"].fl-card') as HTMLElement;
    const target = document.querySelector('[data-drop="close"]') as HTMLElement;
    document.elementFromPoint = vi.fn(() => target.querySelector(".fl-col-cards") ?? target);
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
    fireEvent(window, new MouseEvent("pointermove", { clientX: 60, clientY: 60 }));
    await waitFor(() => expect(target.querySelector(".fl-col-why")?.textContent).toBe("Refused: Cannot skip stations."));
    expect(target.classList.contains("is-no")).toBe(true);
    fireEvent(window, new MouseEvent("pointerup", { clientX: 60, clientY: 60 }));
    await waitFor(() => expect(screen.getByText(/Cannot move WO-2401: Cannot skip stations\./)).toBeTruthy());
    const moves = bodyOf(calls, "POST", "/api/v1/work-orders/WO-2401/move");
    expect(moves.every((m) => m.body?.dry_run === true)).toBe(true);
  });

  it("moves a card through the Move to menu, asking for the reason a bay needs", async () => {
    const calls = mockApi({
      "GET /api/v1/work-orders/WO-2401": () => ({
        body: {
          ...WOS.find((w) => w.id === "WO-2401"),
          allowed: { approve: null, moves: { intake: { allowed: false, reason: "Intake is behind it." }, build: { allowed: false, reason: "WO-2401 is already here." }, sechold: { allowed: true, reason: "Parks it in Security hold.", kind: "park" } }, can: {} },
        },
      }),
      "POST /api/v1/work-orders/WO-2401/move": (c) => (c.body?.dry_run ? undefined : { body: { ok: true, msg: "WO-2401 moved to Security hold." } }),
    });
    mount(<WorkOrdersView />);
    await screen.findByText("Emit ledger events for failed payouts");
    fireEvent.click(document.getElementById("floor-move-WO-2401") as HTMLElement);
    const refused = await screen.findByRole("menuitem", { name: /S0 Intake/ });
    expect(refused.getAttribute("aria-disabled")).toBe("true");
    expect(refused.getAttribute("data-reason")).toMatch(/Intake is behind it/);
    fireEvent.click(screen.getByRole("menuitem", { name: /Security hold/ }));
    // the bay needs a reason before anything is sent
    await screen.findByText("Move WO-2401 to Security hold");
    expect(bodyOf(calls, "POST", "/api/v1/work-orders/WO-2401/move").filter((c) => !c.body?.dry_run)).toHaveLength(0);
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
    await screen.findByRole("button", { name: /Line control/ });
    fireEvent.click(document.querySelector("label[for=floor-mode-replay]") as HTMLElement);
    const bar = await screen.findByRole("region", { name: "Replay controls" });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/projects/payments/floor" && c.query.has("at"))).toBe(true));
    expect(within(bar).getByText("Replay · not live")).toBeTruthy();
    // acting on the past is locked, with the reason
    expect(document.getElementById("floor-new-wo")?.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById("floor-line")?.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById("floor-line")?.getAttribute("data-reason")).toMatch(/Replay is showing the past/);
    // event marks come from the project's event log
    await waitFor(() => expect(document.querySelectorAll(".fl-mk").length).toBeGreaterThan(0));
    expect(document.querySelector(".fl-rp-axis")?.textContent).toMatch(/events marked/);
    fireEvent.click(document.getElementById("floor-rp-live") as HTMLElement);
    await waitFor(() => expect(document.getElementById("floor-replay")).toBeNull());
    expect(document.getElementById("floor-new-wo")?.getAttribute("aria-disabled")).toBeNull();
  });
});

describe("Floor: andon and kill", () => {
  it("halts the project with a reason and resumes it", async () => {
    const calls = mockApi({
      "POST /api/v1/stops": () => ({ body: { ok: true, msg: "Payments Platform halted." } }),
      "DELETE /api/v1/stops/project%3Apayments": () => ({ body: { ok: true, msg: "Payments Platform resumed." } }),
    });
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    fireEvent.click(document.getElementById("floor-line") as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Halt Payments Platform/ }));
    fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "Duplicate refunds seen" } });
    fireEvent.click(document.getElementById("rsn-ok") as HTMLElement);
    await waitFor(() => expect(bodyOf(calls, "POST", "/api/v1/stops")).toHaveLength(1));
    expect(bodyOf(calls, "POST", "/api/v1/stops")[0]?.body).toMatchObject({ scope: "project", id: "payments", mode: "halt", reason: "Duplicate refunds seen" });
  });

  it("locks Kill project in the Line control menu for someone without the right, with the reason", async () => {
    mockApi({}, { denied: ["kill.project"] });
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    await waitFor(() => expect(document.getElementById("floor-line")).toBeTruthy());
    fireEvent.click(document.getElementById("floor-line") as HTMLElement);
    const kill = await screen.findByRole("menuitem", { name: /Kill Payments Platform/ });
    await waitFor(() => expect(kill.getAttribute("aria-disabled")).toBe("true"));
    expect(kill.getAttribute("data-reason")).toMatch(/Factory Admin/);
  });

  it("locks Halt in the Line control menu for someone who may not halt, with the reason", async () => {
    mockApi({}, { denied: ["line.halt"] });
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    await waitFor(() => expect(document.getElementById("floor-line")).toBeTruthy());
    fireEvent.click(document.getElementById("floor-line") as HTMLElement);
    const halt = await screen.findByRole("menuitem", { name: /Halt Payments Platform/ });
    await waitFor(() => expect(halt.getAttribute("aria-disabled")).toBe("true"));
    expect(halt.getAttribute("data-reason")).toMatch(/No role holds it/);
  });
});


describe("Floor: fidelity round 1", () => {
  it("has the prototype header: eyebrow Operate, plain Floor title, Pause belt and Halt line first", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    expect(document.querySelector(".ph .eyebrow")?.textContent).toBe("Operate");
    expect(document.querySelector(".ph h1")?.textContent).toBe("Floor");
    const labels = [...document.querySelectorAll(".ph .acts .btn")].map((b) => b.textContent);
    expect(labels.slice(0, 2)).toEqual(["Pause belt", "Halt line"]);
    expect(screen.getByText("Per hour")).toBeTruthy();
  });

  it("keeps the filters in the URL and clears them", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    fireEvent.change(screen.getByLabelText("Find a work order"), { target: { value: "WO-2401" } });
    await waitFor(() => expect(window.location.search).toContain("q=WO-2401"));
    fireEvent.change(screen.getByLabelText("Class"), { target: { value: "bug" } });
    await waitFor(() => expect(window.location.search).toContain("cls=bug"));
    fireEvent.click(screen.getByText("Clear"));
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("opens the token drawer in the prototype layout with Traveler and Open record", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    fireEvent.click(document.querySelector(".belt .tok") as HTMLElement);
    expect(await screen.findByText("Open record")).toBeTruthy();
    expect(screen.getByText("Traveler")).toBeTruthy();
    expect(document.querySelector(".drawer .drawer-h")).toBeTruthy();
    expect(document.querySelector(".drawer .pipe .st")).toBeTruthy();
    fireEvent.click(screen.getByText("Traveler"));
    await waitFor(() => expect(window.location.hash).toMatch(/\/traveler\/WO-/));
    expect(document.querySelector(".drawer .drawer-h")).toBeNull();
  });

  it("shows the prototype empty states: no gates waiting, and an empty belt", async () => {
    mockApi({ "GET /api/v1/projects/payments/floor": () => ({ body: floorRead({ gates: [], workOrders: [] }) }) });
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    expect(await screen.findByText("No gates waiting")).toBeTruthy();
    expect(document.querySelectorAll(".belt .tok").length).toBe(0);
    expect(document.querySelector("#floor-kpis")?.textContent).toMatch(/On belt\s*0/);
  });

  it("shows Review only for a work order with an open gate approval, and it opens the approval dialog", async () => {
    mockApi({
      "GET /api/v1/projects/payments/floor": () => ({ body: floorRead({ gates: [{ instance: "gi-1", wo: "WO-2404", gate: "G5", since: NOW - 3600000 }] }) }),
      "GET /api/v1/work-orders/WO-2404/gates/G5/approvers": () => ({ body: { gate: "G5", label: "G5", eligible: [], overrides: [], satisfiable: true, warning: "", viewerCanOverride: false, can: { editRule: false, editWhy: "", grantRole: false, grantWhy: "" }, progress: { have: 0, need: 1, approvals: [], unmet: [] }, rule: { text: "One approval", conditions: [], base: 1 } } }),
    });
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    await screen.findByText("Waiting at gates");
    await waitFor(() => expect(document.querySelectorAll('#floor-gates [id^="floor-review-"]').length).toBe(1));
    expect(document.querySelectorAll('#floor-gates .li').length).toBe(1);
    fireEvent.click(document.querySelector('#floor-review-WO-2404') as HTMLElement);
    expect(await screen.findByText("Evidence")).toBeTruthy();
    for (const n of ["Cancel", "Request changes", "Reject", "Approve"]) expect(screen.getByRole("button", { name: new RegExp(`^${n}`) }), n).toBeTruthy();
    expect(screen.getByLabelText("Comment")).toBeTruthy();
  });

  it("opens the gate and station drawers with the prototype key facts and footer links", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    fireEvent.click(document.querySelector(".belt .gate .gh") as HTMLElement);
    expect(await screen.findByText("Configure gates")).toBeTruthy();
    expect(screen.getByText("After station")).toBeTruthy();
    cleanup();
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    fireEvent.click(document.querySelector(".belt .stn-h") as HTMLElement);
    expect(await screen.findByText("Work here")).toBeTruthy();
    expect(screen.getByText("Capacity")).toBeTruthy();
    expect(screen.getByText("Eval score")).toBeTruthy();
  });
});

describe("Floor: kill banner", () => {
  it("shows the Factory stopped banner with Start restore when the factory is killed", async () => {
    mockApi({}, { me: { factory: { killed: { reason: "Bad deploy", by: "p-asha", at: 1, mode: "hold" } } } });
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    expect(await screen.findByText("Start restore")).toBeTruthy();
    expect(document.querySelector("#floor-kill-banner")?.getAttribute("role")).toBe("alert");
  });
});

describe("Floor: fidelity round 2", () => {
  const ready = async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
  };

  it("keeps the toolbar to search and the three selects; the line controls sit with the header actions", async () => {
    await ready();
    expect(document.getElementById("floor-extra")).toBeNull();
    expect(document.querySelector(".ph")?.textContent).not.toMatch(/Running|live/);
    expect(document.querySelector(".fl-tools #floor-line")).toBeNull();
    expect(document.querySelector(".fl-tools #floor-new-wo")).toBeNull();
    expect(document.querySelector(".fl-tools .fl-extra")).toBeNull();
    expect(document.querySelectorAll(".fl-tools select").length).toBe(3);
    expect(document.querySelector(".belt-legend #floor-line")).toBeNull();
    expect(document.querySelector(".ph .acts #floor-line")).toBeTruthy();
    expect(document.querySelector(".ph .acts #floor-new-wo")).toBeTruthy();
    expect(document.querySelector(".ph .acts input[name=floor-mode]")).toBeTruthy();
    // the three extras share one group, so at phone width they take one row under Pause belt and Halt line
    const grp = document.querySelector(".ph .acts > .fl-ctl");
    expect(grp?.querySelector("#floor-line")).toBeTruthy();
    expect(grp?.querySelector("#floor-new-wo")).toBeTruthy();
    expect(grp?.querySelector("input[name=floor-mode]")).toBeTruthy();
  });

  it("names each gate header by its belt label, never the raw catalogue id", async () => {
    await ready();
    const labels = [...document.querySelectorAll(".belt .gate .gh")].map((b) => b.getAttribute("aria-label") ?? "");
    expect(labels.length).toBeGreaterThan(1);
    labels.forEach((l, i) => {
      expect(l).toMatch(new RegExp(`^Gate G${i + 1} `));
      expect(l).not.toMatch(/G0G1|G3d|G3G3s/);
    });
    for (const b of document.querySelectorAll(".belt .gate .gh")) expect(b.getAttribute("title")).not.toMatch(/G0G1|G3d|G3G3s/);
  });

  it("numbers the belt's gates G1, G2, ... in line order, never repeating a label", async () => {
    await ready();
    const labels = [...document.querySelectorAll(".belt .gate .gh b")].map((b) => b.textContent);
    expect(labels.length).toBeGreaterThan(1);
    expect(labels).toEqual(labels.map((_, i) => `G${i + 1}`));
  });

  it("Halt line opens the Emergency stop dialog: reason of 10 characters and the word STOP", async () => {
    const calls = mockApi({ "POST /api/v1/stops": () => ({ body: { ok: true, msg: "Payments Platform killed." } }) });
    mount(<FloorView />);
    await screen.findByRole("button", { name: /Line control/ });
    fireEvent.click(document.getElementById("floor-halt") as HTMLElement);
    expect(await screen.findByText(/Emergency stop: Payments Platform/)).toBeTruthy();
    expect(screen.getByText("Type STOP to confirm")).toBeTruthy();
    expect(screen.queryByText(/hold|Hold in place/i)).toBeNull();
    const ok = await screen.findByRole("button", { name: "Stop now" });
    fireEvent.change(document.querySelector("#emergency-stop textarea") as HTMLElement, { target: { value: "Duplicate refunds seen" } });
    fireEvent.change(document.querySelector("#emergency-stop input") as HTMLElement, { target: { value: "stop" } });
    fireEvent.click(ok);
    expect(await screen.findByText("Type STOP in capitals.")).toBeTruthy();
    expect(bodyOf(calls, "POST", "/api/v1/stops")).toHaveLength(0);
    fireEvent.change(document.querySelector("#emergency-stop input") as HTMLElement, { target: { value: "STOP" } });
    fireEvent.click(ok);
    await waitFor(() => expect(bodyOf(calls, "POST", "/api/v1/stops")).toHaveLength(1));
    expect(bodyOf(calls, "POST", "/api/v1/stops")[0]?.body).toMatchObject({ scope: "project", id: "payments", mode: "kill", reason: "Duplicate refunds seen" });
  });

  it("opens the station drawer from the header and from +N more without crashing, with an agent link and work rows", async () => {
    await ready();
    fireEvent.click(document.querySelector(".belt .stn-h") as HTMLElement);
    expect(await screen.findByText("Work here")).toBeTruthy();
    expect(document.querySelector(".drawer dl.kv a")?.getAttribute("href")).toMatch(/agents\//);
    expect(document.querySelector(".drawer .li.click")).toBeTruthy();
  });

  it("the station drawer shows autonomy as a level (L1 to L3), not the raw word", async () => {
    await ready();
    fireEvent.click(document.querySelector(".belt .stn-h") as HTMLElement);
    await screen.findByText("Work here");
    const dd = [...document.querySelectorAll(".drawer dl.kv dd")].map((d) => d.textContent);
    expect(dd.some((t) => /^L[1-3]$/.test(t ?? ""))).toBe(true);
    expect(dd).not.toContain("gate");
  });

  it("the token drawer marks stations before the current one with a check and scrolls the current one into view", async () => {
    await ready();
    const toks = [...document.querySelectorAll<HTMLElement>(".belt .lanes .tok")];
    const later = toks[toks.length - 1] as HTMLElement;
    fireEvent.click(later);
    await waitFor(() => expect(document.querySelector(".drawer .pipe")).toBeTruthy());
    expect(document.querySelectorAll(".drawer .pipe .st.done i").length).toBeGreaterThan(0);
    expect([...document.querySelectorAll(".drawer .pipe .st.done i")].every((i) => i.textContent === "\u2713")).toBe(true);
    expect(document.querySelectorAll(".drawer .pipe .st.cur").length).toBe(1);
  });

  it("the gate drawer is the prototype's: Mode, After station, Waiting, one list, only Configure gates in the footer", async () => {
    await ready();
    fireEvent.click(document.querySelector(".belt .gate .gh") as HTMLElement);
    await screen.findByText("After station");
    expect(screen.getByText("Mode")).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect([...document.querySelectorAll(".drawer-f .btn")].map((b) => b.textContent)).toEqual(["Configure gates"]);
    expect(screen.queryByText("Recent decisions")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Approve|^Reject/ })).toBeNull();
  });
});
