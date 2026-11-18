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
  window.history.replaceState(null, "", "/");
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
  next: { actor: "you", text: "Answer the agent's question (click a suggestion or write your own)." }, waiting: null, pending: [], dialogue: { questions: [], assumptions: [], objections: [], askedMe: false }, swarm: null, documents: [], research: { plan: null, allowList: [], canDecide: false, canApproveUnlisted: false }, sources: [],
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
async function showSession(s: WoSession, extra: Parameters<typeof mockApi>[0] = {}, open = true) {
  window.location.hash = `#/p/payments/conversations/${W.id}`;
  const calls = mockApi({ ...readsFor(W), [`GET /api/v1/work-orders/${W.id}/session`]: () => ({ body: s }), [`POST /api/v1/work-orders/${W.id}/session/seen`]: () => ({ body: { ok: true, msg: "Seen." } }), ...extra });
  mount(<ConversationsView />);
  await screen.findByRole("region", { name: `Conversation ${W.id}` }, { timeout: 4000 });
  // the brief, gate and proposals panel is folded under the Details button; most tests read it
  if (open) fireEvent.click(document.getElementById("wos-details")!);
  return calls;
}

describe("Conversations list", () => {
  it("says the conversations are not visible on a 403", async () => {
    mockApi({ ...readsFor(W), "GET /api/v1/work-order-sessions": () => ({ status: 403, body: { ok: false, msg: "Needs a role on this project." } }) });
    mount(<ConversationsView />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
    expect(screen.queryByText("Nothing waits on you")).toBeNull();
  });

  it("lists work-order sessions with who waits on whom and the latest message; a row opens that work order's session beside the list", async () => {
    showList([row(), row({ id: "WO-9", title: "Other", waitingOn: "agent", unread: false, latest: null, started: false })]);
    expect(await screen.findByRole("img", { name: "Unread" })).toBeTruthy();
    // the prototype row has two lines: no third "Waiting on you" line, no Waiting / Open / Closed tabs, no New work order button
    expect(screen.queryByText("Waiting on you")).toBeNull();
    expect(screen.queryByRole("tab", { name: /Waiting on me/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "New work order" })).toBeNull();
    expect(document.querySelector(".conv .conv-list")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: new RegExp(W.id) }));
    // the row names the conversation in ?c= (the prototype's URL), as the prototype's rows do
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("c")).toBe(W.id));
  });

  it("the thread has no status bar while the agent just works, and keeps brief, gate and proposals behind a Details button in the header", async () => {
    await showSession(session({ next: { actor: "agent", text: "Spec Writer is working." } }), {}, false);
    expect(document.getElementById("wos-status")).toBeNull();
    expect(document.getElementById("wos-more")).toBeNull();
    fireEvent.click(document.getElementById("wos-details")!);
    expect(document.getElementById("wos-more")).toBeTruthy();
  });

  it("an older deep link (the openConversation preference) lands on the session", async () => {
    updatePrefs({ openConversation: W.id });
    showList([row()]);
    await waitFor(() => expect(window.location.hash).toBe(`#/p/payments/conversations/${W.id}`));
  });
});

describe("Conversations URL state (prototype ?c= and ?q=)", () => {
  it("opens the conversation named by ?c= and keeps the search in ?q=", async () => {
    window.history.replaceState(null, "", `/?c=${W.id}`);
    const calls = mockApi({ ...readsFor(W), "GET /api/v1/work-order-sessions": () => ({ body: { items: [row(), row({ id: "WO-9", title: "Other thing", started: false, latest: null })] } }), [`GET /api/v1/work-orders/${W.id}/session`]: () => ({ body: session() }), [`POST /api/v1/work-orders/${W.id}/session/seen`]: () => ({ body: { ok: true, msg: "Seen." } }) });
    mount(<ConversationsView />);
    expect(await screen.findByRole("region", { name: `Conversation ${W.id}` }, { timeout: 4000 })).toBeTruthy();
    expect(calls.some((c) => c.path === `/api/v1/work-orders/${W.id}/session`)).toBe(true);
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "other" } });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("q")).toBe("other"));
    expect(screen.queryByText(row().title)).toBeNull();
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "zzz" } });
    expect(await screen.findByText("No conversations")).toBeTruthy();
    expect(document.querySelector(".conv-list .empty p")?.textContent ?? "").toBe("");
  });
});

describe("Work-order session", () => {
  it("makes it obvious the dialogue is open: the agent waits for you, the composer is always there, a suggested answer is one click", async () => {
    const calls = await showSession(session(), { [`POST /api/v1/work-orders/${W.id}/session/messages`]: () => ({ body: { ok: true, msg: "Saved." } }) });
    expect(await screen.findByText("Intake Clerk is waiting for you")).toBeTruthy();
    expect(screen.getByLabelText("Message")).toBeTruthy();
    // the prototype thread header: the work order id links to the record, Back is for narrow screens
    expect((document.getElementById("wos-record") as HTMLAnchorElement).getAttribute("href")).toMatch(/\/record\/WO-2398$/);
    expect(document.getElementById("wos-back")).toBeTruthy();
    expect(screen.getByRole("list", { name: "The belt" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "POST /refunds" }));
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/session/messages`)).toHaveLength(1));
    expect(posts(calls, `/api/v1/work-orders/${W.id}/session/messages`)[0]!.body).toMatchObject({ kind: "message", text: "POST /refunds" });
    // Free text on Enter.
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "gimme a brief" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/session/messages`)).toHaveLength(2));
    expect(posts(calls, `/api/v1/work-orders/${W.id}/session/messages`)[1]!.body).toMatchObject({ text: "gimme a brief" });
  });

  it("@ offers people by name, says who cannot open the project, and sends only the people still named; a mention that gave no access is noted under the message", async () => {
    const calls = await showSession(
      session({ messages: [...session().messages, { id: "wm-9", role: "user", author: "p-tomas", text: "@Lena Okafor please look", at: Date.now(), data: { mentions: [{ id: "p-lena", name: "Lena Okafor", access: false }] } }] }),
      {
        [`GET /api/v1/work-orders/${W.id}/session/people`]: () => ({ body: { people: [{ id: "p-lena", name: "Lena Okafor", title: "Designer", access: false }, { id: "p-rui", name: "Lena Rui", title: "", access: true }] } }),
        [`POST /api/v1/work-orders/${W.id}/session/messages`]: () => ({ body: { ok: true, msg: "Saved." } }),
      },
    );
    expect(await screen.findByText(/Lena Okafor cannot open this project yet\. Mentioning them did not give them access/)).toBeTruthy();
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "hey @Len", selectionStart: 8 } });
    const list = await screen.findByRole("listbox", { name: "People to mention" });
    expect(list.textContent).toMatch(/cannot open this project yet/);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("hey @Lena Okafor "));
    expect(posts(calls, `/api/v1/work-orders/${W.id}/session/messages`)).toHaveLength(0);
    fireEvent.change(box, { target: { value: "hey @Lena Okafor can you check?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/session/messages`)).toHaveLength(1));
    expect(posts(calls, `/api/v1/work-orders/${W.id}/session/messages`)[0]!.body).toMatchObject({ kind: "message", text: "hey @Lena Okafor can you check?", mentions: ["p-lena"] });
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
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(false);
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

describe("Station questions, assumptions and documents in the session", () => {
  const q = (over: Record<string, unknown> = {}) => ({ id: "Q-AT1-1", station: "research", attemptId: "AT1", askedBy: "ag-research", question: "Which currency should refunds use?", why: "Rounding differs per currency.", options: ["EUR", "USD"], blocking: true, askOf: "requester", status: "open" as const, answer: null, answerKind: null, answeredBy: null, answeredAt: null, createdAt: Date.now() - 1000, mine: true, ...over });
  const asked = (over: Partial<WoSession> = {}) => session({
    wo: { ...session().wo, station: "research", stationName: "Research", bay: "person", gate: null },
    messages: [{ id: "wm-st", role: "assistant", author: "ag-research", text: "Research needs an answer before going on.", at: Date.now(), data: { kind: "station", mode: "agent", agent: "ag-research", cards: [{ kind: "document", id: "art-1", name: "research.md", version: 1 }, { kind: "station_question", id: "Q-AT1-1" }, { kind: "assumptions", station: "research", attempt: "AT1", count: 1 }] } as never }],
    next: { actor: "you", text: "Research is waiting for your answer below." }, waiting: { text: "Waiting for you: 1 question from Research", kind: "you" },
    swarm: null, dialogue: { objections: [], questions: [q()], assumptions: [{ id: "A-AT1-1", station: "research", attemptId: "AT1", madeBy: "ag-research", statement: "Refunds are always full refunds", because: "The request says refund the order.", impact: "high", status: "open", note: null, decidedBy: null, decidedAt: null, createdAt: Date.now() }], askedMe: true },
    documents: [{ id: "art-1", doc: "research.md", station: "research", version: 1, supersedes: null, authorKind: "agent", authorId: "ag-research", attemptId: "AT1", size: 10, contentHash: "a".repeat(64), createdAt: Date.now(), acceptedBy: null }],
    ...over,
  });

  it("the person asked answers with a suggestion; the status line says the station waits for them", async () => {
    const calls = await showSession(asked(), { [`POST /api/v1/work-orders/${W.id}/questions/Q-AT1-1/answer`]: () => ({ body: { ok: true, msg: "Answer recorded; Research runs again with it.", resumed: true } }) });
    expect(document.getElementById("wos-status")!.textContent).toContain("Research is waiting for your answer below.");
    expect(screen.getByText("Why it matters:")).toBeTruthy();
    expect(screen.getByText(/Research asks the requester \(you\)/)).toBeTruthy();
    expect(document.querySelector("#wos-asks")?.textContent).toContain("asks you");
    fireEvent.click(screen.getByRole("button", { name: "EUR" }));
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/questions/Q-AT1-1/answer`)).toHaveLength(1));
    expect(posts(calls, `/api/v1/work-orders/${W.id}/questions/Q-AT1-1/answer`)[0]!.body).toEqual({ kind: "answer", answer: "EUR" });
  });

  it("someone else sees whom it waits on; an answered question shows who answered", async () => {
    await showSession(asked({ next: { actor: "person", text: "Research is waiting for an answer from the requester." }, dialogue: { questions: [q({ status: "answered", answer: "EUR", answerKind: "answer", answeredBy: "p-tomas", answeredAt: Date.now(), mine: false })], assumptions: [], objections: [], askedMe: false } }));
    expect(document.getElementById("wos-status")!.textContent).toContain("Research is waiting for an answer from the requester.");
    const card = document.querySelector("#sq-Q-AT1-1")!;
    expect(card.textContent).toContain("Answered");
    expect(card.textContent).toContain("EUR");
    expect(card.querySelector("textarea")).toBeNull();
  });

  it("an assumption can be corrected, and the correction needs words", async () => {
    const calls = await showSession(asked(), { [`POST /api/v1/work-orders/${W.id}/assumptions/A-AT1-1`]: () => ({ body: { ok: true, msg: "Correction recorded; later stations work from it." } }) });
    expect(screen.getByText("Refunds are always full refunds", { selector: ".as-statement" })).toBeTruthy();
    fireEvent.click(document.getElementById("as-A-AT1-1-fix")!);
    const save = document.getElementById("as-A-AT1-1-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(document.getElementById("as-A-AT1-1-note")!, { target: { value: "Partial refunds too." } });
    fireEvent.click(save);
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/assumptions/A-AT1-1`)[0]?.body).toEqual({ status: "corrected", note: "Partial refunds too." }));
  });

  it("a document card opens the viewer: outline, versions, and the change against the previous version", async () => {
    const v1 = { id: "art-1", doc: "research.md", station: "research", version: 1, supersedes: null, authorKind: "agent", authorId: "ag-research", attemptId: "AT1", size: 10, contentHash: "a".repeat(64), createdAt: Date.now() - 5000, acceptedBy: null };
    const v2 = { ...v1, id: "art-2", version: 2, supersedes: "art-1", attemptId: "AT2", createdAt: Date.now() };
    await showSession(asked(), {
      [`GET /api/v1/work-orders/${W.id}/documents`]: () => ({ body: { items: [v1, v2] } }),
      [`GET /api/v1/work-orders/${W.id}/documents/art-1`]: () => ({ body: { ...v1, body: "# Research\n\n## Findings\n\nRetry lives in sync.py.\n" } }),
      [`GET /api/v1/work-orders/${W.id}/documents/art-2`]: () => ({ body: { ...v2, body: "# Research\n\n## Findings\n\nRetry lives in jobs/sync.py.\n\n## Sources\n\n| File | Lines |\n|---|---|\n| jobs/sync.py | 15-34 |\n" } }),
    });
    fireEvent.click(document.getElementById("wos-doc-art-1")!);
    expect(await screen.findByText(/Version 1 · written by/)).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("Version"), { target: { value: "art-2" } });
    expect(await screen.findByRole("columnheader", { name: "File" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "On this page" }).textContent).toContain("Sources");
    fireEvent.click(screen.getByRole("button", { name: "Compare with v1" }));
    const diff = await screen.findByLabelText("Changes since version 1");
    expect(diff.querySelector(".doc-dl.is-del")?.textContent).toContain("Retry lives in sync.py.");
    expect(diff.querySelector(".doc-dl.is-add")?.textContent).toContain("Retry lives in jobs/sync.py.");
  });

  const v1 = { id: "art-1", doc: "research.md", station: "research", version: 1, supersedes: null, authorKind: "agent", authorId: "ag-research", attemptId: "AT1", size: 10, contentHash: "a".repeat(64), createdAt: Date.now() - 5000, acceptedBy: null };
  const text = "# Research\n\n## Findings\n\nRetry lives in sync.py.\n";

  it("comment on a section, edit the newest version, accept it as the station output", async () => {
    const ok = (msg: string, extra: object = {}) => () => ({ body: { ok: true, msg, ...extra } });
    const calls = await showSession(asked(), {
      [`GET /api/v1/work-orders/${W.id}/documents`]: () => ({ body: { items: [v1] } }),
      [`GET /api/v1/work-orders/${W.id}/documents/art-1`]: () => ({ body: { ...v1, body: text } }),
      [`GET /api/v1/work-orders/${W.id}/document-comments`]: () => ({ body: { items: [{ id: "DC-1", artefactId: "art-1", doc: "research.md", version: 1, section: "Findings", body: "Name the file.", author: "p-tomas", status: "open", resolvedBy: null, resolvedAt: null, createdAt: Date.now() }] } }),
      [`POST /api/v1/work-orders/${W.id}/documents/art-1/comments`]: ok("Comment added."),
      [`POST /api/v1/work-orders/${W.id}/documents/art-1/edit`]: ok("Saved as version 2.", { id: "art-2" }),
      [`POST /api/v1/work-orders/${W.id}/documents/art-1/accept`]: ok("Version 1 of research.md is accepted as the station output."),
      [`POST /api/v1/work-orders/${W.id}/document-comments/DC-1/resolve`]: ok("Comment resolved."),
    });
    fireEvent.click(document.getElementById("wos-doc-art-1")!);
    expect(await screen.findByText("Name the file.")).toBeTruthy();
    expect(await screen.findByText("Retry lives in sync.py.")).toBeTruthy();
    // comment on a section of the document
    const add = document.getElementById("doc-comment-add") as HTMLButtonElement;
    expect(add.getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(document.getElementById("doc-comment-section")!, { target: { value: "Findings" } });
    fireEvent.change(document.getElementById("doc-comment-text")!, { target: { value: "Which module?" } });
    fireEvent.click(add);
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/documents/art-1/comments`)[0]?.body).toEqual({ text: "Which module?", section: "Findings" }));
    fireEvent.click(document.getElementById("doc-comment-resolve-DC-1")!);
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/document-comments/DC-1/resolve`)).toHaveLength(1));
    // edit
    fireEvent.click(document.getElementById("doc-edit")!);
    const save = document.getElementById("doc-edit-save") as HTMLButtonElement;
    expect(save.getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(document.getElementById("doc-edit-text")!, { target: { value: `${text}\nIt is in jobs/sync.py.\n` } });
    fireEvent.click(save);
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/documents/art-1/edit`)[0]?.body).toEqual({ markdown: `${text}\nIt is in jobs/sync.py.\n` }));
    // accept
    fireEvent.click(document.getElementById("doc-accept")!);
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/documents/art-1/accept`)).toHaveLength(1));
  });
});

describe("Research plan and sources", () => {
  const plan = { status: "proposed" as const, questions: ["How do Nautobot jobs retry?"], hosts: ["docs.nautobot.com", "blog.example.org"], web: true, budgetUsd: 3, why: "No retry helper in the repo.", station: "research", attempt: "AT1", proposedAt: Date.now() };
  const withPlan = (canApproveUnlisted: boolean) => session({
    wo: { ...session().wo, station: "research", stationName: "Research", bay: "person", gate: null },
    messages: [{ id: "wm-p", role: "assistant", author: "ag-research", text: "Research is waiting for the research plan to be approved.", at: Date.now(), data: { kind: "station", mode: "agent", cards: [{ kind: "research_plan", station: "research" }] } as never }],
    research: { plan, allowList: ["docs.nautobot.com"], canDecide: true, canApproveUnlisted },
  });

  it("an approver without security rights cannot approve an unlisted host, untick it and approve the rest", async () => {
    const calls = await showSession(withPlan(false), { [`POST /api/v1/work-orders/${W.id}/research-plan`]: () => ({ body: { ok: true, msg: "Plan approved; Research runs again.", resumed: true } }) });
    expect(document.getElementById("rp-card")!.textContent).toContain("needs someone who manages security");
    const approve = document.getElementById("rp-approve") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /blog\.example\.org/ }));
    expect(approve.disabled).toBe(false);
    fireEvent.change(document.getElementById("rp-budget")!, { target: { value: "2" } });
    fireEvent.click(approve);
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/research-plan`)[0]?.body).toEqual({ decision: "approve", web: true, hosts: ["docs.nautobot.com"], budgetUsd: 2 }));
    expect((document.getElementById("rp-reject") as HTMLButtonElement).disabled).toBe(true);
  });

  it("citations in a document open the source with what the agent saw", async () => {
    const v1 = { id: "art-9", doc: "research.md", station: "research", version: 1, supersedes: null, authorKind: "agent", authorId: "ag-research", attemptId: "AT2", size: 10, contentHash: "c".repeat(64), createdAt: Date.now(), acceptedBy: null };
    const src = { id: "SRC-1", ref: "s1", kind: "web", station: "research", attemptId: "AT2", fetchedBy: "ag-research", url: "https://docs.nautobot.com/jobs", finalUrl: "https://docs.nautobot.com/jobs", host: "docs.nautobot.com", title: "Jobs", httpStatus: 200, contentType: "text/html", contentHash: "d".repeat(64), size: 120, truncated: false, why: "retry guidance", fetchedAt: Date.now() };
    await showSession(withPlan(true), {
      [`GET /api/v1/work-orders/${W.id}/documents`]: () => ({ body: { items: [v1] } }),
      [`GET /api/v1/work-orders/${W.id}/documents/art-9`]: () => ({ body: { ...v1, body: "# Research\n\nJobs retry via the scheduler.[^s1]\n" } }),
      [`GET /api/v1/work-orders/${W.id}/sources`]: () => ({ body: { items: [src] } }),
      [`GET /api/v1/work-orders/${W.id}/sources/s1`]: () => ({ body: { ...src, excerpt: "Jobs can be scheduled and retried." } }),
    });
    const { DocViewer } = await import("./documents/DocViewer");
    const { mount: m2 } = await import("./floor/testkit");
    m2(<DocViewer woId={W.id} />);
    fireEvent.click(await screen.findByRole("button", { name: "Source s1" }, { timeout: 3000 }));
    expect(await screen.findByText("Jobs")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show what the agent saw" }));
    expect(screen.getByLabelText("Text the agent read").textContent).toBe("Jobs can be scheduled and retried.");
  });
});

describe("Run timeline", () => {
  it("shows the live run's steps, pages and cost, and polls only while it works", async () => {
    const { RunTimelineView } = await import("./documents/Timeline");
    const { mount: m2, mockApi: mk } = await import("./floor/testkit");
    const now = Date.now();
    mk({ ...readsFor(W), [`GET /api/v1/work-orders/${W.id}/timeline`]: () => ({ body: { runs: [{ runId: "r1", attemptId: "a1", station: "research", state: "running", startedAt: now - 9000, endedAt: null, turn: 4, model: "claude-x", calls: 3, tokens: 1200, costUsd: 0.04, entries: [
      { at: now - 9000, kind: "start", text: "Run started on claude-x" },
      { at: now - 8000, kind: "step", turn: 1, tool: "Read", detail: "src/jobs.py" },
      { at: now - 7000, kind: "source", ref: "s1", url: "https://docs.nautobot.com/x", title: "Jobs" },
      { at: now - 6000, kind: "step", turn: 2, tool: "gantry:write_document", detail: "research.md" },
    ] }] } }) });
    m2(<RunTimelineView woId={W.id} />);
    const run = await screen.findByRole("region", { name: "Research run" }, { timeout: 3000 });
    expect(run.textContent).toContain("Working · turn 4");
    expect(run.textContent).toContain("3 model calls");
    expect(run.textContent).toContain("src/jobs.py");
    expect(run.textContent).toContain("Wrote document");
    expect(run.querySelector(".md-cite")?.textContent).toBe("s1");
  });
});

describe("Scouts and objections", () => {
  const sw = { station: "research", parent: "AT1", startedAt: Date.now() - 60_000, scouts: [
    { id: "A", attempt: "AT2", question: "Where is retry implemented?", focus: "repo" as const, state: "running" as const, turn: 3, costUsd: 0.05 },
    { id: "B", attempt: "AT3", question: "What do the docs say?", focus: "web" as const, state: "done" as const, summary: "Retries must be coded.", turn: null, costUsd: 0.08 },
  ] };
  const ob = { id: "O-AT9-1", station: "spec", attemptId: "AT9", raisedBy: "ag-spec", targetDoc: "research.md", targetStation: "research", section: "Findings", claim: "Jobs retry by default", reason: "The cited page says retries must be coded explicitly.", severity: "high" as const, status: "open" as const, note: null, decidedBy: null, decidedAt: null, createdAt: Date.now() };
  const withBoard = (park: boolean) => session({
    wo: { ...session().wo, station: "spec", stationName: "Spec", gate: { id: "G2", label: "G2", name: "Spec approved" } },
    can: { talk: true, talkWhy: "", confirm: true, confirmWhy: "", park, parkWhy: park ? "" : "Needs a role that may park work." },
    messages: [
      { id: "wm-s", role: "assistant", author: "ag-research", text: "Research sent 2 scouts.", at: Date.now(), data: { kind: "station", mode: "agent", cards: [{ kind: "swarm", station: "research" }] } as never },
      { id: "wm-o", role: "assistant", author: "ag-spec", text: "Spec finished.", at: Date.now(), data: { kind: "station", mode: "agent", cards: [{ kind: "objection", id: ob.id }] } as never },
    ],
    swarm: sw, dialogue: { questions: [], assumptions: [], objections: [ob], askedMe: false },
    research: { plan: null, allowList: [], canDecide: true, canApproveUnlisted: false },
  });

  it("the board shows each scout and stops a live one after confirming", async () => {
    const calls = await showSession(withBoard(true), { [`POST /api/v1/work-orders/${W.id}/scouts/A/stop`]: () => ({ body: { ok: true, msg: "Scout A stopped." } }) });
    const board = document.getElementById("sw-board")!;
    expect(board.textContent).toContain("1 working");
    expect(document.getElementById("sw-A")!.textContent).toContain("Repository · Working · turn 3");
    expect(document.getElementById("sw-B")!.textContent).toContain("Retries must be coded.");
    expect(document.getElementById("sw-stop-B")).toBeNull();
    fireEvent.click(document.getElementById("sw-stop-A")!);
    fireEvent.click(await screen.findByRole("button", { name: "Stop scout" }));
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/scouts/A/stop`)).toHaveLength(1));
  });

  it("without the right, Stop is locked with the reason", async () => {
    await showSession(withBoard(false));
    expect((document.getElementById("sw-stop-A") as HTMLButtonElement).disabled).toBe(true);
  });

  it("an objection needs a reason to decide, and the gate shows what is still open", async () => {
    const calls = await showSession(withBoard(true), { [`POST /api/v1/work-orders/${W.id}/objections/${ob.id}`]: () => ({ body: { ok: true, msg: "Objection upheld." } }) });
    expect(document.getElementById("gate-notes")!.textContent).toContain("1 objection not decided");
    const up = document.getElementById("ob-O-AT9-1-up") as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Research is right" })).toBeTruthy();
    fireEvent.change(document.getElementById("ob-O-AT9-1-note")!, { target: { value: "The docs are explicit." } });
    fireEvent.click(up);
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/objections/${ob.id}`)[0]?.body).toEqual({ decision: "upheld", note: "The docs are explicit." }));
  });
});
