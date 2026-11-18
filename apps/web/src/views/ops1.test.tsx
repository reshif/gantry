import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
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
  it("has no header actions; the chat features sit in a quiet row under the cards, and the subtitle is the prototype's", async () => {
    updatePrefs({ project: null });
    mockApi({ "GET /api/v1/agents": () => ({ body: [{ id: "ag-a", name: "Alpha", station: "spec", model: "m", autonomy: "gate", spark: [1, 2, 3], evalScore: 0.9 }] }) });
    mount(<WorkspaceView />);
    expect(await screen.findByText("Who is doing what right now, across the line.")).toBeTruthy();
    expect(document.querySelector(".ph .acts, .ph .vhead-acts")?.querySelectorAll("button").length ?? 0).toBe(0);
    const tools = document.querySelector(".ws-tools") as HTMLElement;
    expect(within(tools).getByRole("button", { name: /Conversations/ })).toBeTruthy();
    expect(within(tools).getByRole("button", { name: "New chat" })).toBeTruthy();
    // the agent card sparkline is the plain polyline (no area fill)
    expect(document.querySelector(".card .spark-area")).toBeNull();
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
