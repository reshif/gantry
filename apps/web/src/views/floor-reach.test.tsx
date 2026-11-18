/** Features that were reachable only by typing a URL, reached here the way a person does: by clicking from the screen they are on. */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkOrder } from "@gantry/domain";
import { updatePrefs } from "../lib/prefs";
import { useOpenTraveler } from "../shell/useTraveler";
import FloorView from "./floor";
import WorkOrdersView from "./work-orders";
import { WOS, floorRead, mockApi, mount, resetApp } from "./floor/testkit";
import { posts, readsFor, travelerOf } from "./traveler/testkit";

beforeEach(() => {
  resetApp();
  updatePrefs({ scopeAll: false, project: "payments", floorView: "belt", replay: null, activeClass: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STUCK = { ...(WOS.find((w) => w.state === "failed" || w.state === "waiting") ?? WOS[0]), id: "WO-9001", title: "Rotate the ledger keys", state: "blocked", bay: "person", bayFrom: "build", bayCause: "failed", bayReason: "Build failed three times", bayAt: Date.now() - 3_600_000 } as WorkOrder;

describe("Floor: Off the line", () => {
  it("shows the Needs a person bay with its reason, and Retry from there sends the retry", async () => {
    const calls = mockApi({
      "GET /api/v1/projects/payments/floor": () => ({ body: floorRead({ workOrders: [...WOS, STUCK] }) }),
      ...readsFor(STUCK, travelerOf(STUCK, {}, { approve: null })),
      "POST /api/v1/work-orders/WO-9001/retry": () => ({ body: { ok: true, msg: "Running again." } }),
    });
    mount(<FloorView />);
    const card = await screen.findByText("Off the line");
    expect(card).toBeTruthy();
    expect(await screen.findByText(/Build failed three times/)).toBeTruthy();
    expect(screen.getByText(/Needs a person · Rotate the ledger keys/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Assign" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /^Retry/ }));
    await waitFor(() => expect(posts(calls, "/api/v1/work-orders/WO-9001/retry")).toHaveLength(1));
  });

  it("says plainly when nothing waits in a bay", async () => {
    mockApi({ "GET /api/v1/projects/payments/floor": () => ({ body: floorRead({ workOrders: WOS.filter((w) => !w.bay) }) }) });
    mount(<FloorView />);
    expect(await screen.findByText("Nothing off the line")).toBeTruthy();
  });
});

describe("Work orders: Table / Board switch", () => {
  it("opens the board by clicking Board, and goes back with Table", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: { items: WOS.slice(0, 3), next: null, total: 3 } }) });
    mount(<WorkOrdersView />);
    await screen.findByText("WO-2398");
    expect(document.querySelectorAll(".fl-col[data-drop]").length).toBe(0);
    fireEvent.click(screen.getByRole("radio", { name: /Board/ }));
    await waitFor(() => expect(document.querySelectorAll(".fl-col[data-drop]").length).toBeGreaterThan(0));
    expect(new URLSearchParams(window.location.search).get("mode")).toBe("board");
    fireEvent.click(screen.getByRole("radio", { name: /Table/ }));
    await waitFor(() => expect(document.querySelectorAll(".fl-col[data-drop]").length).toBe(0));
  });
});

describe("Traveler: Run tab", () => {
  function Opener() {
    const open = useOpenTraveler();
    return <button type="button" onClick={() => open(STUCK.id, "run")}>open</button>;
  }
  const show = async (timeline: unknown) => {
    mockApi({ ...readsFor(STUCK, travelerOf(STUCK, {}, { approve: null })), "GET /api/v1/work-orders/WO-9001/timeline": () => ({ body: timeline }) });
    mount(<Opener />);
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText("open"));
  };
  it("renders an honest state, not the error boundary, when the timeline has no runs list", async () => {
    await show({});
    expect(await screen.findByText("The run timeline could not be shown", {}, { timeout: 4000 })).toBeTruthy();
  });
  it("renders a run whose entries are missing", async () => {
    await show({ runs: [{ runId: "r1", station: "build", state: "failed", calls: 1, tokens: 10, costUsd: 0.1 }] });
    expect(await screen.findByText("Build", {}, { timeout: 4000 })).toBeTruthy();
  });
  it("shows the empty state for an empty list", async () => {
    await show({ runs: [] });
    expect(await screen.findByText("No runs yet", {}, { timeout: 4000 })).toBeTruthy();
  });
});
