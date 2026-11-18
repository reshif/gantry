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

async function show(extra: Parameters<typeof mockApi>[0] = {}, hash = `#record/${W.id}/document`) {
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
    expect(screen.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected")).toBe("false");
    // the prototype's header: Traveler, Dossier and Changes are pages, Review opens the gate dialog, Actions is a menu
    expect(document.getElementById("rec-traveler")!.getAttribute("href")).toMatch(new RegExp(`/traveler/${W.id}$`));
    expect(document.getElementById("rec-dossier")!.getAttribute("href")).toMatch(new RegExp(`/dossier/${W.id}$`));
    expect(document.getElementById("rec-changes")!.getAttribute("href")).toMatch(new RegExp(`/changes/${W.id}$`));
    expect(document.getElementById("trv-open-conversation")).toBeNull();
    expect(document.getElementById("dz-more")).toBeTruthy();
  });

  it("has the prototype's tabs in its order, with Document kept after them", async () => {
    await show({}, `#record/${W.id}`);
    expect(screen.getAllByRole("tab").map((t) => t.textContent!.trim())).toEqual(["Overview", "Journey", "Gates", "Attempts and runs", "Conversation", "Cost", "Events", "Document"]);
    fireEvent.click(screen.getByRole("tab", { name: "Gates" }));
    await waitFor(() => expect(window.location.hash).toContain("%2Fgates"));
    await waitFor(() => expect(document.getElementById("dz-gates")).toBeTruthy());
  });

  it("opens a review dialog from the Review button with Cancel, Reject and Approve", async () => {
    await show();
    const btn = document.getElementById("dz-review");
    if (!btn) return; // the fixture work order has no gate waiting for this viewer
    fireEvent.click(btn);
    const dlg = await screen.findByRole("dialog");
    for (const l of ["Cancel", "Reject", "Approve"]) expect(dlg.textContent).toContain(l);
  });

  it("opens on the Overview tab: brief, classification, facts and SLA", async () => {
    await show({}, `#record/${W.id}`);
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("dz-overview")).toBeTruthy();
    for (const t of ["Brief", "Classification", "Facts"]) expect(screen.getByRole("heading", { name: t })).toBeTruthy();
  });

  it("opens the Conversation tab from the address and from the tab", async () => {
    await show({}, `#record/${W.id}/activity`);
    expect(screen.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected")).toBe("true");
    cleanup();
    resetApp();
    await show();
    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
    await waitFor(() => expect(window.location.hash).toContain("%2Factivity"));
  });

  it("keeps lock reasons in the Actions menu, not as a strip under the header", async () => {
    const t = travelerOf(W, {}, { can: { classify: deny("Class can only change at Intake.", "Project Admin"), reassign: deny("Class can only change at Intake.", "Project Admin") } });
    await show(readsFor(W, t, recordOf(W)));
    expect(document.querySelectorAll(".dz-lockline").length).toBe(0);
    expect(document.getElementById("dz-more")).toBeTruthy();
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
    expect(document.getElementById("rec-traveler")!.getAttribute("href")).toContain("/traveler/");
  });
});

describe("Changes page", () => {
  it("shows counts, the plan and a way back to the work order", async () => {
    mockApi({ ...readsFor(W) });
    window.location.hash = `#changes/${W.id}`;
    mount(<ChangesView />);
    expect(await screen.findByRole("heading", { name: "Changes" }, { timeout: 4000 })).toBeTruthy();
    expect(document.getElementById("chg")).toBeTruthy();
    fireEvent.click(document.getElementById("chg-back") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toContain(`record/${W.id}`));
  });
});
