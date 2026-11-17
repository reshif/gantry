import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecordView from "./record";
import ChangesView from "./changes";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { deny, readsFor, recordOf, travelerOf, waitingWo } from "./traveler/testkit";

beforeEach(() => resetApp());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const W = waitingWo;

async function show(extra: Parameters<typeof mockApi>[0] = {}, hash = `#record/${W.id}`) {
  const calls = mockApi({ ...readsFor(W), ...extra });
  window.location.hash = hash;
  mount(<RecordView />);
  await screen.findByRole("toolbar", { name: "Work order actions" }, { timeout: 4000 });
  return calls;
}

describe("Work order page", () => {
  it("puts the title, route and actions in the header and the document and activity in tabs", async () => {
    await show();
    expect(screen.getByRole("heading", { level: 1, name: W.title })).toBeTruthy();
    expect(screen.getByRole("list", { name: new RegExp(`Route of ${W.id}`) })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Document" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected")).toBe("false");
    expect(document.getElementById("trv-open-conversation")).toBeTruthy();
    expect(document.getElementById("dz-move")).toBeTruthy();
    expect(document.getElementById("dz-more")).toBeTruthy();
  });

  it("opens the Activity tab from the address and from the Open conversation button", async () => {
    await show({}, `#record/${W.id}/activity`);
    expect(screen.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected")).toBe("true");
    cleanup();
    resetApp();
    await show();
    fireEvent.click(document.getElementById("trv-open-conversation") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toContain("/activity"));
  });

  it("says why an action is locked, once per reason, beside the buttons", async () => {
    const t = travelerOf(W, {}, { can: { classify: deny("Class can only change at Intake.", "Project Admin"), reassign: deny("Class can only change at Intake.", "Project Admin") } });
    await show(readsFor(W, t, recordOf(W)));
    const lines = document.querySelectorAll(".dz-lockline");
    expect(lines.length).toBeGreaterThan(0);
    expect(document.querySelector(".dz-lockline")?.textContent).toMatch(/locked\./);
  });

  it("lists what waits on the viewer in the side column", async () => {
    await show();
    expect(screen.getByText("Waiting on you")).toBeTruthy();
    expect(screen.getByText("Outline")).toBeTruthy();
    expect(document.getElementById("rec-copy")).toBeTruthy();
  });
});

describe("Changes page", () => {
  it("shows counts, the plan and a way back to the work order", async () => {
    mockApi({ ...readsFor(W) });
    window.location.hash = `#changes/${W.id}`;
    mount(<ChangesView />);
    expect(await screen.findByText(`Changes: ${W.title}`, {}, { timeout: 4000 })).toBeTruthy();
    fireEvent.click(document.getElementById("chg-back") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toContain(`record/${W.id}`));
  });
});
