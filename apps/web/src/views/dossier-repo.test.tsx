import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DossierView from "./dossier";
import TravelerPage from "./traveler/Page";
import { REPOS, mockApi, mount, resetApp } from "./floor/testkit";
import { readsFor, waitingWo } from "./traveler/testkit";

beforeEach(() => resetApp());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Repo dossier (prototype Dossier screen)", () => {
  it("lists the repos with language, tags, open work orders and status, and links each to its page", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: { items: [], next: null, total: 0 } }) });
    window.location.hash = "#/p/payments/dossier";
    mount(<DossierView />);
    expect(await screen.findByRole("heading", { name: "Dossier" }, { timeout: 4000 })).toBeTruthy();
    for (const c of ["Repo", "Lang", "Tags", "Open WOs", "Status"]) expect((await screen.findAllByText(c)).length).toBeGreaterThan(0);
    expect(document.getElementById("dos-q")).toBeTruthy();
    expect(document.getElementById("dos-f-lang")).toBeTruthy();
    const link = await screen.findByRole("link", { name: REPOS[0]!.name });
    fireEvent.click(link);
    await waitFor(() => expect(window.location.hash).toContain(`dossier/${REPOS[0]!.id}`));
  });

  it("shows one repo's configuration, guidelines and work orders", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: { items: [], next: null, total: 0 } }) });
    window.location.hash = `#/p/payments/dossier/${REPOS[0]!.id}`;
    mount(<DossierView />);
    expect(await screen.findByRole("heading", { level: 1, name: REPOS[0]!.name }, { timeout: 4000 })).toBeTruthy();
    for (const t of ["Configuration", "AGENTS.md guidelines", "Work orders", "Default branch", "Protected paths"]) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
  });

  it("says the repo does not exist, with a way back to the work orders", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: { items: [], next: null, total: 0 } }) });
    window.location.hash = "#/p/payments/dossier/nope";
    mount(<DossierView />);
    expect(await screen.findByText("That repo does not exist.", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Work orders" })).toBeTruthy();
  });
});

describe("Traveler page", () => {
  it("has the crumb, the Route diagram in a scroll region and the Station by station table", async () => {
    mockApi({ ...readsFor(waitingWo) });
    window.location.hash = `#/p/payments/traveler/${waitingWo.id}`;
    mount(<TravelerPage />);
    expect(await screen.findByRole("heading", { level: 1, name: `Traveler · ${waitingWo.id}` }, { timeout: 4000 })).toBeTruthy();
    expect(document.querySelector(".kicker")?.textContent).not.toMatch(/TRV-12/);
    expect(document.querySelector(".scrollwrap .sh")?.textContent).toMatch(/scroll/);
    expect(screen.getByText("Station by station")).toBeTruthy();
    expect(screen.queryByText(/Sat |Sun |Mon |IST/)).toBeNull();
  });

  it("shows Nothing to show for a work order that does not exist", async () => {
    mockApi({ "GET /api/v1/work-orders/WO-ZZZ": () => ({ status: 404, body: { ok: false, msg: "No such work order." } }), "GET /api/v1/work-orders/WO-ZZZ/record": () => ({ status: 404, body: { ok: false, msg: "No such work order." } }) });
    window.location.hash = "#/p/payments/traveler/WO-ZZZ";
    mount(<TravelerPage />);
    expect(await screen.findByText("Nothing to show", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText("That work order does not exist.")).toBeTruthy();
    expect(screen.queryByText("Work order records")).toBeNull();
  });
});
