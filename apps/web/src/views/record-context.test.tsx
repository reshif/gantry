import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecordView from "./record";
import type { RecContext } from "./record/data";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { posts, readsFor, recordOf, travelerOf, waitingWo } from "./traveler/testkit";

beforeEach(() => resetApp());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const W = waitingWo;
const CTX: RecContext = {
  pin: { id: "ctx-1a2b3c4d5e", pinnedAt: "2026-11-19T09:00:00.000Z", base: 4, project: null, guidelines: { hash: "f".repeat(64), commit: "a".repeat(40) }, agents: { "ag-build": { version: 2, skills: {} } } },
  repins: [{ seq: 9, at: "2026-11-19T10:00:00.000Z", by: "p-meera", detail: { reason: "The rules changed.", trigger: "person" } }],
  runs: [{ run: "r-1", station: "spec", contextPin: "ctx-1a2b3c4d5e", seed: { commit: "b".repeat(40), source: "default_head", why: "Read from GitHub at dispatch." }, conventions: { state: "unavailable", reason: "the broker sent no readable repository context" }, proposedChanges: [{ path: "AGENTS.md", status: "changed" }], promptDrift: true }],
  notices: [
    { kind: "conventions_unavailable", run: "r-1", station: "spec", text: "The repository's convention files could not be read for the spec run (the broker sent no readable repository context). The agent was told so." },
    { kind: "prompt_drift", run: "r-1", station: "spec", text: "The prompt of the spec run changed after it was dispatched: what it ran with is not what was recorded at dispatch." },
  ],
};

async function show(context: RecContext | undefined, extra: Parameters<typeof mockApi>[0] = {}, o: Parameters<typeof mockApi>[1] = {}) {
  const calls = mockApi({ ...readsFor(W, travelerOf(W), recordOf(W, context ? { context } : {})), ...extra }, o);
  window.location.hash = `#record/${W.id}?full=1`;
  mount(<RecordView />);
  await screen.findByText("Completeness", {}, { timeout: 4000 });
  return calls;
}

describe("Record: the instructions a work order runs on", () => {
  it("shows the pinned context, the notices for an unreadable convention read and a drifted prompt, and what each run was given", async () => {
    await show(CTX);
    expect(await screen.findByText(/Instructions this work order runs on: ctx-1a2b3c4d5e/)).toBeTruthy();
    expect(screen.getByText("v4")).toBeTruthy();
    expect(screen.getByText(/convention files could not be read for the spec run/)).toBeTruthy();
    expect(screen.getByText(/changed after it was dispatched/)).toBeTruthy();
    expect(screen.getByText(/refreshed by .*The rules changed\./)).toBeTruthy();
    fireEvent.click(screen.getByText(/What each run was given/));
    expect(await screen.findByText(/This work order proposes changes to AGENTS.md \(not the maintainers' text\)/)).toBeTruthy();
  });

  it("Refresh instructions posts to the work order with its version, and shows nothing when the server sends no context", async () => {
    const calls = await show(CTX, { [`POST /api/v1/work-orders/${W.id}/refresh-context`]: () => ({ body: { ok: true, msg: `${W.id} now runs on instructions ctx-2.` } }) });
    const btn = await waitFor(() => document.getElementById("rec-ctx-refresh") as HTMLElement);
    fireEvent.click(btn);
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/refresh-context`)).toHaveLength(1));
    expect(posts(calls, `/api/v1/work-orders/${W.id}/refresh-context`)[0]!.headers["if-match"]).toBe("7");
    cleanup();
    await show(undefined);
    expect(screen.queryByText(/Instructions this work order runs on/)).toBeNull();
  });

  it("locks Refresh instructions for someone who may not send work back, and sends nothing", async () => {
    const calls = await show(CTX, {}, { denied: ["wo.sendback"] });
    const btn = await waitFor(() => document.getElementById("rec-ctx-refresh") as HTMLElement);
    await waitFor(() => expect(btn.getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(btn);
    expect(posts(calls, `/api/v1/work-orders/${W.id}/refresh-context`)).toHaveLength(0);
  });
});
