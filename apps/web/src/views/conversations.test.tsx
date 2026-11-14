import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkOrder } from "@gantry/domain";
import ConversationsView from "./conversations";
import { updatePrefs } from "../lib/prefs";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { deny, intakeWo, posts, readsFor, travelerOf } from "./traveler/testkit";

beforeEach(() => {
  resetApp();
  updatePrefs({ project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** An intake conversation with a pending question, chips and a brief that is not complete yet. */
const W = {
  ...intakeWo,
  conv: {
    ...intakeWo.conv,
    done: false,
    qi: 0,
    raised: [],
    questions: [{ id: "scope", field: "scope", text: "What is in scope?", chips: ["Only the API", "API and clients"] }, { id: "ac", field: "ac", text: "How do we know it is done?", chips: [] }],
    messages: [{ from: "ag-intake", at: intakeWo.createdAt, text: "What is in scope?", qid: "scope", chips: ["Only the API", "API and clients"] }],
  },
  gates: { ...intakeWo.gates, G0G1: { ...intakeWo.gates.G0G1!, status: "waiting" as const } },
} as WorkOrder;
const READY = { ...W, conv: { ...W.conv, done: true, qi: 2 } } as WorkOrder;

async function show(wo: WorkOrder = W, o: Parameters<typeof mockApi>[1] = {}, t = travelerOf(wo, {}, { approve: { gate: "G0G1" } }), extra: Parameters<typeof mockApi>[0] = {}) {
  const calls = mockApi({ ...readsFor(wo, t), "GET /api/v1/conversations": (c) => ({ body: { items: c.query.get("awaitingMe") ? [wo] : [wo], next: null, total: 1 } }), ...extra }, o);
  mount(<ConversationsView />);
  await screen.findByRole("region", { name: `Conversation ${wo.id}` }, { timeout: 4000 });
  return calls;
}

describe("Conversations", () => {
  it("lists the project's conversations with their status and shows the thread, class and live brief", async () => {
    await show();
    expect((await screen.findAllByText(W.id)).length).toBeGreaterThan(0);
    expect(screen.getByText("Question 1 of 2", { selector: ".conv-item-foot span" })).toBeTruthy();
    expect(screen.getByText("Brief · built live")).toBeTruthy();
    expect(screen.getByText("Class")).toBeTruthy();
  });

  it("answers with a quick-reply chip and with free text on Enter", async () => {
    const path = `/api/v1/work-orders/${W.id}/messages`;
    const calls = await show(W, {}, undefined, { [`POST ${path}`]: () => ({ body: { ok: true, msg: "Answer recorded." } }) });
    fireEvent.click(await screen.findByRole("button", { name: "Only the API" }));
    await waitFor(() => expect(posts(calls, path)).toHaveLength(1));
    expect(posts(calls, path)[0]!.body).toMatchObject({ text: "Only the API" });
    const box = screen.getByLabelText("Reply");
    fireEvent.change(box, { target: { value: "It must stay compatible." } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(posts(calls, path)).toHaveLength(2));
    expect(posts(calls, path)[1]!.body).toMatchObject({ text: "It must stay compatible." });
    // an empty reply is not sent
    fireEvent.keyDown(box, { key: "Enter" });
    expect(posts(calls, path)).toHaveLength(2);
  });

  it("locks the reply and the chips with the reason when the viewer may not answer", async () => {
    const t = travelerOf({ ...W, requestedBy: "someone-else" } as WorkOrder, {}, { can: { answer: deny("No role holds it.", "Needs Engineer") } });
    const calls = await show({ ...W, requestedBy: "someone-else" } as WorkOrder, {}, t);
    expect(((await screen.findByLabelText("Reply")) as HTMLTextAreaElement).disabled).toBe(true);
    const chip = await screen.findByRole("button", { name: "Only the API" });
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(chip);
    expect(calls.filter((c) => c.method === "POST" && c.path !== "/api/v1/can")).toHaveLength(0);
  });

  it("adds a follow-up question with up to three suggested answers", async () => {
    const path = `/api/v1/work-orders/${W.id}/messages`;
    const calls = await show(W, {}, undefined, { [`POST ${path}`]: () => ({ body: { ok: true, msg: "Follow-up added." } }) });
    fireEvent.click(await screen.findByRole("button", { name: /Add a follow-up question/ }));
    fireEvent.click(document.getElementById(`conv-fu-ask-${W.id}`) as HTMLElement);
    expect(posts(calls, path)).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Follow-up question"), { target: { value: "Who signs off?" } });
    fireEvent.change(screen.getByLabelText("Suggested answers"), { target: { value: "Nobody; Security; On-call; Extra" } });
    fireEvent.click(document.getElementById(`conv-fu-ask-${W.id}`) as HTMLElement);
    await waitFor(() => expect(posts(calls, path)).toHaveLength(1));
    expect(posts(calls, path)[0]!.body).toMatchObject({ kind: "followup", text: "Who signs off?", chips: ["Nobody", "Security", "On-call"] });
  });

  it("raises a question to a person with a reason of at least five characters", async () => {
    const path = `/api/v1/work-orders/${W.id}/messages`;
    const calls = await show(W, {}, undefined, { [`POST ${path}`]: () => ({ body: { ok: true, msg: "Question raised." } }) });
    fireEvent.click(await screen.findByRole("button", { name: "Raise a question" }));
    const ta = await screen.findByPlaceholderText("What do you need a person to decide?");
    fireEvent.change(ta, { target: { value: "hm" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Raise question" }).at(-1) as HTMLElement);
    expect(posts(calls, path)).toHaveLength(0);
    fireEvent.change(ta, { target: { value: "Which team owns the ledger?" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Raise question" }).at(-1) as HTMLElement);
    await waitFor(() => expect(posts(calls, path)).toHaveLength(1));
    expect(posts(calls, path)[0]!.body).toMatchObject({ kind: "question", text: "Which team owns the ledger?" });
  });

  it("confirms the brief once it is complete, with the version in If-Match, and not before", async () => {
    const path = `/api/v1/work-orders/${W.id}/confirm-brief`;
    const calls = await show(READY, {}, undefined, { [`POST ${path}`]: () => ({ body: { ok: true, msg: "Brief confirmed." } }) });
    const btn = await screen.findByRole("button", { name: "Confirm brief" });
    expect(btn.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(posts(calls, path)).toHaveLength(1));
    expect(posts(calls, path)[0]!.headers["if-match"]).toBe("7");
    cleanup();
    vi.unstubAllGlobals();
    await show(W);
    const early = await screen.findByRole("button", { name: "Confirm brief" });
    expect(early.getAttribute("aria-disabled")).toBe("true");
    expect(early.getAttribute("data-reason")).toContain("Answer the 2 open questions first");
  });

  it("declines with a reason and shows a stale refusal", async () => {
    const path = `/api/v1/work-orders/${W.id}/decline`;
    const calls = await show(W, {}, undefined, { [`POST ${path}`]: () => ({ status: 409, body: { ok: false, msg: `${W.id} changed since you opened it.` } }) });
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    const ta = await screen.findByPlaceholderText("For example: duplicate of WO-2398.");
    fireEvent.change(ta, { target: { value: "Duplicate of WO-2398." } });
    fireEvent.click(screen.getAllByRole("button", { name: "Decline work order" }).at(-1) as HTMLElement);
    await waitFor(() => expect(posts(calls, path)).toHaveLength(1));
    expect(await screen.findByText(/changed since you opened it/)).toBeTruthy();
  });

  it("locks every action while a stop covers the work order", async () => {
    const t = travelerOf(READY, { stop: { id: "project:payments:1", scope: "project", mode: "kill", reason: "Kill: bad release" } }, { approve: { gate: "G0G1" } });
    const calls = await show(READY, {}, t);
    for (const name of ["Confirm brief", "Decline", "Raise a question", "Send"]) {
      const b = await screen.findByRole("button", { name });
      expect(b.getAttribute("aria-disabled")).toBe("true");
      expect(b.getAttribute("data-reason")).toContain("Kill: bad release");
    }
    expect(calls.filter((c) => c.method === "POST" && c.path !== "/api/v1/can")).toHaveLength(0);
  });

  it("opens the class override from the thread", async () => {
    await show();
    fireEvent.click(await screen.findByRole("button", { name: "Change class" }));
    expect(await screen.findByText(new RegExp(`Change the class of ${W.id}`))).toBeTruthy();
  });
});
