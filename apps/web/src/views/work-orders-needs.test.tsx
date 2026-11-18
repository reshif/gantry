import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { updatePrefs } from "../lib/prefs";
import InboxView from "./inbox";
import WorkOrdersView from "./work-orders";
import { WoActions } from "./work/WoActions";
import { needsOf, waitingOf } from "./work/needs";
import { WOS, mockApi, mount, resetApp } from "./floor/testkit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  resetApp();
  updatePrefs({ project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const page = (items: unknown[]) => ({ items, next: null, total: items.length });
const base = WOS[0]!;
const mk = (id: string, over: Record<string, unknown> = {}) => ({ ...base, id, title: `Title of ${id}`, state: "waiting", bay: null, bayReason: null, ...over });
const wos = (items: unknown[], home: unknown = { approvals: [], conversations: [], badges: {} }) =>
  mockApi({
    "GET /api/v1/projects/payments/work-orders": (c) => ({ body: c.query.get("limit") === "1" ? page([]) : page(items) }),
    "GET /api/v1/home": () => ({ body: home }),
  });
const home = (waiting: Record<string, unknown>) => ({ approvals: [], conversations: [], badges: {}, sections: { waiting } });
const names = (n: string) => (n ? n : "agent");

describe("needsOf: what a work order waits on, from the API's own data", () => {
  const cat = DEFAULT_CATALOG;
  const w = (over: Record<string, unknown> = {}) => mk("WO-1", over) as never;
  const waiting = (conversations: unknown[] = [], approvals: unknown[] = []) => waitingOf(home({ conversations, approvals }) as never);

  it("an open station question asks the person and carries the question", () => {
    const n = needsOf(w(), cat, waiting([{ wo: "WO-1", title: "t", project: "payments", question: "Which currency?" }]), names);
    expect(n).toMatchObject({ kind: "question", mine: true, sub: "Which currency?" });
    expect(n.text).toMatch(/asks you$/);
  });
  it("a pending gate names the gate and the approvals so far", () => {
    const n = needsOf(w(), cat, waiting([], [{ wo: "WO-1", gate: "G5", gateLabel: "G5", project: "payments", projectName: "P", have: 0, need: 2 }]), names);
    expect(n).toMatchObject({ kind: "gate", text: "G5 approval (0 of 2)", mine: true });
  });
  it("a review verdict of changes requested says so", () => {
    expect(needsOf(w({ review: { verdict: "changes_requested" } }), cat, waiting(), names)).toMatchObject({ kind: "review", text: "Review requested changes" });
  });
  it("a bay shows the server's reason, a running order shows the agent and since when", () => {
    expect(needsOf(w({ bay: "person", bayReason: "Needs a human to pick a repo" }), cat, waiting(), names)).toMatchObject({ kind: "bay", text: "Needs a human to pick a repo" });
    const n = needsOf(w({ state: "running", history: [{ station: "build", agent: "ag-build", startedAt: 1000 }] }), cat, waiting(), (id) => `Name of ${id}`, 1000 + 3 * 3600_000);
    expect(n).toMatchObject({ kind: "running", text: "Name of ag-build", mine: false });
    expect(n.sub).toMatch(/^started /);
  });
});

describe("Work orders list: Project and Needs columns, row actions", () => {
  it("has no Project column while every row is in the one project, and has one when the rows span projects", async () => {
    wos([mk("WO-7001"), mk("WO-7002")]);
    mount(<WorkOrdersView />);
    await screen.findByText("WO-7001");
    const heads = () => Array.from(document.querySelectorAll("#wo-table thead th")).map((t) => t.textContent ?? "");
    expect(heads().some((h) => h.includes("Project"))).toBe(false);
    cleanup();
    wos([mk("WO-7001"), mk("WO-7002", { project: "other" })]);
    mount(<WorkOrdersView />);
    await screen.findByText("WO-7001");
    expect(heads().some((h) => h.includes("Project"))).toBe(true);
  });

  it("the Needs column says why, and rows that need the viewer sort first", async () => {
    wos(
      [mk("WO-7001"), mk("WO-7002", { bay: "person", bayReason: "Picks the repo" }), mk("WO-7003"), mk("WO-7004", { review: { verdict: "changes_requested" } })],
      home({ approvals: [{ wo: "WO-7003", gate: "G5", gateLabel: "G5", project: "payments", projectName: "P", have: 0, need: 2 }], conversations: [{ wo: "WO-7001", title: "t", project: "payments", question: "Which one?" }] }),
    );
    mount(<WorkOrdersView />);
    await screen.findByText("WO-7001");
    await waitFor(() => expect(document.querySelectorAll("#wo-table [data-need]").length).toBeGreaterThan(3));
    const needOf = (id: string) => document.getElementById(`wo-id-${id}`)?.closest("tr")?.querySelector("[data-need]");
    expect(needOf("WO-7001")?.getAttribute("data-need")).toBe("question");
    expect(needOf("WO-7001")?.textContent).toContain("Which one?");
    expect(needOf("WO-7003")?.textContent).toContain("G5 approval (0 of 2)");
    expect(needOf("WO-7004")?.textContent).toContain("Review requested changes");
    expect(needOf("WO-7002")?.textContent).toContain("Picks the repo");
    const order = Array.from(document.querySelectorAll("#wo-table tbody a.pri")).map((a) => a.textContent);
    expect(order.slice(0, 3).sort()).toEqual(["WO-7001", "WO-7002", "WO-7003"]);
    expect(window.location.hash).not.toContain("sort=");
  });

  it("Conversation and Record on every row navigate; Answer shows for an open question", async () => {
    wos([mk("WO-7001"), mk("WO-7002")], home({ approvals: [], conversations: [{ wo: "WO-7001", title: "t", project: "payments", question: "Which one?" }] }));
    mount(<WorkOrdersView />);
    await screen.findByText("WO-7001");
    for (const id of ["WO-7001", "WO-7002"]) expect(document.getElementById(`wo-rec-${id}`)).toBeTruthy();
    expect(document.getElementById("wo-conv-WO-7002")).toBeTruthy();
    expect(await waitFor(() => { const e = document.getElementById("wo-primary-WO-7001"); if (!e) throw new Error("no answer"); return e; })).toBeTruthy();
    expect(document.getElementById("wo-primary-WO-7002")).toBeNull();
    // Answer opens the conversation, so the row with Answer has no second Conversation button
    expect(document.getElementById("wo-conv-WO-7001")).toBeNull();
    fireEvent.click(document.getElementById("wo-conv-WO-7002") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe("#/p/payments/conversations/WO-7002"));
    fireEvent.click(document.getElementById("wo-rec-WO-7002") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe("#/p/payments/record/WO-7002"));
  });

  it("the table is a card list on a phone and has no fixed pixel width that overflows a laptop", () => {
    const css = readFileSync(resolve(__dirname, "../styles/views/workorders.css"), "utf8") + readFileSync(resolve(__dirname, "../styles/views/workorders.shared.css"), "utf8");
    expect(css).toMatch(/\.wo-table td \{ white-space: normal/);
    const dt = readFileSync(resolve(__dirname, "../ui/DataTable.tsx"), "utf8");
    expect(dt).toMatch(/card layout under 640px/);
    expect(css).not.toMatch(/\.wo-table td \{ white-space: nowrap/);
  });
});

describe("The same work order actions in every place", () => {
  it("Inbox rows: a question offers Answer and Record (Answer opens the conversation); no duplicate Conversation", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ conversations: [{ wo: "WO-8", title: "Asked", project: "payments", question: "Which?" }], approvals: [] }) }) });
    window.history.replaceState(null, "", "/?tab=questions");
    mount(<InboxView />);
    await screen.findByText("Awaiting answer");
    const labels = within(screen.getByText("WO-8").closest("li") as HTMLElement).getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["Answer", "Record"]);
    fireEvent.click(screen.getByRole("button", { name: "Answer for WO-8" }));
    await waitFor(() => expect(window.location.hash).toBe("#/p/payments/conversations/WO-8"));
  });

  it("Home Needs you: a gate row has Conversation and Record, and Conversation navigates", async () => {
    const { default: HomeView } = await import("./home");
    mockApi({ "GET /api/v1/home": () => ({ body: home({ approvals: [{ wo: "WO-9", title: "Gate me", gate: "G2", gateLabel: "G2", gateName: "Spec", instance: "WO-9:G2:1", project: "payments", projectName: "Payments", have: 0, need: 1, waitMs: 1000 }], conversations: [] }) }) });
    mount(<HomeView />);
    await screen.findByText("Gate me");
    expect(document.getElementById("hm-my-rec-WO-9")).toBeTruthy();
    fireEvent.click(document.getElementById("hm-my-conv-WO-9") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe("#/p/payments/conversations/WO-9"));
  });

  it("renders the same labels in the same order wherever it is used, and omit drops the one for the page you are on", async () => {
    mockApi();
    const { container } = mount(<><WoActions wo="WO-1" project="payments" /><WoActions wo="WO-1" project="payments" omit={["record"]} idPrefix="x" /></>);
    const groups = container.querySelectorAll(".wo-acts");
    expect(Array.from(groups[0]!.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Conversation", "Record"]);
    expect(Array.from(groups[1]!.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Conversation"]);
  });

  it("an open question shows Answer and Record, not a second Conversation button that does the same thing", async () => {
    mockApi();
    const { container } = mount(<WoActions wo="WO-1" project="payments" needs={{ kind: "question", text: "", mine: true }} />);
    await waitFor(() => expect(Array.from(container.querySelectorAll(".wo-acts button")).map((b) => b.textContent)).toContain("Answer"));
    expect(Array.from(container.querySelectorAll(".wo-acts button")).map((b) => b.textContent)).toEqual(["Answer", "Record"]);
  });
});
