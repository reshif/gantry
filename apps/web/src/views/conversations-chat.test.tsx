/** The Conversations screen as a chat: own scroll box landing on the newest, pinned composer, folded line events, repeated questions, one-line reply references, grouped list, side threads in the pane. */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConversationsView from "./conversations";
import { updatePrefs } from "../lib/prefs";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { intakeWo, readsFor } from "./traveler/testkit";
import type { WoSession, WoSessionMessage, WoSessionRow } from "./conversations/session-api";
import { buildFeed, groupSessions, questionView, reasonOf } from "./conversations/thread-model";
import type { StationQuestion } from "./documents/api";

const W = intakeWo;
const T0 = Date.now() - 10 * 3_600_000;

beforeEach(() => {
  resetApp();
  window.history.replaceState(null, "", "/");
  updatePrefs({ scopeAll: false, project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
});

const q = (id: string, over: Partial<StationQuestion & { mine: boolean }> = {}): StationQuestion & { mine: boolean } => ({
  id, station: "build", attemptId: null, askedBy: "ag-build", question: "Which currency should refunds use?", why: "", options: [], blocking: true, askOf: "requester", status: "open", answer: null, answerKind: null, answeredBy: null, answeredAt: null, createdAt: T0, mine: true, ...over,
});
const upd = (id: string, text: string, at: number): WoSessionMessage => ({ id, role: "system", author: "system", text, at, data: { kind: "update" } });
const ask = (id: string, qid: string, at: number): WoSessionMessage => ({ id, role: "assistant", author: "ag-build", text: "", at, data: { kind: "station", cards: [{ kind: "station_question", id: qid, station: "build" } as never] } });
const agentMsg = (id: string, text: string, at: number): WoSessionMessage => ({ id, role: "assistant", author: "ag-intake", text, at, data: { mode: "agent", agent: "Intake Clerk" } });

const session = (messages: WoSessionMessage[], questions: Array<StationQuestion & { mine: boolean }> = []): WoSession => ({
  woId: W.id, project: "payments", repo: W.repo,
  wo: { id: W.id, title: W.title, description: "", cls: W.cls, clsName: "Feature", confidence: 0.9, rationale: "", priority: "P2", station: "build", stationName: "Build", state: "waiting", bay: null, gate: null, requestedBy: "p-tomas", closed: false },
  messages,
  agent: { mode: "agent", name: "Intake Clerk", id: "ag-intake", model: "m", vendor: "anthropic", version: 1, station: "intake" },
  budget: { spentUsd: 0, limitUsd: 1 }, costUsd: 0, can: { talk: true, talkWhy: "", confirm: true, confirmWhy: "" },
  steps: [{ id: "intake", name: "Intake", state: "done" }, { id: "build", name: "Build", state: "current" }],
  next: { actor: "you", text: "Answer the question." }, waiting: null, pending: [], dialogue: { questions, assumptions: [], objections: [], askedMe: true }, swarm: null, documents: [],
  research: { plan: null, allowList: [], canDecide: false, canApproveUnlisted: false }, sources: [],
  brief: { goal: "", scopeIn: [], scopeOut: [], ac: [], risks: [], open: [], decisions: [], route: [], children: [] } as never, briefConfirmed: true, briefOpen: false, ruleQuestion: null, ruleReady: false, busy: false,
});

const row = (id: string, over: Partial<WoSessionRow> = {}): WoSessionRow => ({
  id, project: "payments", title: `Title of ${id}`, cls: "feature", station: "build", stationName: "Build", state: "waiting", bay: null, gate: null, agent: "ag-build", agentName: "Build", waitingOn: "agent",
  latest: { text: "x", at: T0, by: "ag-build", role: "assistant" }, unread: false, closed: false, started: true, requestedBy: "p-tomas", createdAt: T0, ...over,
});

async function open(s: WoSession, extra: Parameters<typeof mockApi>[0] = {}) {
  window.location.hash = `#/p/payments/conversations/${W.id}`;
  mockApi({ ...readsFor(W), [`GET /api/v1/work-orders/${W.id}/session`]: () => ({ body: s }), [`POST /api/v1/work-orders/${W.id}/session/seen`]: () => ({ body: { ok: true, msg: "Seen." } }), ...extra });
  mount(<ConversationsView />);
  await screen.findByRole("region", { name: `Conversation ${W.id}` }, { timeout: 4000 });
}

describe("thread model", () => {
  it("groups the list as Needs you, Active, Done, newest first, with a reason that says why", () => {
    const rows = [
      row("WO-1", { closed: true, state: "done" }),
      row("WO-2", { waitingOn: "agent", latest: { text: "x", at: T0 + 5, by: "a", role: "assistant" } }),
      row("WO-3", { waitingOn: "you", latest: { text: "x", at: T0 + 1, by: "a", role: "assistant" } }),
      row("WO-4", { waitingOn: "you", latest: { text: "x", at: T0 + 9, by: "a", role: "assistant" } }),
      row("WO-5", { waitingOn: "approver", gate: "G5" }),
    ];
    const g = groupSessions(rows);
    expect(g.map((x) => x.id)).toEqual(["needs", "active", "done"]);
    expect(g[0]!.rows.map((r) => r.id)).toEqual(["WO-4", "WO-3"]);
    expect(g[1]!.rows.map((r) => r.id)).toEqual(["WO-2", "WO-5"]);
    expect(reasonOf(rows[3]!).text).toBe("Question from Build");
    expect(reasonOf(rows[4]!).text).toBe("Gate G5");
  });

  it("folds a run of line events into one item and collapses a question asked again into the latest copy", () => {
    const qs = [q("Q1", { createdAt: T0, status: "dismissed" }), q("Q2", { createdAt: T0 + 1 }), q("Q3", { createdAt: T0 + 2 })];
    const v = questionView(qs);
    expect([...v.superseded].sort()).toEqual(["Q1", "Q2"]);
    expect(v.times.get("Q3")).toBe(3);
    const feed = buildFeed([agentMsg("a", "hi", T0), upd("e1", "Moved", T0 + 1), upd("e2", "Back", T0 + 2), ask("m1", "Q1", T0 + 3), upd("e3", "Moved on", T0 + 4), ask("m3", "Q3", T0 + 5)], v);
    expect(feed.map((f) => f.kind)).toEqual(["msg", "events", "msg"]);
    expect(feed[1]!.kind === "events" && feed[1]!.items.length).toBe(3);
  });
});

describe("Conversation pane", () => {
  it("opens on the newest message inside its own scroll box, and the composer sits outside that box", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 4800 });
    await open(session([agentMsg("a", "first", T0), agentMsg("b", "newest", T0 + 10)]));
    const box = document.getElementById("conv-scroll")!;
    await waitFor(() => expect(box.scrollTop).toBe(4800));
    const input = document.getElementById("wos-input")!;
    expect(box.contains(input)).toBe(false);
    expect(input.closest(".conv-compose")).toBeTruthy();
  });

  it("shows a New messages button instead of jumping when the person has scrolled up", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 4800 });
    let msgs = [agentMsg("a", "first", T0)];
    window.location.hash = `#/p/payments/conversations/${W.id}`;
    mockApi({ ...readsFor(W), [`GET /api/v1/work-orders/${W.id}/session`]: () => ({ body: session(msgs) }), [`POST /api/v1/work-orders/${W.id}/session/seen`]: () => ({ body: { ok: true, msg: "Seen." } }) });
    mount(<ConversationsView />);
    const box = await waitFor(() => { const b = document.getElementById("conv-scroll"); if (!b) throw new Error("no thread"); return b; });
    await waitFor(() => expect(box.scrollTop).toBe(4800));
    box.scrollTop = 0;
    fireEvent.scroll(box);
    msgs = [...msgs, agentMsg("b", "newer", T0 + 5)];
    const { invalidateSlices } = await import("../api/keys");
    invalidateSlices(["workOrders", "conversations"]);
    fireEvent.click(await screen.findByRole("button", { name: "New messages" }, { timeout: 4000 }));
    expect(box.scrollTop).toBe(4800);
  });

  it("folds line events into one row, and the toggle (in the URL) shows them", async () => {
    await open(session([agentMsg("a", "hello", T0), upd("e1", "Moved to the queue bay", T0 + 1), upd("e2", "Back on the belt", T0 + 2), upd("e3", "moved on to the build station", T0 + 3), agentMsg("b", "later", T0 + 9)]));
    const run = await screen.findByRole("button", { name: "3 line events" });
    expect(screen.queryByText(/Back on the belt/)).toBeNull();
    fireEvent.click(document.getElementById("conv-events")!);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("ev")).toBe("1"));
    expect(await screen.findByText(/Back on the belt/)).toBeTruthy();
    expect(run.getAttribute("aria-expanded")).toBe("true");
  });

  it("draws a question asked three times once, says so, and names it in the header with a jump link", async () => {
    const qs = [q("Q-1", { createdAt: T0, status: "dismissed" }), q("Q-2", { createdAt: T0 + 1, status: "dismissed" }), q("Q-3", { createdAt: T0 + 2 })];
    await open(session([ask("m1", "Q-1", T0), ask("m2", "Q-2", T0 + 1), ask("m3", "Q-3", T0 + 2)], qs));
    await screen.findByText("asked 3 times");
    expect(document.querySelectorAll(".sq-card").length).toBe(1);
    expect(document.getElementById("wos-status")!.textContent).toContain("Build is waiting for you");
    expect(screen.getByRole("button", { name: "Jump to question" })).toBeTruthy();
  });

  it("shows a person's answer compactly with a one-line reference to its question, not the whole quote", async () => {
    const answered = q("Q-1", { status: "answered", answer: "EUR", answeredBy: "p-tomas", answeredAt: T0 + 5, blocking: false });
    const ans: WoSessionMessage = { id: "u1", role: "user", author: "p-tomas", text: "EUR", at: T0 + 5, data: { kind: "answer", cards: [{ kind: "station_question", id: "Q-1", station: "build" } as never] } };
    await open(session([ask("m1", "Q-1", T0), ans], [answered]));
    const ref = await screen.findByRole("button", { name: /Replying to Build: Which currency/ });
    expect(ref.textContent).toContain("replying to Build: Which currency should refunds use?");
    expect(ref.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".cmsg.is-me .bub")!.textContent).toBe("EUR");
    expect(document.querySelector(".wos-answer-q")).toBeNull();
    expect(document.querySelector(".conv-ql")!.textContent).toContain("Answered: EUR");
  });
});

describe("Conversation list and side threads", () => {
  it("lists Needs you first, then Active, then Done, with reason chips and no ? avatar", async () => {
    mockApi({ ...readsFor(W), "GET /api/v1/work-order-sessions": () => ({ body: { items: [row("WO-1", { closed: true, state: "done", agent: null }), row("WO-2"), row("WO-3", { waitingOn: "you", agent: null })] } }) });
    mount(<ConversationsView />);
    await screen.findByText("Question from Build");
    expect([...document.querySelectorAll(".conv-grp")].map((h) => h.id)).toEqual(["conv-grp-needs", "conv-grp-active", "conv-grp-done"]);
    expect([...document.querySelectorAll(".conv-row .av")].some((a) => a.textContent === "?")).toBe(false);
    expect(document.querySelector(".conv-row-title")!.getAttribute("title")).toBe("Title of WO-3");
  });

  it("opens a side thread of the work order in the same pane, from its Side threads tab", async () => {
    const item = { key: "ct-9", kind: "side", scope: { kind: "work_order", id: W.id, label: W.id }, project: "payments", title: "Is the refund idempotent?", agent: "ag-research", agentName: "Researcher", waitingOn: "nobody", unread: false, latest: null, updatedAt: T0, archived: null, pinned: false, mine: true, shared: false, owner: "p-tomas", visibility: "project", spendUsd: 0 };
    await open(session([agentMsg("a", "hi", T0)]), { "GET /api/v1/workspace/inbox": () => ({ body: { items: [item, { ...item, key: "ct-8", scope: { kind: "work_order", id: "WO-other", label: "x" }, title: "Elsewhere" }] } }) });
    fireEvent.click(await screen.findByRole("tab", { name: /Side threads/ }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("side")).toBe("list"));
    expect(await screen.findByText("Is the refund idempotent?")).toBeTruthy();
    expect(screen.queryByText("Elsewhere")).toBeNull();
    fireEvent.click(document.getElementById("conv-side-ct-9")!);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("side")).toBe("ct-9"));
    expect(document.getElementById("conv-side-back")).toBeTruthy();
    expect(document.getElementById("conv-scroll")).toBeNull();
    expect(window.location.hash).toContain("/conversations/");
  });
});
