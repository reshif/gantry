/** The Conversations page as a chat: opens at the newest message with its own scroll and a pinned composer, folds line events and repeated questions, tells the person's words from the agent's, groups the thread list, and shows side threads in the same pane. */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConversationsView from "./conversations";
import { invalidateSlices } from "../api/keys";
import { updatePrefs } from "../lib/prefs";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { intakeWo, readsFor } from "./traveler/testkit";
import { buildTranscript, groupThreads, questionViews } from "./conversations/chat";
import type { WoSession, WoSessionMessage, WoSessionRow } from "./conversations/session-api";
import type { InboxItem } from "./workspace/api";

beforeEach(() => {
  resetApp();
  updatePrefs({ project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const W = intakeWo;
const now = Date.now();
const row = (over: Partial<WoSessionRow> = {}): WoSessionRow => ({
  id: W.id, project: "payments", title: W.title, cls: W.cls, station: "build", stationName: "Build", state: "waiting", bay: null, gate: null, agent: "ag-build", agentName: "Builder", waitingOn: "agent",
  latest: { text: "Working on it", at: now - 60_000, by: "ag-build", role: "assistant" }, unread: false, closed: false, started: true, requestedBy: "p-tomas", createdAt: now - 3_600_000, ...over,
});
const q = (id: string, over: Record<string, unknown> = {}) => ({ id, station: "build", attemptId: "AT1", askedBy: "ag-build", question: "Which branch should the build use?", why: "Two release branches exist.", options: ["main", "release"], blocking: true, askOf: "requester", status: "open" as const, answer: null, answerKind: null, answeredBy: null, answeredAt: null, createdAt: now - 10_000, mine: true, ...over });
const ev = (id: string, text: string, at: number): WoSessionMessage => ({ id, role: "system", author: "system", text, at, data: { kind: "update", mode: "rule-based", cards: [] } });
const ask = (id: string, qid: string, at: number): WoSessionMessage => ({ id, role: "assistant", author: "ag-build", text: "Build has a question.", at, data: { kind: "station", mode: "agent", agent: "ag-build", cards: [{ kind: "station_question", id: qid }] } });

const QS = [1, 2, 3, 4, 5].map((n) => q(`Q-${n}`, { createdAt: now - (60 - n) * 1000, status: n === 5 ? "open" : "answered", answer: n === 1 ? "main" : null, answeredBy: n === 1 ? "p-tomas" : null }));
const MSGS: WoSessionMessage[] = [
  ev("e1", "Moved to the queue bay", now - 100_000), ev("e2", "Back on the belt", now - 99_000), ev("e3", "Moved on to the build station", now - 98_000),
  ...QS.map((x, i) => ask(`m${i + 1}`, x.id, now - (60 - i) * 1000)),
  { id: "a1", role: "user", author: "p-tomas", text: "main", at: now - 55_000, data: { kind: "answer", cards: [{ kind: "station_question", id: "Q-1" }] } },
  { id: "d1", role: "assistant", author: "ag-build", text: "I wrote the plan.", at: now - 5000, data: { kind: "station", mode: "agent", agent: "ag-build", cards: [{ kind: "document", id: "doc-1", name: "build.md", version: 2 }] } },
];
const session = (over: Partial<WoSession> = {}): WoSession => ({
  woId: W.id, project: "payments", repo: W.repo,
  wo: { id: W.id, title: W.title, description: "", cls: W.cls, clsName: "Feature", confidence: 0.9, rationale: "", priority: "P2", station: "build", stationName: "Build", state: "waiting", bay: null, gate: null, requestedBy: "p-tomas", closed: false },
  messages: MSGS,
  agent: { mode: "agent", name: "Builder", id: "ag-build", model: "m", vendor: "anthropic", version: 1, station: "build" },
  budget: { spentUsd: 0, limitUsd: 1 }, costUsd: 0, can: { talk: true, talkWhy: "", confirm: true, confirmWhy: "" },
  steps: [], next: { actor: "you", text: "Answer the question." }, waiting: null, pending: [],
  dialogue: { questions: QS, assumptions: [], objections: [], askedMe: true }, swarm: null, documents: [], research: { plan: null, allowList: [], canDecide: false, canApproveUnlisted: false }, sources: [],
  brief: { goal: "", scopeIn: [], scopeOut: [], ac: [], risks: [], open: [], decisions: [], estimate: "", route: [], children: [] } as never, briefConfirmed: false, briefOpen: false, ruleQuestion: null, ruleReady: false, busy: false, ...over,
});

async function open(s: WoSession, extra: Parameters<typeof mockApi>[0] = {}, rows: WoSessionRow[] = [row({ waitingOn: "you" })], hash = `#/p/payments/conversations/${W.id}`, listOnly = false) {
  window.location.hash = hash;
  const calls = mockApi({ ...readsFor(W), "GET /api/v1/work-order-sessions": () => ({ body: { items: rows } }), [`GET /api/v1/work-orders/${W.id}/session`]: () => ({ body: s }), [`POST /api/v1/work-orders/${W.id}/session/seen`]: () => ({ body: { ok: true, msg: "Seen." } }), ...extra });
  mount(<ConversationsView />);
  if (listOnly) await screen.findAllByRole("list", { name: /work-order conversations/ }, { timeout: 4000 });
  else await screen.findByRole("region", { name: `Conversation ${W.id}` }, { timeout: 4000 });
  return calls;
}

describe("the chat opens at the newest message and keeps the composer in view", () => {
  it("scrolls its own area to the end on open, and the composer is outside that area", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(4321);
    await open(session());
    const area = document.getElementById("wos-thread") as HTMLElement;
    await waitFor(() => expect(area.scrollTop).toBe(4321));
    const box = screen.getByLabelText("Reply");
    expect(area.contains(box)).toBe(false);
    expect(box.closest("form")?.classList.contains("cv-composer")).toBe(true);
    expect(area.nextElementSibling === box.closest("form") || area.parentElement?.contains(box)).toBe(true);
  });

  it("a new message while the person has scrolled up leaves the scroll alone and offers 'New messages'", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(5000);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    let s = session();
    await open(s, { [`GET /api/v1/work-orders/${W.id}/session`]: () => ({ body: s }) });
    const area = document.getElementById("wos-thread") as HTMLElement;
    await waitFor(() => expect(area.scrollTop).toBe(5000));
    area.scrollTop = 100; // the person reads older messages
    fireEvent.scroll(area);
    expect(screen.queryByRole("button", { name: "New messages" })).toBeNull();
    s = session({ messages: [...MSGS, { id: "n1", role: "assistant", author: "ag-build", text: "One more thing.", at: Date.now(), data: { kind: "station", mode: "agent", agent: "ag-build", cards: [] } }] });
    act(() => { invalidateSlices(["workOrders", "conversations"]); });
    expect(await screen.findByText("One more thing.", {}, { timeout: 4000 })).toBeTruthy();
    expect(area.scrollTop).toBe(100);
    const jump = await screen.findByRole("button", { name: "New messages" });
    // it has its own strip between the messages and the composer: it never floats over message text
    expect(area.contains(jump)).toBe(false);
    expect(jump.closest(".cv-jump-row")?.nextElementSibling?.classList.contains("cv-composer")).toBe(true);
    fireEvent.click(jump);
    expect(area.scrollTop).toBe(5000);
    expect(screen.queryByRole("button", { name: "New messages" })).toBeNull();
  });
});

describe("line events", () => {
  it("a run of events is one quiet row, '3 line events', and the toggle (in the URL) hides them", async () => {
    await open(session());
    expect(screen.getByText(/3 line events/)).toBeTruthy();
    expect(document.querySelectorAll(".cv-events").length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Hide line events" }));
    await waitFor(() => expect(window.location.hash).toContain("events=hide"));
    expect(document.querySelector(".cv-events")).toBeNull();
    expect(screen.getByRole("button", { name: "Show line events" })).toBeTruthy();
  });

  it("a link with events=hide opens with them hidden", async () => {
    await open(session(), {}, undefined, `#/p/payments/conversations/${W.id}?events=hide`);
    expect(document.querySelector(".cv-events, .cv-event")).toBeNull();
    expect(screen.getByRole("button", { name: "Show line events" })).toBeTruthy();
  });

  it("buildTranscript folds runs and drops them when asked", () => {
    const s = session();
    expect(buildTranscript(s).filter((b) => b.t === "events")).toHaveLength(1);
    expect(buildTranscript(s, false).some((b) => b.t === "events")).toBe(false);
  });
});

describe("a question asked again", () => {
  it("is one card for the latest copy, 'asked 5 times', with one answer box; the header says Build waits for you", async () => {
    await open(session());
    expect(screen.getAllByLabelText("Question from Build")).toHaveLength(1);
    expect(screen.getByText("asked 5 times")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Send answer" })).toHaveLength(1);
    const wait = document.getElementById("conv-waiting") as HTMLElement;
    expect(within(wait).getByText("Build is waiting for you")).toBeTruthy();
    expect(within(wait).getByRole("button", { name: "Go to the question" })).toBeTruthy();
  });

  it("questionViews keeps only the newest copy of the same words", () => {
    const v = questionViews(QS);
    expect([...v.entries()].filter(([, x]) => x.shown).map(([id]) => id)).toEqual(["Q-5"]);
    expect(v.get("Q-5")?.times).toBe(5);
  });

  it("an answered question is one line with its answer", async () => {
    const answered = QS.map((x) => ({ ...x, question: x.id === "Q-5" ? "A different question?" : x.question, status: "answered" as const, answer: "main", answeredBy: "p-tomas", answeredAt: now }));
    await open(session({ dialogue: { questions: answered, assumptions: [], objections: [], askedMe: false }, next: { actor: "agent", text: "Working" } }));
    expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull();
    expect(screen.getAllByText(/Answered: main/).length).toBeGreaterThan(0);
  });
});

describe("who said what", () => {
  it("the person's answer is a compact bubble with a one-line 'replying to', not the whole question; the agent's documents are chips", async () => {
    await open(session());
    await screen.findByText("I wrote the plan.");
    const lead = screen.getByRole("button", { name: /replying to: Build: Which branch should the build use\?/ });
    expect(lead.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Why it matters: Two release branches exist\./, { selector: ".cv-lead p" })).toBeNull();
    fireEvent.click(lead);
    expect(within(lead.closest(".cv-lead") as HTMLElement).getByText(/Two release branches exist/)).toBeTruthy();
    const mine = lead.closest(".cv-turn") as HTMLElement;
    expect(mine.classList.contains("is-person")).toBe(true);
    expect(within(mine).getByText("main")).toBeTruthy();
    expect(document.querySelector(".wos-answer-q")).toBeNull();
    expect(screen.getByRole("button", { name: /build\.md v2/ }).classList.contains("cv-doc")).toBe(true);
  });

  it("consecutive messages from the same author are one turn", () => {
    const blocks = buildTranscript(session({ messages: [ask("x1", "Q-5", 1), { ...ask("x2", "Q-5", 2), text: "Also this." }], dialogue: { questions: [QS[4]!], assumptions: [], objections: [], askedMe: true } }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.t === "turn" && blocks[0]!.msgs.length).toBe(2);
  });
});

describe("the thread list", () => {
  const rows = [
    row({ id: "WO-1", title: "Done one", closed: true, state: "done", waitingOn: "nobody", latest: { text: "x", at: now - 9000, by: "p", role: "user" } }),
    row({ id: "WO-2", title: "Busy", waitingOn: "agent" }),
    row({ id: "WO-3", title: "Asks me", waitingOn: "you" }),
    row({ id: "WO-4", title: "Gate on me", waitingOn: "you", gate: "G5", stationName: "Review" }),
  ];
  it("groups Needs you / Active / Done in that order, with a reason chip and no '?' avatar", async () => {
    await open(session(), { "GET /api/v1/work-order-sessions": () => ({ body: { items: rows } }) }, rows, "#/p/payments/conversations", true);
    const heads = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent?.replace(/\d+$/, ""));
    expect(heads.slice(0, 3)).toEqual(["Needs you", "Active", "Done"]);
    expect(screen.getByText("Gate G5")).toBeTruthy();
    expect(screen.getByText("Question from Build")).toBeTruthy();
    expect(screen.queryByText("?")).toBeNull();
    expect(screen.queryByText("asks")).toBeNull();
  });
  it("groupThreads sorts each group by last activity and filters by search and group", () => {
    const g = groupThreads(rows);
    expect(g.map((x) => x.id)).toEqual(["needs", "active", "done"]);
    expect(groupThreads(rows, "gate")[0]!.rows.map((r) => r.id)).toEqual(["WO-4"]);
    expect(groupThreads(rows, "", "done").map((x) => x.id)).toEqual(["done"]);
  });
  it("search is in the URL and narrows the list", async () => {
    await open(session(), {}, rows, "#/p/payments/conversations", true);
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "gate" } });
    await waitFor(() => expect(window.location.hash).toContain("q=gate"));
    expect(screen.queryByRole("link", { name: /Busy/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Gate on me/ })).toBeTruthy();
  });
});

describe("names and flat cards", () => {
  it("a person the people list does not resolve is 'A teammate', never a raw id; the viewer is 'You'", async () => {
    const msgs: WoSessionMessage[] = [...MSGS, { id: "u9", role: "user", author: "p-unknown-7", text: "Looks fine to me", at: now - 2000, data: { kind: "message", cards: [] } }];
    await open(session({ messages: msgs }));
    await screen.findByText("Looks fine to me");
    expect(screen.getByText(/A teammate/)).toBeTruthy();
    expect(screen.queryByText(/p-unknown-7/)).toBeNull();
  });

  it("a message that is only a card (no text) has no bubble of its own, so the card is not a box in a box", async () => {
    const msgs: WoSessionMessage[] = MSGS.map((m) => (m.id === "m5" ? { ...m, text: "" } : m));
    await open(session({ messages: msgs }));
    await screen.findByText("I wrote the plan.");
    const card = screen.getByLabelText("Question from Build");
    expect(card.closest(".cv-msg")?.classList.contains("is-cards")).toBe(true);
  });

  it("the header keeps tabs, state and the events toggle on one row, and the waiting banner on one line below", async () => {
    await open(session());
    const bar = document.querySelector(".cv-head-bar") as HTMLElement;
    expect(within(bar).getByRole("tab", { name: "Conversation" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Hide line events" })).toBeTruthy();
    expect(bar.nextElementSibling?.id).toBe("conv-waiting");
  });
});

describe("side threads", () => {
  const side: InboxItem = { key: "ct-side1", kind: "side", scope: { kind: "work_order", id: W.id, label: W.id }, project: "payments", title: "Researcher about the branch", agent: "ag-research", agentName: "Researcher", waitingOn: "nobody", unread: false, latest: null, updatedAt: now, archived: null, pinned: false, mine: true, shared: true, owner: "p-tomas", visibility: "project", spendUsd: null };
  const thread = { id: "ct-side1", title: "Researcher about the branch", pinned: [], createdAt: now, updatedAt: now, expiresAt: now + 1e9, retentionDays: 90, owner: "p-tomas", scope: { kind: "work_order", id: W.id }, projectId: "payments", agentId: "ag-research", visibility: "project", status: "active", archivedAt: null, archivedBy: null, members: [], can: { post: true, manage: true },
    messages: [{ id: "cm-1", threadId: "ct-side1", role: "user", author: "p-tomas", text: "Which branch is newest?", at: now - 5000, data: {} }] };
  it("the header has 'Side threads (1)'; the tab opens the thread in the same pane and keeps the tab in the URL", async () => {
    await open(session(), {
      "GET /api/v1/workspace/inbox": () => ({ body: { items: [side] } }),
      "GET /api/v1/console/threads/ct-side1": () => ({ body: thread }),
      "GET /api/v1/console/threads": () => ({ body: { items: [], retentionDays: 90 } }),
      "GET /api/v1/console/status": () => ({ body: { configured: true, vendor: "anthropic", model: "claude-test", proposals: [], canUse: true, actionsEnabled: false, retentionDays: 90, tools: [] } }),
    });
    const tab = await screen.findByRole("tab", { name: "Side threads (1)" });
    fireEvent.click(tab);
    await waitFor(() => expect(window.location.hash).toContain("tab=side"));
    const pane = document.getElementById("conv-detail") as HTMLElement;
    expect(await within(pane).findByText("Which branch is newest?")).toBeTruthy();
    expect(within(pane).getByRole("button", { name: /Researcher about the branch/ })).toBeTruthy();
    expect(window.location.hash).toContain("/conversations/");
  });
  it("the hub route still works", async () => {
    await open(session());
    fireEvent.click(screen.getByRole("button", { name: "All agent chats" }));
    await waitFor(() => expect(window.location.hash).toBe("#workspace/inbox"));
  });
});
