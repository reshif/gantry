import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CATALOG, type WorkOrder } from "@gantry/domain";
import { updatePrefs } from "../../lib/prefs";
import { clearDecided } from "../../lib/decided";
import WorkOrdersView from "../work-orders";
import InboxView from "../inbox";
import HomeView from "../home";
import { WoActions } from "./WoActions";
import { needsOf } from "./needs";
import { WOS, mockApi, mount, resetApp } from "../floor/testkit";

const cat = DEFAULT_CATALOG;
const NOW = Date.now();
const base = WOS.find((w) => w.id === "WO-2398") as WorkOrder;
const mk = (over: Record<string, unknown>): WorkOrder => ({ ...base, bay: null, bayReason: "", state: "waiting", gates: {}, sendbacks: [], history: [], conv: { ...base.conv, raised: [] }, ...over }) as WorkOrder;
const ctx = { cat, now: NOW };

beforeEach(() => {
  resetApp();
  clearDecided();
  window.history.replaceState(null, "", "/");
  window.location.hash = "";
  updatePrefs({ scopeAll: false, project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("what a work order needs (from the data the API returns)", () => {
  it("names the open station question", () => {
    const n = needsOf(mk({ conv: { ...base.conv, raised: [{ station: "build", text: "Which table?", at: NOW, answered: false }] } }), ctx);
    expect(n).toMatchObject({ kind: "question", text: "Build asks you", detail: "Which table?", me: true });
  });
  it("names the waiting gate with the vote count the approvals list gave", () => {
    const w = mk({ gates: { G5: { status: "waiting", approvals: [], rejections: [], checks: [], waitingSince: NOW - 3_600_000 } } });
    const name = cat.gates.find((g) => g.id === "G5")?.name ?? "G5";
    expect(needsOf(w, { ...ctx, votes: () => ({ have: 0, need: 2 }) })).toMatchObject({ kind: "gate", text: `${name} (0 of 2)`, me: true });
    // without the open approvals list the project's own rule gives the count; with neither there is no count
    expect(needsOf(w, { ...ctx, required: () => 2 }).text).toBe(`${name} (0 of 2)`);
    expect(needsOf(w, ctx).text).toBe(name);
  });
  it("says a station sent it back for changes, using the station's own name", () => {
    const w = mk({ sendbacks: [{ from: "review", to: "build", note: "Two criteria fail", at: NOW, by: "a" }] });
    expect(needsOf(w, ctx)).toMatchObject({ kind: "review", text: "Review requested changes", detail: "Two criteria fail", me: false });
  });
  it("does not repeat the state chip in the detail line", () => {
    expect(needsOf(mk({ state: "blocked", bay: null, blockReason: "Waiting on an upstream schema change" }), ctx)).toMatchObject({ text: "Waiting on an upstream schema change", detail: "" });
    expect(needsOf(mk({ state: "failed", bay: null, failReason: "2 checks failed" }), ctx).detail).toBe("");
  });
  it("shows the bay reason, and the agent and start for a running one", () => {
    expect(needsOf(mk({ bay: "person", bayReason: "needs the table name", state: "parked" }), ctx)).toMatchObject({ kind: "bay", text: "needs the table name", me: true, rank: 2 });
    const run = mk({ state: "running", history: [{ station: "build", agent: "ag-build", model: "m", startedAt: NOW - 600_000, endedAt: null, tokens: 0, cost: 0, outcome: null, note: "" }] });
    expect(needsOf(run, { ...ctx, agent: () => "Builder" })).toMatchObject({ kind: "running", detail: "since 10m ago", me: false });
  });
});

const page = (items: unknown[]) => ({ items, next: null, total: items.length });

describe("Work orders list: Needs, actions, project column", () => {
  const rows = () => [
    mk({ id: "WO-9001", title: "A long title that should wrap onto two lines rather than being cut off after fifty characters of text", conv: { ...base.conv, raised: [{ station: "build", text: "Which table?", at: NOW, answered: false }] } }),
    mk({ id: "WO-9002", gates: { G2: { status: "waiting", approvals: [], rejections: [], checks: [] } } }),
    mk({ id: "WO-9003", sendbacks: [{ from: "review", to: "build", note: "", at: NOW, by: "a" }] }),
    mk({ id: "WO-9004", bay: "person", bayReason: "needs the table name", state: "parked" }),
  ];
  it("has no Project column when scoped to one project, and every row says why it waits", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page(rows()) }) });
    mount(<WorkOrdersView />);
    await screen.findByText("WO-9001");
    const heads = Array.from(document.querySelectorAll("#wo-table thead th")).map((t) => t.textContent?.replace(/[↑↓↕]/g, "").trim());
    expect(heads).not.toContain("Project");
    expect(document.getElementById("wo-needs-WO-9001")?.textContent).toContain("Build asks you");
    expect(document.getElementById("wo-needs-WO-9002")?.textContent).toMatch(/Spec approved \(0 of 1\)/);
    expect(document.getElementById("wo-needs-WO-9003")?.textContent).toContain("Review requested changes");
    expect(document.getElementById("wo-needs-WO-9004")?.textContent).toContain("needs the table name");
    // the full title is in the DOM (wrapped by CSS, not cut)
    expect(screen.getByText(/rather than being cut off after fifty characters/).textContent).toContain("fifty characters of text");
    // rows that need a person come first by default, and the sort is in the URL-driven state
    const ids = Array.from(document.querySelectorAll("#wo-table tbody tr")).map((r) => (r as HTMLElement).dataset.key);
    expect(ids.slice(0, 3).sort()).toEqual(["WO-9001", "WO-9002", "WO-9004"]);
    expect(ids[3]).toBe("WO-9003");
  });

  it("Conversation opens the work order's conversation route from the list; Answer and Approve… sit behind the server's decision", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page(rows()) }) });
    mount(<WorkOrdersView />);
    await screen.findByText("WO-9001");
    expect(document.getElementById("wo-answer-WO-9001")).toBeTruthy();
    expect(document.getElementById("wo-approve-WO-9002")).toBeTruthy();
    expect(document.getElementById("wo-answer-WO-9003")).toBeNull();
    fireEvent.click(document.getElementById("wo-acts-WO-9004-conversation") as HTMLElement);
    expect(window.location.hash).toBe("#/p/payments/conversations/WO-9004");
    expect(document.getElementById("wo-acts-WO-9004-record")?.getAttribute("href")).toBe("#/p/payments/record/WO-9004");
  });

  it("locks Answer with the server's reason when this person may not", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page(rows()) }) }, { denied: ["wo.answer"] });
    mount(<WorkOrdersView />);
    await screen.findByText("WO-9001");
    await waitFor(() => expect(document.getElementById("wo-answer-WO-9001")?.getAttribute("aria-disabled")).toBe("true"));
  });

  it("is built to fit: titles wrap (no ellipsis), the table stacks into cards under 640px, and no column is forced wider than the page", () => {
    const css = ["views/workorders.css", "shared.css"].map((f) => readFileSync(`${process.cwd()}/src/styles/${f}`, "utf8")).join("\n");
    expect(css).toMatch(/\.wo-table \.wo-title-t \{[^}]*-webkit-line-clamp: 2/);
    expect(css).not.toMatch(/\.wo-table[^{]*\{[^}]*min-width: *(\d{4,}|[1-9]\d{3})/);
    // actions stay on one line in a fixed order on wide pages; phone cards lead with Needs
    expect(css).toMatch(/\.wo-acts \{[^}]*flex-wrap: nowrap/);
    expect(css).toMatch(/td\[data-l="Needs"\] \{ grid-row: 3/);
    expect(css).toMatch(/@media \(max-width: 639px\)[\s\S]*\.dtable, \.dtable tbody, \.dtable tr, \.dtable td \{ display: block/);
    // eight columns at most (select + 7), so the row fits a 1366 px page next to the nav
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page(rows()) }) });
  });
});

describe("shared work order actions", () => {
  it("render Conversation then Record, and leave out the page you are on", () => {
    const { container, rerender } = render(<WoActions wo={{ id: "WO-1", project: "payments" }} />);
    expect(Array.from(container.querySelectorAll("a")).map((a) => a.textContent)).toEqual(["Conversation", "Record"]);
    rerender(<WoActions wo={{ id: "WO-1", project: "payments" }} here="record" />);
    expect(Array.from(container.querySelectorAll("a")).map((a) => a.textContent)).toEqual(["Conversation"]);
  });

  const GATE = { wo: "WO-2398", title: "Add idempotency keys", gate: "G2", gateLabel: "G2", gateName: "Spec approved", project: "payments", projectName: "Payments Platform", have: 1, need: 2, waitMs: 3_600_000 };
  const home = (sections: Record<string, unknown>) => ({ approvals: [], conversations: [], badges: {}, sections });

  it("Inbox rows carry the same actions, and Conversation opens the conversation", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] }, attention: [] }) }) });
    mount(<InboxView />);
    const acts = await waitFor(() => { const e = document.getElementById("inb-acts-gate-WO-2398-G2"); if (!e) throw new Error("no actions"); return e; });
    expect(Array.from(acts.querySelectorAll("a, button")).map((a) => a.textContent)).toEqual(["Conversation", "Record", "Approve…"]);
    fireEvent.click(within(acts).getByText("Conversation"));
    expect(window.location.hash).toBe("#/p/payments/conversations/WO-2398");
  });

  it("Home's needs-you rows carry the same actions, and Conversation opens the conversation", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] }, attention: [] }) }) });
    mount(<HomeView />);
    const acts = await waitFor(() => { const e = document.getElementById("hm-acts-gate-WO-2398-G2"); if (!e) throw new Error("no actions"); return e; });
    expect(Array.from(acts.querySelectorAll("a, button")).map((a) => a.textContent)).toEqual(["Conversation", "Record", "Approve…"]);
    fireEvent.click(within(acts).getByText("Conversation"));
    expect(window.location.hash).toBe("#/p/payments/conversations/WO-2398");
  });
});
