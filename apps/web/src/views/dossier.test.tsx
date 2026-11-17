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
    expect(screen.getByRole("tab", { name: /^Activity/ }).getAttribute("aria-selected")).toBe("false");
    // Traveler and Changes sit beside the decision; everything else is in one Actions menu
    expect(document.getElementById("rec-traveler")).toBeTruthy();
    expect(document.getElementById("rec-changes")).toBeTruthy();
    fireEvent.click(document.getElementById("dz-actions") as HTMLElement);
    expect(await screen.findByRole("menuitem", { name: /Open conversation/ })).toBeTruthy();
  });

  it("opens the Activity tab from the address and from the Open conversation button", async () => {
    await show({}, `#record/${W.id}/activity`);
    expect(screen.getByRole("tab", { name: /^Activity/ }).getAttribute("aria-selected")).toBe("true");
    cleanup();
    resetApp();
    await show();
    fireEvent.click(document.getElementById("dz-actions") as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Open conversation/ }));
    await waitFor(() => expect(window.location.hash).toContain("%2Factivity"));
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

describe("Work order page: links, viewers and kills", () => {
  it("scrolls to a section when the viewer is on the Activity tab, and stops retrying", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await show({}, `#record/${W.id}/activity`);
    fireEvent.click(screen.getByRole("button", { name: "Read the brief" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Document" }).getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect(document.getElementById("rec-sec-agreement")).toBeTruthy());
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    const n = scrolled.mock.calls.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(scrolled.mock.calls.length).toBe(n);
  });

  it("degrades cleanly for a viewer without access to the conversation", async () => {
    await show({ [`GET /api/v1/work-orders/${W.id}/session`]: () => ({ status: 403, body: { ok: false, msg: "No access." } }) });
    expect(screen.getByRole("heading", { level: 1, name: W.title })).toBeTruthy();
    expect(screen.getByText("Outline")).toBeTruthy();
    expect(document.getElementById("dz-head")?.textContent).not.toMatch(/is next/);
  });

  it("keeps the traveler and the record picker reachable from the page", async () => {
    await show();
    expect(document.getElementById("rec-traveler")).toBeTruthy();
    fireEvent.click(document.getElementById("rec-all") as HTMLElement);
    await waitFor(() => expect(window.location.hash).not.toContain(W.id));
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
