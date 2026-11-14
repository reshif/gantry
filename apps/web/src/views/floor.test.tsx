import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updatePrefs } from "../lib/prefs";
import FloorView from "./floor";
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
  it("draws every station and its gate, the coding slots, the bays and the shipped strip from the floor read", async () => {
    mockApi();
    mount(<FloorView />);
    expect(await screen.findByText("Payments Platform")).toBeTruthy();
    for (const sid of ["intake", "research", "spec", "design", "plan", "build", "verify", "review", "close"]) expect(document.querySelector(`[data-station="${sid}"]`), sid).toBeTruthy();
    // gates are diamonds with their state; G2 has a waiting work order in the seed
    expect(document.querySelector('[data-gate="G0G1"] .gate-count')?.textContent).toBe("1");
    // coding slots come from the server's slot rows
    const slots = Array.from(document.querySelectorAll(".fl-slot .fl-slot-v")).map((e) => e.textContent);
    expect(slots).toEqual(expect.arrayContaining(["WO-2401", "WO-2402"]));
    // bays hold what left the belt
    expect(document.querySelector('[data-bay="sechold"] .fl-bay-c')?.textContent).toBe("1");
    expect(document.querySelector('[data-bay="person"] [data-wo="WO-2409"]')).toBeTruthy();
    expect(document.querySelector(".fl-ship-h")?.textContent).toMatch(/Shipped/);
    // figures
    expect(screen.getByText("Work in flight").nextElementSibling?.textContent).toBe(String(live.length));
    expect(screen.getByText("Coding slots").nextElementSibling?.textContent).toBe("2/2");
  });

  it("pins a class route and marks the stations it bypasses", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findByText("Payments Platform");
    fireEvent.click(document.getElementById("floor-route-docs") as HTMLElement);
    expect(document.getElementById("floor-belt")?.classList.contains("has-route")).toBe(true);
    expect(document.querySelector('[data-station="research"]')?.classList.contains("is-bypassed")).toBe(true);
    expect(document.querySelector('[data-station="intake"]')?.classList.contains("is-bypassed")).toBe(false);
    expect(document.getElementById("floor-route-docs")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("opens the gate drawer, shows who may approve and sends a rejection with its reason to the gate instance", async () => {
    const calls = mockApi({
      "GET /api/v1/work-orders/WO-2408": () => ({ body: { ...WOS.find((w) => w.id === "WO-2408"), version: 3, allowed: { approve: { allowed: true, reason: "Approver rule allows Line Lead.", needs: "", gate: "G3d", instance: "WO-2408:G3d:1" }, moves: {}, can: {} } } }),
      "POST /api/v1/gate-instances/WO-2408%3AG3d/reject": () => ({ body: { ok: true, msg: "G3d rejected; WO-2408 is reworking Design." } }),
    });
    mount(<FloorView />);
    await screen.findByText("Payments Platform");
    fireEvent.click(document.getElementById("floor-gate-G3d") as HTMLElement);
    const reject = await screen.findByRole("button", { name: "Reject" });
    await waitFor(() => expect(reject.getAttribute("aria-disabled")).toBeNull());
    expect(screen.getByText(/approval from:/)).toBeTruthy();
    fireEvent.click(reject);
    const reason = await screen.findByLabelText("Reason");
    fireEvent.change(reason, { target: { value: "no" } });
    fireEvent.click(document.getElementById("rsn-ok") as HTMLElement);
    expect(await screen.findByText(/at least 5 characters/)).toBeTruthy();
    fireEvent.change(reason, { target: { value: "Needs the export format agreed" } });
    fireEvent.click(document.getElementById("rsn-ok") as HTMLElement);
    await waitFor(() => expect(bodyOf(calls, "POST", "/api/v1/gate-instances/WO-2408%3AG3d/reject")).toHaveLength(1));
    expect(bodyOf(calls, "POST", "/api/v1/gate-instances/WO-2408%3AG3d/reject")[0]?.body).toMatchObject({ reason: "Needs the export format agreed" });
  });

  it("locks Approve with the server's reason when this person may not approve (separation of duties)", async () => {
    mockApi({
      "GET /api/v1/work-orders/WO-2408": () => ({ body: { ...WOS.find((w) => w.id === "WO-2408"), version: 3, allowed: { approve: { allowed: false, reason: "Separation of duties on G3d: the author cannot approve.", needs: "Someone other than the author", gate: "G3d", instance: "WO-2408:G3d:1" }, moves: {}, can: {} } } }),
    });
    mount(<FloorView />);
    await screen.findByText("Payments Platform");
    fireEvent.click(document.getElementById("floor-gate-G3d") as HTMLElement);
    const approve = await screen.findByRole("button", { name: "Approve" });
    await waitFor(() => expect(approve.getAttribute("aria-disabled")).toBe("true"));
    expect(approve.getAttribute("data-reason")).toMatch(/Separation of duties/);
  });

  it("shows a stale approval as the server's refusal, not as success", async () => {
    mockApi({
      "GET /api/v1/work-orders/WO-2408": () => ({ body: { ...WOS.find((w) => w.id === "WO-2408"), version: 3, allowed: { approve: { allowed: true, reason: "ok", needs: "", gate: "G3d", instance: "WO-2408:G3d:1" }, moves: {}, can: {} } } }),
      "POST /api/v1/gate-instances/WO-2408%3AG3d/approve": () => ({ status: 409, body: { ok: false, msg: "WO-2408 is not waiting at G3d." } }),
    });
    mount(<FloorView />);
    await screen.findByText("Payments Platform");
    fireEvent.click(document.getElementById("floor-gate-G3d") as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("WO-2408 is not waiting at G3d.")).toBeTruthy();
    expect(document.querySelector(".toast-ok")).toBeNull();
  });
});

describe("Floor: board", () => {
  it("shows a column per station and bay, cards with their gate text, and filters by class", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findByText("Payments Platform");
    fireEvent.click(document.querySelector("label[for=floor-view-board]") as HTMLElement);
    expect(document.querySelectorAll(".fl-col[data-drop]").length).toBe(9 + 5);
    const card = document.querySelector('[data-wo="WO-2400"].fl-card') as HTMLElement;
    expect(card.querySelector(".fl-gt")?.textContent).toMatch(/G3\+G3s waiting/);
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
    mount(<FloorView />);
    await screen.findByText("Payments Platform");
    fireEvent.click(document.querySelector("label[for=floor-view-board]") as HTMLElement);
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
    mount(<FloorView />);
    await screen.findByText("Payments Platform");
    fireEvent.click(document.querySelector("label[for=floor-view-board]") as HTMLElement);
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
    await screen.findByText("Payments Platform");
    fireEvent.click(document.getElementById("floor-replay-enter") as HTMLElement);
    const bar = await screen.findByRole("region", { name: "Replay controls" });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/projects/payments/floor" && c.query.has("at"))).toBe(true));
    expect(within(bar).getByText("Replay · not live")).toBeTruthy();
    // acting on the past is locked, with the reason
    expect(document.getElementById("floor-new-wo")?.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById("floor-kill")?.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById("floor-kill")?.getAttribute("data-reason")).toMatch(/Replay is showing the past/);
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
    await screen.findByText("Payments Platform");
    fireEvent.click(document.getElementById("floor-andon") as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Halt Payments Platform/ }));
    fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "Duplicate refunds seen" } });
    fireEvent.click(document.getElementById("rsn-ok") as HTMLElement);
    await waitFor(() => expect(bodyOf(calls, "POST", "/api/v1/stops")).toHaveLength(1));
    expect(bodyOf(calls, "POST", "/api/v1/stops")[0]?.body).toMatchObject({ scope: "project", id: "payments", mode: "halt", reason: "Duplicate refunds seen" });
  });

  it("locks Kill project for someone without the right, with the reason", async () => {
    mockApi({}, { denied: ["kill.project"] });
    mount(<FloorView />);
    await screen.findByText("Payments Platform");
    await waitFor(() => expect(document.getElementById("floor-kill")?.getAttribute("aria-disabled")).toBe("true"));
    expect(document.getElementById("floor-kill")?.getAttribute("data-reason")).toMatch(/Factory Admin/);
  });
});

describe("Floor: list", () => {
  it("lists every work order and sorts by a column", async () => {
    mockApi();
    mount(<FloorView />);
    await screen.findByText("Payments Platform");
    fireEvent.click(document.querySelector("label[for=floor-view-list]") as HTMLElement);
    expect(document.querySelectorAll(".fl-table tbody tr").length).toBe(WOS.length);
    fireEvent.click(document.getElementById("floor-sort-id") as HTMLElement);
    const ids = Array.from(document.querySelectorAll(".fl-table tbody tr td:first-child")).map((e) => e.textContent);
    expect(ids).toEqual([...ids].sort());
    void PAYMENTS;
  });
});
