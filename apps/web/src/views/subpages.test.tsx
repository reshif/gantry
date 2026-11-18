import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecordView from "./record";
import ChangesView from "./changes";
import ProjectConfigView from "./project-config";
import { TABS } from "./project-config/ctx";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { readsFor, waitingWo } from "./traveler/testkit";

beforeEach(() => resetApp());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const W = waitingWo;

async function open(hash: string, view: React.ReactElement, extra: Parameters<typeof mockApi>[0] = {}) {
  mockApi({ ...readsFor(W), ...extra });
  window.location.hash = hash;
  mount(view);
}

describe("work order tabs", () => {
  it.each([
    ["journey", "dz-journey", "Journey"],
    ["gates", "dz-gates", "Gates"],
    ["attempts", "dz-attempts", "Attempts and runs"],
    ["events", "dz-events", "Events"],
  ])("the %s tab shows its prototype card", async (tab, id, title) => {
    await open(`#record/${W.id}/${tab}`, <RecordView />);
    await waitFor(() => expect(document.getElementById(id)).toBeTruthy(), { timeout: 4000 });
    expect(screen.getAllByRole("heading", { name: title }).length).toBeGreaterThan(0);
  });
});

describe("Changes page", () => {
  it("has a Review summary card and no stray plan button under the files", async () => {
    await open(`#changes/${W.id}`, <ChangesView />);
    expect(await screen.findByRole("heading", { name: "Review summary" }, { timeout: 4000 })).toBeTruthy();
    expect(document.querySelector("summary.btn")).toBeNull();
  });
});

describe("Project config tabs", () => {
  it("are the prototype's, in its order, then the tabs the product keeps", () => {
    expect(TABS.map((t) => t[1])).toEqual(["General", "Stations and gates", "Classes", "Approvers", "Members", "Freezes", "Notifications", "MCP", "Budget", "History", "Danger zone"]);
  });
  it("opens with the project switcher in the header and no Open floor button", async () => {
    await open("#/p/payments/project-config", <ProjectConfigView />);
    expect(await screen.findByRole("heading", { level: 1, name: /Payments/ }, { timeout: 4000 })).toBeTruthy();
    expect(document.getElementById("pcf-switch")).toBeTruthy();
    expect(document.getElementById("pcf-to-floor")).toBeNull();
    expect(screen.getByRole("tab", { name: "General" })).toBeTruthy();
  });
});
