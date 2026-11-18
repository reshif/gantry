import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceView from "./workspace";
import ConversationsView from "./conversations";
import { updatePrefs } from "../lib/prefs";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { intakeWo, readsFor } from "./traveler/testkit";
import { filterInbox, snippetParts, type InboxItem, type WsAgent } from "./workspace/api";
import { Inbox, rowWhere } from "./workspace/Inbox";
import { mentionChoices, mentionOf, takeAsk } from "./workspace/mention";

beforeEach(() => {
  resetApp();
  updatePrefs({ project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const now = Date.now();
const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  key: "wo:WO-1", kind: "primary", scope: { kind: "work_order", id: "WO-1", label: "WO-1" }, project: "payments", title: "Refund rounding", agent: "ag-research", agentName: "Researcher",
  waitingOn: "agent", unread: false, latest: null, updatedAt: now - 60_000, archived: null, pinned: false, mine: false, shared: true, owner: null, visibility: "project", spendUsd: null,
  wo: { cls: "feature", station: "research", stationName: "Research", state: "running", bay: null, gate: null, closed: false }, ...over,
});
const ITEMS: InboxItem[] = [
  item(),
  item({ key: "wo:WO-2", scope: { kind: "work_order", id: "WO-2", label: "WO-2" }, title: "Gate waits on me", waitingOn: "you", wo: { cls: "feature", station: "spec", stationName: "Spec", state: "waiting", bay: null, gate: "G2", closed: false } }),
  item({ key: "ct-side1", kind: "side", scope: { kind: "work_order", id: "WO-1", label: "WO-1" }, title: "Researcher about WO-1", waitingOn: "nobody", owner: "p-tomas", mine: false, wo: undefined }),
  item({ key: "ct-mine", kind: "chat", scope: { kind: "factory", id: null, label: "Factory" }, project: null, title: "Which gates are slow?", agent: null, agentName: "Console", waitingOn: "nobody", owner: "p-asha", mine: true, shared: false, visibility: "private", spendUsd: 0.04, wo: undefined }),
  item({ key: "wo:WO-3", scope: { kind: "work_order", id: "WO-3", label: "WO-3" }, title: "Closed long ago", waitingOn: "nobody", archived: "auto", wo: { cls: "feature", station: "close", stationName: "Close", state: "done", bay: null, gate: null, closed: true } }),
];
const AGENTS: WsAgent[] = [
  { id: "ag-research", name: "Researcher", station: "research", stationName: "Research" },
  { id: "ag-spec", name: "Spec Writer", station: "spec", stationName: "Spec" },
  { id: "ag-specx", name: "Specialist", station: "special", stationName: "Special" },
];

describe("inbox rows", () => {
  it("names the full station for work orders, the bay when in one, and the agent for chats", () => {
    const long = item({ wo: { cls: "feature", station: "review", stationName: "Review and merge to main", state: "waiting", bay: null, gate: "G4", closed: false } });
    expect(rowWhere(long)).toBe("Review and merge to main");
    expect(rowWhere(item({ wo: { ...long.wo!, bay: "B2" } }))).toBe("Review and merge to main · Bay B2");
    expect(rowWhere(ITEMS[3]!)).toBe("Console");
  });

  it("renders the whole title and station in the row, with the wait chip and age on their own meta line", () => {
    const title = "Follow the documented Nautobot onboarding steps for the new device inventory sync";
    const items = [item({ title, waitingOn: "you", wo: { cls: "feature", station: "review", stationName: "Review and merge to main", state: "waiting", bay: null, gate: "G4", closed: false } })];
    const { container } = mount(<Inbox me="p-asha" items={items} loading={false} current={null} filter="active" onFilter={() => {}} onPick={() => {}} onNew={() => {}} onSearch={() => {}} operator={null} />);
    const row = container.querySelector(".ws-row-btn")!;
    expect(row.querySelector(".ws-row-title")!.textContent).toBe(title);
    expect(row.querySelector(".ws-row-where")!.textContent).toBe("Review and merge to main");
    const meta = row.querySelector(".ws-row-meta")!;
    expect(meta.querySelector(".ws-wait")!.textContent).toContain("G4");
    expect(meta.querySelector(".ws-row-t")).not.toBeNull();
    expect(row.querySelector(".ws-row-title")!.getAttribute("title")).toBe(title);
  });

  it("leaves out the where line when there is nothing to name", () => {
    const { container } = mount(<Inbox me="p-asha" items={[item({ kind: "primary", wo: undefined, agentName: undefined, waitingOn: "nobody" })]} loading={false} current={null} filter="active" onFilter={() => {}} onPick={() => {}} onNew={() => {}} onSearch={() => {}} operator={null} />);
    expect(container.querySelector(".ws-row-where")).toBeNull();
    expect(container.querySelector(".ws-row-title")).not.toBeNull();
  });
});

describe("workspace helpers", () => {
  it("filters the inbox: needs me is what waits on the person; archived holds what closed long ago or was filed away; shared is others' chats", () => {
    expect(filterInbox(ITEMS, "needs").map((i) => i.key)).toEqual(["wo:WO-2"]);
    expect(filterInbox(ITEMS, "active").map((i) => i.key)).toEqual(["wo:WO-1", "wo:WO-2", "ct-side1", "ct-mine"]);
    expect(filterInbox(ITEMS, "mine").map((i) => i.key)).toEqual(["ct-mine"]);
    expect(filterInbox(ITEMS, "shared").map((i) => i.key)).toEqual(["ct-side1"]);
    expect(filterInbox(ITEMS, "archived").map((i) => i.key)).toEqual(["wo:WO-3"]);
  });

  it("reads an @mention by name, id or station, the longest name first, and only at a word boundary", () => {
    expect(mentionOf("@Researcher why skip the API docs?", AGENTS)).toEqual({ agent: AGENTS[0], text: "why skip the API docs?" });
    expect(mentionOf("@spec writer: is AC 3 testable?", AGENTS)).toMatchObject({ agent: { id: "ag-spec" }, text: "is AC 3 testable?" });
    expect(mentionOf("@Spec is AC 3 testable?", AGENTS)).toMatchObject({ agent: { id: "ag-spec" }, text: "is AC 3 testable?" });
    expect(mentionOf("@Specialist and you?", AGENTS)).toMatchObject({ agent: { id: "ag-specx" } });
    expect(mentionOf("@ag-research, one more", AGENTS)).toMatchObject({ agent: { id: "ag-research" }, text: "one more" });
    expect(mentionOf("@Researchers are great", AGENTS)).toBeNull();
    expect(mentionOf("Researcher, why?", AGENTS)).toBeNull();
    expect(mentionChoices("@spe", AGENTS).map((a) => a.id)).toEqual(["ag-spec", "ag-specx"]);
    expect(mentionChoices("@spec writer", AGENTS)).toEqual([]);
  });

  it("splits a search snippet on the server's marks and never treats it as HTML", () => {
    expect(snippetParts("the ⟦refund⟧ job <b>rounds</b> ⟦half⟧-up")).toEqual([
      { text: "the ", hit: false }, { text: "refund", hit: true }, { text: " job <b>rounds</b> ", hit: false }, { text: "half", hit: true }, { text: "-up", hit: false },
    ]);
  });
});

describe("Agents at work", () => {
  const show = (extra: Parameters<typeof mockApi>[0] = {}) => {
    const calls = mockApi({ ...readsFor(intakeWo), "GET /api/v1/workspace/inbox": () => ({ body: { items: ITEMS } }), ...extra });
    mount(<WorkspaceView />);
    return calls;
  };

  it("opens on what needs the person, groups the rest by kind, and pins and archives from a row's menu", async () => {
    window.location.hash = "#workspace/inbox";
    const calls = show({ "PATCH /api/v1/workspace/threads/wo%3AWO-2": () => ({ body: { ok: true, msg: "Pinned." } }) });
    const inbox = await screen.findByRole("navigation", { name: "Conversations" });
    await waitFor(() => expect(within(inbox).getByRole("tab", { name: /Needs me/ }).getAttribute("aria-selected")).toBe("true"));
    expect(within(inbox).getByText("Gate waits on me")).toBeTruthy();
    expect(within(inbox).getByText("G2: yours to decide")).toBeTruthy();
    expect(within(inbox).queryByText("Refund rounding")).toBeNull();
    expect(screen.getByText("1 conversation need you")).toBeTruthy();

    fireEvent.click(within(inbox).getByRole("tab", { name: /Active/ }));
    expect(within(inbox).getByRole("region", { name: "Work orders" })).toBeTruthy();
    expect(within(within(inbox).getByRole("region", { name: "Side threads" })).getByText("Researcher about WO-1")).toBeTruthy();
    expect(within(within(inbox).getByRole("region", { name: "Factory chats" })).getByText("Which gates are slow?")).toBeTruthy();
    expect(within(inbox).queryByText("Closed long ago")).toBeNull();

    fireEvent.click(within(inbox).getByRole("button", { name: "Options for Gate waits on me" }));
    fireEvent.click(await screen.findByText("Pin to top"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && decodeURIComponent(c.path) === "/api/v1/workspace/threads/wo:WO-2" && (c.body as { pinned?: boolean }).pinned === true)).toBe(true));
  });

  it("filters by name as the person types, and Enter searches inside messages, documents and sources with the matches marked", async () => {
    window.location.hash = "#workspace/inbox";
    show({ "GET /api/v1/workspace/search": (c) => ({ body: { items: c.query.get("q") === "rounding" ? [{ kind: "document", key: "wo:WO-1", ref: "a1", title: "WO-1 · research.md v2", snippet: "the ⟦rounding⟧ is half-up", at: now, rank: 0.5, project: "payments", by: "ag-research" }] : [] } }) });
    const inbox = await screen.findByRole("navigation", { name: "Conversations" });
    fireEvent.click(within(inbox).getByRole("tab", { name: /Active/ }));
    const q = within(inbox).getByRole("searchbox");
    fireEvent.change(q, { target: { value: "gates" } });
    expect(within(inbox).getByText("Which gates are slow?")).toBeTruthy();
    expect(within(inbox).queryByText("Refund rounding")).toBeNull();
    fireEvent.change(q, { target: { value: "rounding" } });
    fireEvent.submit(q.closest("form")!);
    const results = await screen.findByRole("region", { name: "Search results for rounding" });
    expect(await within(results).findByText("WO-1 · research.md v2")).toBeTruthy();
    expect(within(results).getByText("rounding").tagName).toBe("MARK");
    fireEvent.click(within(results).getByRole("button", { name: /research\.md v2/ }));
    await waitFor(() => expect(window.location.hash).toBe("#workspace/wo%3AWO-1"));
  });

  it("an old Conversations link lands on the same work order in the workspace", async () => {
    window.location.hash = `#/p/payments/conversations/${intakeWo.id}`;
    show();
    await waitFor(() => expect(window.location.hash).toBe(`#workspace/${encodeURIComponent(`wo:${intakeWo.id}`)}`));
  });

  it("a shared side thread the person was not invited to is read-only, says why, and shows who can read it", async () => {
    window.location.hash = "#workspace/ct-side1";
    show({
      "GET /api/v1/console/threads/ct-side1": () => ({ body: { id: "ct-side1", title: "Researcher about WO-1", pinned: [], createdAt: now, updatedAt: now, expiresAt: now + 1e9, retentionDays: 90, owner: "p-tomas", scope: { kind: "work_order", id: "WO-1" }, projectId: "payments", agentId: "ag-research", visibility: "project", status: "active", archivedAt: null, archivedBy: null, members: [], can: { post: false, manage: false },
        messages: [{ id: "cm-1", threadId: "ct-side1", role: "user", author: "p-tomas", text: "Why half-up?", at: now - 5000, data: {} }, { id: "cm-2", threadId: "ct-side1", role: "assistant", author: "ag-research", text: "The job's docs say so [s1].", at: now - 4000, data: { mode: "model", agent: "ag-research", agentName: "Researcher" } }] } }),
      "GET /api/v1/console/threads": () => ({ body: { items: [], retentionDays: 90 } }),
      "GET /api/v1/console/status": () => ({ body: { configured: true, vendor: "anthropic", model: "claude-test", proposals: [], canUse: true, actionsEnabled: false, retentionDays: 90, tools: [] } }),
    });
    expect(await screen.findByText(/Read-only: this conversation was shared with the project/)).toBeTruthy();
    expect(document.getElementById("con-input")).toBeNull();
    expect(screen.getByText("Project can read")).toBeTruthy();
    expect(await screen.findByText("The job's docs say so [s1].")).toBeTruthy();
    const about = screen.getByRole("complementary", { name: "About this thread" });
    expect(within(about).getByText(/A side thread changes nothing/)).toBeTruthy();
    expect(within(about).queryByRole("button", { name: /Invite/ })).toBeNull();
  });
});

describe("@mention from a work order's thread", () => {
  it("asks the named agent in a new side thread about the work order and opens it with the question queued", async () => {
    const W = intakeWo;
    window.location.hash = `#/p/payments/conversations/${W.id}`;
    const s = {
      woId: W.id, project: "payments", repo: W.repo,
      wo: { id: W.id, title: W.title, description: "", cls: W.cls, clsName: "Feature", confidence: 0.9, rationale: "", priority: "P2", station: "research", stationName: "Research", state: "running", bay: null, gate: null, requestedBy: "p-tomas", closed: false },
      messages: [], agent: { mode: "agent", name: "Researcher", id: "ag-research", model: "m", vendor: "anthropic", version: 1, station: "research" },
      budget: { spentUsd: 0, limitUsd: 0.5 }, costUsd: 0, can: { talk: false, talkWhy: "Only the requester and approvers talk here.", confirm: false, confirmWhy: "" },
      steps: [], next: { actor: "agent", text: "The Researcher is working." }, waiting: null, pending: [], dialogue: { questions: [], assumptions: [], objections: [], askedMe: false }, swarm: null, documents: [], research: { plan: null, allowList: [], canDecide: false, canApproveUnlisted: false }, sources: [],
      brief: { goal: "", scopeIn: [], scopeOut: [], ac: [], risks: [], open: [], decisions: [], estimate: "", route: [], children: [] }, briefConfirmed: true, briefOpen: false, ruleQuestion: null, ruleReady: false, busy: false,
    };
    const calls = mockApi({
      ...readsFor(W),
      [`GET /api/v1/work-orders/${W.id}/session`]: () => ({ body: s }),
      [`POST /api/v1/work-orders/${W.id}/session/seen`]: () => ({ body: { ok: true } }),
      "GET /api/v1/workspace/agents": () => ({ body: { items: AGENTS } }),
      "POST /api/v1/workspace/threads": () => ({ body: { ok: true, msg: "New thread with Researcher.", id: "ct-new", key: "ct-new", title: "Researcher about WO", visibility: "project" } }),
    });
    mount(<ConversationsView />);
    const box = (await screen.findByRole("textbox", { name: /^Reply$/ }, { timeout: 4000 })) as HTMLTextAreaElement;
    // Read-only for this person, but an @mention still works: it opens a side thread, it does not post here.
    fireEvent.change(box, { target: { value: "@spe" } });
    expect(await screen.findByRole("listbox", { name: "Ask an agent in a side thread" })).toBeTruthy();
    fireEvent.change(box, { target: { value: "@Researcher why skip the API docs?" } });
    expect(screen.getByText("Asks Researcher in a side thread")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask Researcher" }));
    await waitFor(() => expect(window.location.hash).toBe("#workspace/ct-new"));
    const made = calls.find((c) => c.method === "POST" && c.path === "/api/v1/workspace/threads")!;
    expect(made.body).toEqual({ scope: { kind: "work_order", id: W.id }, agent: "ag-research", visibility: "project" });
    expect(calls.some((c) => c.path.endsWith("/session/messages"))).toBe(false);
    expect(takeAsk("ct-new")).toBe("why skip the API docs?");
  });
});

describe("Operator view", () => {
  it("lists chat spending in the shared table styles, inside a scroll wrapper, with the number columns right-aligned", async () => {
    window.location.hash = "#workspace/operator";
    mockApi({
      ...readsFor(intakeWo), "GET /api/v1/workspace/inbox": () => ({ body: { items: ITEMS } }),
      "GET /api/v1/workspace/operator": () => ({ body: { stuck: [], waiting: [], budget: [], chats: { people: [{ person: "p-asha", usd: 1.25, answers: 4, capUsd: null }], threads: [] }, projects: ["payments"], capUsd: null, canEditCap: false, canSeePeople: true, quietMinutes: 15 } }),
    });
    mount(<WorkspaceView />);
    const table = await waitFor(() => { const t = document.getElementById("ws-op-people"); expect(t).toBeTruthy(); return t as HTMLElement; });
    expect(table.className).toBe("table table-compact");
    expect(table.parentElement?.className).toBe("table-scroll");
    expect([...table.querySelectorAll("th")].map((th) => th.className)).toEqual(["", "num", "num"]);
    expect([...table.querySelectorAll("tbody td")].map((td) => td.className)).toEqual(["", "num mono", "num mono"]);
  });
});
