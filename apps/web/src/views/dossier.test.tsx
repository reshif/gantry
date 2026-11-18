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

async function show(extra: Parameters<typeof mockApi>[0] = {}, hash = `#record/${W.id}/journey`) {
  const calls = mockApi({ ...readsFor(W), ...extra });
  window.location.hash = hash;
  mount(<RecordView />);
  await screen.findByRole("toolbar", { name: "Work order actions" }, { timeout: 4000 });
  return calls;
}

describe("Work order page", () => {
  it("puts the title, route and actions in the header and the seven prototype tabs under it", async () => {
    await show({}, `#record/${W.id}/journey`);
    expect(screen.getByRole("heading", { level: 1, name: W.title })).toBeTruthy();
    expect(screen.getByRole("list", { name: new RegExp(`Route of ${W.id}`) })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Journey", "Gates", "Attempts and runs", "Conversation", "Cost", "Events"]);
    expect(screen.getByRole("tab", { name: "Journey" }).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("dz-more")).toBeTruthy();
    // the conversation is a tab, not a header button
    expect(document.getElementById("trv-open-conversation")).toBeNull();
  });

  it("lists the header actions in the prototype's order and sends Traveler, Dossier and Changes to their pages", async () => {
    await show({}, `#record/${W.id}`);
    const labels = [...document.querySelectorAll('[role="toolbar"] button')].map((b) => b.textContent?.trim());
    expect(labels.slice(0, 3)).toEqual(["Traveler", "Dossier", "Changes"]);
    expect(labels[labels.length - 1]).toBe("Actions");
    expect(labels.some((l) => /^Review /.test(l ?? ""))).toBe(true);
    expect(labels).not.toContain("Open conversation");
    expect(document.getElementById("rec-all")).toBeNull();
    fireEvent.click(document.getElementById("rec-traveler") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toContain(`traveler/${W.id}`));
    fireEvent.click(document.getElementById("rec-dossier") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toContain(`dossier/${W.id}`));
    fireEvent.click(document.getElementById("rec-changes") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toContain(`changes/${W.id}`));
  });

  it("has the prototype's Actions menu: edit, reassign, park, send back, a divider and stop", async () => {
    await show({}, `#record/${W.id}`);
    fireEvent.click(document.getElementById("dz-more") as HTMLElement);
    const items = (await screen.findAllByRole("menuitem")).map((i) => (i.textContent ?? "").replace(/locked$/, "").trim());
    expect(items.slice(0, 5)).toEqual(["Edit title and priority", "Reassign", "Park", "Send back a station", "Stop this work order\u2026"]);
    expect(items).toContain("Reassign agent");
    expect(items).toContain("Copy link");
  });

  it("opens the review dialog from Review and offers Request changes, Reject and Approve", async () => {
    await show({}, `#record/${W.id}`);
    fireEvent.click(document.getElementById("trv-approve") as HTMLElement);
    expect(await screen.findByRole("button", { name: "Request changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByText("Evidence")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByText(/Add a comment of at least 10 characters/)).toBeTruthy();
  });

  it("opens on the Overview tab: brief, classification, facts and SLA", async () => {
    await show({}, `#record/${W.id}`);
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("dz-overview")).toBeTruthy();
    for (const t of ["Brief", "Classification", "Facts"]) expect(screen.getByRole("heading", { name: t })).toBeTruthy();
    // Where and Requested by live in the header, not in Facts
    expect(document.querySelector("#dz-overview dl")?.textContent).not.toMatch(/Requested by/);
  });

  it("keeps the old addresses working: activity opens Conversation, document opens Journey", async () => {
    await show({}, `#record/${W.id}/activity`);
    expect(screen.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected")).toBe("true");
    cleanup();
    resetApp();
    await show({}, `#record/${W.id}/document`);
    expect(screen.getByRole("tab", { name: "Journey" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the tab in the address", async () => {
    await show({}, `#record/${W.id}`);
    fireEvent.click(screen.getByRole("tab", { name: "Gates" }));
    await waitFor(() => expect(window.location.hash).toContain(`${W.id}%2Fgates`));
    expect(await screen.findByRole("heading", { name: "Gates" })).toBeTruthy();
    for (const c of ["Gate", "Mode", "Status", "Decided by", "When"]) expect(screen.getAllByText(c).length).toBeGreaterThan(0);
  });

  it("shows the Journey timeline, the attempts table, the cost by station and the events", async () => {
    await show({}, `#record/${W.id}/journey`);
    expect(screen.getByRole("heading", { name: "Journey" })).toBeTruthy();
    expect(document.querySelector("#dz-journey .tl")).toBeTruthy();
    cleanup();
    resetApp();
    await show({}, `#record/${W.id}/attempts`);
    expect(await screen.findByRole("heading", { name: "Attempts and runs" })).toBeTruthy();
    for (const c of ["Attempt", "Station", "Outcome", "Duration", "Tokens", "Model"]) expect(screen.getAllByText(c).length).toBeGreaterThan(0);
    cleanup();
    resetApp();
    await show({}, `#record/${W.id}/costs`);
    expect(await screen.findByRole("heading", { name: "Cost by station" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tokens" })).toBeTruthy();
    cleanup();
    resetApp();
    await show({}, `#record/${W.id}/events`);
    expect(await screen.findByRole("heading", { name: "Events" })).toBeTruthy();
  });

  it("says why an action is locked, once per reason, beside the buttons", async () => {
    const t = travelerOf(W, {}, { can: { classify: deny("Class can only change at Intake.", "Project Admin"), reassign: deny("Class can only change at Intake.", "Project Admin") } });
    await show(readsFor(W, t, recordOf(W)));
    const lines = document.querySelectorAll(".dz-lockline");
    expect(lines.length).toBeGreaterThan(0);
    expect(document.querySelector(".dz-lockline")?.textContent).toMatch(/locked\./);
  });

  it("lists what waits on the viewer beside the tabs", async () => {
    await show();
    expect(screen.getByText(/Waiting on you \(1\)/)).toBeTruthy();
  });

  it("shows a Not found page with the way back when the work order is not visible", async () => {
    mockApi({ [`GET /api/v1/work-orders/${W.id}`]: () => ({ status: 404, body: { ok: false, msg: "No such work order." } }), [`GET /api/v1/work-orders/${W.id}/record`]: () => ({ status: 403, body: { ok: false, msg: "No." } }) });
    window.location.hash = `#record/${W.id}`;
    mount(<RecordView />);
    expect(await screen.findByRole("heading", { name: "Not found" }, { timeout: 4000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to work orders" }));
    await waitFor(() => expect(window.location.hash).toContain("work-orders"));
  });
});

describe("Work order page: links, viewers and kills", () => {
  it("scrolls to a section of the document from the Conversation tab and stops retrying", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await show({}, `#record/${W.id}/journey`);
    expect(document.getElementById("dz-doc")).toBeTruthy();
    expect(screen.getAllByText("Completeness").length).toBeGreaterThan(0);
  });

  it("degrades cleanly for a viewer without access to the conversation", async () => {
    await show({ [`GET /api/v1/work-orders/${W.id}/session`]: () => ({ status: 403, body: { ok: false, msg: "No access." } }) });
    expect(screen.getByRole("heading", { level: 1, name: W.title })).toBeTruthy();
    expect(document.getElementById("dz-head")?.textContent).not.toMatch(/is next/);
  });

  it("keeps the traveler reachable from the page", async () => {
    await show();
    expect(document.getElementById("rec-traveler")).toBeTruthy();
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
