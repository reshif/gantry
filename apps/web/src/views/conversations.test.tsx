import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOpenTraveler } from "../shell/useTraveler";
import ConversationsView from "./conversations";
import { updatePrefs } from "../lib/prefs";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { intakeWo, posts, readsFor, travelerOf } from "./traveler/testkit";
import type { WoSession, WoSessionRow } from "./conversations/session-api";

beforeEach(() => {
  resetApp();
  updatePrefs({ project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const W = intakeWo;
const BRIEF = { goal: "Accept an Idempotency-Key header on refund requests.", scopeIn: ["POST /refunds"], scopeOut: [], ac: ["A repeated key returns the first refund"], risks: [], open: [], decisions: [], estimate: "2 days" };

const row = (over: Partial<WoSessionRow> = {}): WoSessionRow => ({
  id: W.id, project: "payments", title: W.title, cls: W.cls, station: "intake", stationName: "Intake", state: "waiting", bay: null, gate: "G0G1", agent: "ag-intake", agentName: "Intake Clerk", waitingOn: "you",
  latest: { text: "I read the request. Which endpoint is this for?", at: Date.now() - 60_000, by: "ag-intake", role: "assistant" }, unread: true, closed: false, started: true, requestedBy: "p-tomas", createdAt: Date.now() - 3_600_000, ...over,
});

const session = (over: Partial<WoSession> = {}): WoSession => ({
  woId: W.id, project: "payments", repo: W.repo,
  wo: { id: W.id, title: W.title, description: "", cls: W.cls, clsName: "Feature", confidence: 0.9, rationale: "", priority: "P2", station: "intake", stationName: "Intake", state: "waiting", bay: null, gate: { id: "G0G1", label: "G0+G1", name: "Brief confirmed" }, requestedBy: "p-tomas", closed: false },
  messages: [
    { id: "wm-1", role: "assistant", author: "ag-intake", text: "I read the request and the repo. Which endpoint is this for?", at: Date.now() - 60_000, data: { mode: "agent", agent: "Intake Clerk", cards: [{ kind: "question", id: "Q-1", question: "Which endpoint is this for?", options: ["POST /refunds", "Another"] }] } },
  ],
  agent: { mode: "agent", name: "Intake Clerk", id: "ag-intake", model: "claude-haiku-5-5", vendor: "anthropic", version: 1, station: "intake" },
  budget: { spentUsd: 0.02, limitUsd: 0.5 }, costUsd: 0.02, can: { talk: true, talkWhy: "", confirm: true, confirmWhy: "" },
  steps: [{ id: "intake", name: "Intake", state: "current" }, { id: "plan", name: "Plan", state: "todo" }],
  next: { actor: "you", text: "Answer the agent's question (click a suggestion or write your own)." }, waiting: null, pending: [],
  brief: { ...BRIEF, goal: "", scopeIn: [], ac: [], route: [], children: [] } as never, briefConfirmed: false, briefOpen: true, ruleQuestion: null, ruleReady: false, busy: false, ...over,
});
const withProposal = (): WoSession => session({
  messages: [{ id: "wm-2", role: "assistant", author: "ag-intake", text: "I drafted the brief; it waits for your approval.", at: Date.now(), data: { mode: "agent", agent: "Intake Clerk", cards: [{
    kind: "proposal", id: "P-1", what: "brief", status: "pending", mode: "agent", title: "Proposed brief", summary: "Idempotency for refunds.", brief: BRIEF, changes: [{ field: "goal", label: "Goal", before: [], after: [BRIEF.goal], added: [BRIEF.goal], removed: [] }], base: "x", cls: { id: "feature", name: "Feature", confidence: 0.9 }, route: ["Intake", "Plan"],
  }] } }],
  pending: [{ mid: "wm-2", id: "P-1", what: "brief", title: "Proposed brief" }], next: { actor: "you", text: "Review the proposal below." },
});

function showList(rows: WoSessionRow[]) {
  const calls = mockApi({ ...readsFor(W), "GET /api/v1/work-order-sessions": () => ({ body: { items: rows } }) });
  mount(<ConversationsView />);
  return calls;
}
async function showSession(s: WoSession, extra: Parameters<typeof mockApi>[0] = {}) {
  window.location.hash = `#/p/payments/conversations/${W.id}`;
  const calls = mockApi({ ...readsFor(W), [`GET /api/v1/work-orders/${W.id}/session`]: () => ({ body: s }), [`POST /api/v1/work-orders/${W.id}/session/seen`]: () => ({ body: { ok: true, msg: "Seen." } }), ...extra });
  mount(<ConversationsView />);
  await screen.findByRole("region", { name: `Conversation ${W.id}` }, { timeout: 4000 });
  return calls;
}

describe("Conversations list", () => {
  it("says the conversations are not visible on a 403", async () => {
    mockApi({ ...readsFor(W), "GET /api/v1/work-order-sessions": () => ({ status: 403, body: { ok: false, msg: "Needs a role on this project." } }) });
    mount(<ConversationsView />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
    expect(screen.queryByText("Nothing waits on you")).toBeNull();
  });

  it("lists work-order sessions with who waits on whom and the latest message; it has no forms; a row opens that work order's session", async () => {
    showList([row(), row({ id: "WO-9", title: "Other", waitingOn: "agent", unread: false, latest: null, started: false })]);
    expect(await screen.findByText("Waiting on you")).toBeTruthy();
    expect(screen.getByText(/Which endpoint is this for\?/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Unread" })).toBeTruthy();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(document.querySelectorAll("textarea, form, input").length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(W.id) }));
    await waitFor(() => expect(window.location.hash).toBe(`#/p/payments/conversations/${W.id}`));
  });

  it("an older deep link (the openConversation preference) lands on the session", async () => {
    updatePrefs({ openConversation: W.id });
    showList([row()]);
    await waitFor(() => expect(window.location.hash).toBe(`#/p/payments/conversations/${W.id}`));
  });
});

describe("Work-order session", () => {
  it("makes it obvious the dialogue is open: the agent waits for you, the composer is always there, a suggested answer is one click", async () => {
    const calls = await showSession(session(), { [`POST /api/v1/work-orders/${W.id}/session/messages`]: () => ({ body: { ok: true, msg: "Saved." } }) });
    expect(await screen.findByText("Intake Clerk is waiting for you")).toBeTruthy();
    expect(screen.getByLabelText("Message to Intake Clerk")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Traveler" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "The belt" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "POST /refunds" }));
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/session/messages`)).toHaveLength(1));
    expect(posts(calls, `/api/v1/work-orders/${W.id}/session/messages`)[0]!.body).toMatchObject({ kind: "message", text: "POST /refunds" });
    // Free text on Enter.
    const box = screen.getByLabelText("Message to Intake Clerk");
    fireEvent.change(box, { target: { value: "gimme a brief" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/session/messages`)).toHaveLength(2));
    expect(posts(calls, `/api/v1/work-orders/${W.id}/session/messages`)[1]!.body).toMatchObject({ text: "gimme a brief" });
  });

  it("shows the agent's brief proposal with what changes; Approve runs the decision; Ask for changes continues the dialogue", async () => {
    const path = `/api/v1/work-orders/${W.id}/session/proposals/wm-2/P-1`;
    const calls = await showSession(withProposal(), { [`POST ${path}`]: () => ({ body: { ok: true, msg: "Brief confirmed." } }), [`POST /api/v1/work-orders/${W.id}/session/messages`]: () => ({ body: { ok: true, msg: "Saved." } }) });
    expect((await screen.findAllByText("Proposed brief")).length).toBeGreaterThan(0);
    expect(screen.getByText(`+ ${BRIEF.goal}`)).toBeTruthy();
    expect(screen.getByText("Waiting for you")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve and confirm the brief" }));
    await waitFor(() => expect(posts(calls, path)).toHaveLength(1));
    expect(posts(calls, path)[0]!.body).toEqual({ decision: "approve" });
    fireEvent.click(screen.getByRole("button", { name: "Ask for changes" }));
    fireEvent.change(await screen.findByLabelText("What should change?"), { target: { value: "Also cover retries." } });
    fireEvent.click(document.getElementById("wos-changes-send-P-1")!);
    await waitFor(() => expect(posts(calls, path)).toHaveLength(2));
    expect(posts(calls, path)[1]!.body).toEqual({ decision: "changes", text: "Also cover retries." });
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/session/messages`).some((c) => (c.body as { kind?: string }).kind === "continue")).toBe(true));
  });

  it("someone who may not confirm briefs sees Approve locked with the reason", async () => {
    const s = withProposal();
    s.can = { talk: true, talkWhy: "", confirm: false, confirmWhy: "Needs the right to confirm briefs." };
    await showSession(s);
    const btn = await screen.findByRole("button", { name: "Approve and confirm the brief" });
    expect((btn as HTMLButtonElement).disabled || btn.getAttribute("aria-disabled") === "true").toBe(true);
  });

  it("without a usable model it says 'Rule-based (no agent)', shows the scripted question with its chips, and still lets you answer", async () => {
    const s = session({ agent: { mode: "rule-based", name: "Intake Clerk", id: "ag-intake", reason: "No model is configured.", label: "Rule-based (no agent)", station: "intake" }, messages: [], ruleQuestion: { id: "scope", text: "What is in scope?", chips: ["Only the API"] } });
    const calls = await showSession(s, { [`POST /api/v1/work-orders/${W.id}/session/messages`]: () => ({ body: { ok: true, msg: "Answer recorded.", mode: "rule-based" } }) });
    expect((await screen.findAllByText("Rule-based (no agent)")).length).toBeGreaterThan(0);
    expect(screen.getByText("What is in scope?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Only the API" }));
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/session/messages`)).toHaveLength(1));
    expect((screen.getByLabelText("Message to Intake Clerk") as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("the agent starts the dialogue by itself when the session has none yet", async () => {
    const calls = await showSession(session({ messages: [] }), { [`POST /api/v1/work-orders/${W.id}/session/messages`]: () => ({ body: { ok: true, msg: "Saved." } }) });
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/session/messages`).some((c) => (c.body as { kind?: string }).kind === "open")).toBe(true));
  });
});

describe("Open conversation from the traveler", () => {
  function Opener() {
    const open = useOpenTraveler();
    return <button type="button" id="open-trv" onClick={() => open(W.id)}>open</button>;
  }
  it("shows a prominent button with the waiting indicator and lands on the work order's session", async () => {
    mockApi({ ...readsFor(W, travelerOf(W)), "GET /api/v1/work-order-sessions": () => ({ body: { items: [row()] } }) });
    mount(<Opener />);
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText("open"));
    const btn = await screen.findByRole("button", { name: "Open conversation" }, { timeout: 4000 });
    expect(await screen.findByText("Intake Clerk is waiting for you")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Unread messages" })).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => expect(window.location.hash).toBe(`#/p/payments/conversations/${W.id}`));
  });
});
