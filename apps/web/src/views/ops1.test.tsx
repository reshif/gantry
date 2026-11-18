import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InboxView from "./inbox";
import WorkspaceView from "./workspace";
import { Stat } from "../ui/primitives";
import { Spark } from "../ui/charts";
import { greetingAt, agoMs } from "./work/format";
import { updatePrefs } from "../lib/prefs";
import { mockApi, mount, resetApp } from "./floor/testkit";

beforeEach(() => { window.history.replaceState(null, "", "/"); window.location.hash = ""; resetApp(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const home = (sections: Record<string, unknown>) => ({ approvals: [], conversations: [], badges: {}, sections });
const GATE = (wo: string, waitMs: number, priority?: string) => ({ wo, title: `Title ${wo}`, gate: "G2", gateLabel: "G2", gateName: "Spec approved", project: "payments", projectName: "Payments Platform", waitMs, priority });

describe("Inbox (prototype tabs and rows)", () => {
  it("the tab lives in the URL (?tab=) and the old path names still open the right tab", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE("WO-1", 1000)], conversations: [{ wo: "WO-9", title: "Stuck one", project: "payments", question: "x", stuck: { state: "blocked", station: "spec", reason: "No agent", actions: [] } }] } }) }) });
    mount(<InboxView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Blocked/ }));
    await waitFor(() => expect(window.location.search).toBe("?tab=stuck"));
    expect(await screen.findByText("No agent")).toBeTruthy();
    // Open goes to the record page
    expect(screen.getByRole("button", { name: /^Record/ })).toBeTruthy();
  });

  it("approval rows: the work order is a link to its record, sorted oldest first, with Priority, Approve and Reject; the count reads '<n> approvals'", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE("WO-1", 1000, "P2"), GATE("WO-2", 9_000_000, "P1")], conversations: [] } }) }) });
    mount(<InboxView />);
    const link = await screen.findByText("WO-2");
    expect(link.getAttribute("href")).toContain("record/WO-2");
    const ids = Array.from(document.querySelectorAll("tbody a.pri")).map((a) => a.textContent);
    expect(ids).toEqual(["WO-2", "WO-1"]);
    expect(screen.getByText("Priority")).toBeTruthy();
    expect(screen.getByText("P1")).toBeTruthy();
    expect(screen.getByText("2 approvals")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Reject WO-/ })).toHaveLength(2);
    // the waiting column is sortable (aria-sort on the header)
    expect(document.querySelector('th[aria-sort]')?.textContent).toContain("Waiting");
    // Clear appears only with a filter set
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "WO-1" } });
    expect(await screen.findByRole("button", { name: "Clear" })).toBeTruthy();
    expect(screen.getByText("1 approvals of 2")).toBeTruthy();
  });

  it("Proposals has the two prototype panels: Trust promotions and Learning proposals, each with its empty state and its page link", async () => {
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [] } }) }),
      "GET /api/v1/trust/cells": () => ({ body: { cells: [], proposals: [{ id: "tp1", cell: "ag-build|feature|payments", from: 1, to: 2, status: "pending", evidence: { cleanRuns: 9, evalScore: 0.9, note: "9 clean runs" } }] } }),
      "GET /api/v1/learning/proposals": () => ({ body: [] }),
      "GET /api/v1/agents": () => ({ body: [{ id: "ag-build", name: "Builder", station: "build" }] }),
    });
    window.history.replaceState(null, "", "/?tab=proposals");
    mount(<InboxView />);
    expect(await screen.findByText("Trust promotions")).toBeTruthy();
    expect(screen.getByText("Learning proposals")).toBeTruthy();
    expect(await screen.findByText("L1 → L2 · feature · payments")).toBeTruthy();
    expect(screen.getByText("9 clean runs")).toBeTruthy();
    expect(await screen.findByText("Nothing to review")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Trust" }));
    expect(window.location.search).toBe("?tab=proposals");
    expect(window.location.hash).toBe("#trust");
  });

  it("has the prototype subtitle and an empty tab says what will appear", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [] } }) }) });
    mount(<InboxView />);
    expect(await screen.findByText("Everything that is waiting for a person, in one place.")).toBeTruthy();
    expect(await screen.findByText("Gate requests appear here as agents finish their work.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Proposals/ })).toBeTruthy();
  });
});

describe("Agents at work (prototype page)", () => {
  it("is tiles and agent cards only: no Operator button (Conversations is the inbox link), Agents active is info blue, Running runs is ok green", async () => {
    updatePrefs({ project: null });
    mockApi({ "GET /api/v1/agents": () => ({ body: [{ id: "ag-a", name: "Alpha", station: "spec", model: "m", autonomy: "gate", spark: [1, 2, 3], evalScore: 0.9 }] }) });
    mount(<WorkspaceView />);
    expect(await screen.findByText("Who is doing what right now, across the line.")).toBeTruthy();
    expect(document.querySelector(".ws-tools")).toBeNull();
    for (const name of ["Operator view"]) expect(screen.queryByRole("button", { name })).toBeNull();
    const tiles = Array.from(document.querySelectorAll("#ws-stats .stat"));
    expect(tiles[0]?.className).toContain("info");
    expect(tiles[1]?.className).toContain("ok");
    // the whole card is a link to the agent
    await waitFor(() => expect(document.getElementById("ws-agent-ag-a")).toBeTruthy());
    expect(document.getElementById("ws-agent-ag-a")?.getAttribute("href")).toBe("#agents/ag-a");
    // the agent card sparkline is the plain polyline (no area fill)
    expect(document.querySelector(".card .spark-area")).toBeNull();
  });
});

const many = (n: number) => Array.from({ length: n }, (_, i) => GATE(`WO-${100 + i}`, (i + 1) * 60_000, "P2"));

describe("Inbox (round 2)", () => {
  it("a prototype link #/inbox?tab=stuck opens the Blocked tab, and the other tab names work too", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [{ wo: "WO-9", title: "Stuck one", project: "payments", question: "x", stuck: { state: "blocked", station: "spec", reason: "No agent", actions: [] } }, { wo: "WO-8", title: "Asked", project: "payments", question: "Which?" }] } }) }) });
    window.location.hash = "#/inbox?tab=stuck";
    mount(<InboxView />);
    expect(await screen.findByText("No agent")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Blocked/ }).getAttribute("aria-selected")).toBe("true");
    cleanup();
    window.location.hash = "#/inbox?tab=questions";
    mount(<InboxView />);
    expect(await screen.findByText("Awaiting answer")).toBeTruthy();
  });

  it("Answer goes to the conversation page of that work order", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [{ wo: "WO-8", title: "Asked", project: "payments", question: "Which?" }] } }) }) });
    window.history.replaceState(null, "", "/?tab=questions");
    mount(<InboxView />);
    fireEvent.click(await screen.findByRole("button", { name: /^Answer/ }));
    expect(window.location.hash).toBe("#/p/payments/conversations/WO-8");
  });

  it("the table sorts oldest first by default (ascending triangle on Waiting, a faint hint on Work order), sorts by Work order, and keeps the sort in the URL", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: many(3), conversations: [] } }) }) });
    mount(<InboxView />);
    await screen.findByText("WO-100");
    const waiting = screen.getByRole("button", { name: /Waiting/ });
    expect(waiting.textContent).toContain("▲");
    expect(waiting.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    const wo = screen.getByRole("button", { name: /Work order/ });
    expect(wo.querySelector(".sorthint")?.textContent).toContain("↕");
    expect(Array.from(document.querySelectorAll("tbody a.pri")).map((a) => a.textContent)).toEqual(["WO-102", "WO-101", "WO-100"]);
    expect(screen.queryByText("Sort by")).toBeNull();
    fireEvent.click(wo);
    await waitFor(() => expect(Array.from(document.querySelectorAll("tbody a.pri")).map((a) => a.textContent)).toEqual(["WO-100", "WO-101", "WO-102"]));
    expect(window.location.search).toBe("?sort=id%3Aasc");
  });

  it("pages twelve rows at a time with the prototype footer", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: many(17), conversations: [] } }) }) });
    mount(<InboxView />);
    await screen.findByText("1–12 of 17");
    expect(screen.getByText("Page 1 / 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Prev" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("13–17 of 17")).toBeTruthy();
    expect(screen.getByText("Page 2 / 2")).toBeTruthy();
  });
});

describe("Gate dialogs (prototype)", () => {
  const traveler = { id: "WO-100", version: 3, allowed: { approve: { allowed: true, reason: "", needs: "", gate: "G2", instance: "WO-100:G2:1" }, can: {} } };
  it("Reject: danger intro, hint, inline 'Reason is required.', and the 'Reject and park' button", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: many(1), conversations: [] } }) }), "GET /api/v1/work-orders/WO-100": () => ({ body: traveler }) });
    mount(<InboxView />);
    const rej = await screen.findByRole("button", { name: /^Reject WO-100/ });
    await waitFor(() => expect(rej.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(rej);
    expect(await screen.findByText("Reject G2 for WO-100")).toBeTruthy();
    expect(screen.getByText(/parked in "Needs a person" until someone picks it up/)).toBeTruthy();
    expect(screen.getByText("Say what must change.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reject and park" }));
    expect(await screen.findByText("Reason is required.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject and park" }));
    expect(await screen.findByText("Reason needs at least 8 characters.")).toBeTruthy();
  });

  it("Approve: the optional Note field, no eyebrow", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: many(1), conversations: [] } }) }), "GET /api/v1/work-orders/WO-100": () => ({ body: traveler }) });
    mount(<InboxView />);
    const ok = await screen.findByRole("button", { name: /^Approve WO-100/ });
    await waitFor(() => expect(ok.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(ok);
    expect(await screen.findByText(/^Approve .*G2 for WO-100$/)).toBeTruthy();
    expect(screen.getByLabelText("Note (optional)")).toBeTruthy();
    expect(document.querySelector(".dlg .kicker, .modal-kicker")).toBeNull();
  });
});

describe("shared pieces", () => {
  it("Stat with href is a link; Spark with area=false has no fill", () => {
    mount(<Stat label="Waiting" value="3" sub="gates to approve" href="#inbox" id="s1" />);
    expect(document.getElementById("s1")?.tagName).toBe("A");
    expect(document.getElementById("s1")?.getAttribute("href")).toBe("#inbox");
    cleanup();
    mount(<Spark values={[1, 2, 3]} area={false} />);
    expect(document.querySelector(".spark-area")).toBeNull();
    cleanup();
    mount(<Spark values={[1, 2, 3]} />);
    expect(document.querySelector(".spark-area")).not.toBeNull();
  });

  it("greets by the time of day and writes ages as the prototype does", () => {
    expect(greetingAt(9)).toBe("Good morning");
    expect(greetingAt(13)).toBe("Good afternoon");
    expect(greetingAt(20)).toBe("Good evening");
    expect(agoMs(13 * 3_600_000 + 1000)).toBe("13h ago");
    expect(agoMs(5 * 60_000)).toBe("5m ago");
  });
});
