import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecordView from "./record";
import TravelerPage from "./traveler/Page";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { readsFor, travelerOf, waitingWo } from "./traveler/testkit";

beforeEach(() => resetApp());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const W = waitingWo;
const gate = Object.entries(W.gates).find(([, g]) => g.status === "waiting")?.[0] ?? "G2";
const HASH = "0".repeat(64);

const approvers = {
  gate, label: gate, name: "Gate", rule: { text: "Needs 1 approval from Line Lead", required: 1, base: 1, sod: true, roles: [], people: [], conditions: [] },
  progress: { have: 1, need: 1, approvals: [{ id: "p-daniel", name: "Daniel Okafor" }], unmet: [], onlyRequester: false }, eligible: [{ id: "p-daniel", name: "Daniel Okafor", why: "Approver rule allows Line Lead.", away: false, oncall: false }],
  overrides: [], satisfiable: true, warning: "", viewerCanOverride: false, can: { editRule: false, editWhy: "", grantRole: false, grantWhy: "" },
};
const dialogue = { questions: [], assumptions: [{ id: "a1", station: "spec", attemptId: null, madeBy: "agent", statement: "The ledger already stores minor units", because: "the schema says so", impact: "high", status: "open", note: null, decidedBy: null, decidedAt: null, createdAt: 1 }], objections: [{ id: "o1", station: "design", attemptId: null, raisedBy: "agent", targetDoc: "spec.md", targetStation: "spec", section: "1", claim: "The spec skips refunds", reason: "refunds touch the same table", severity: "medium", status: "open", note: null, decidedBy: null, decidedAt: null, createdAt: 1 }] };

async function show(extra: Parameters<typeof mockApi>[0] = {}) {
  const t = travelerOf(W);
  t.gateProgress[gate] = { have: 1, need: 1, unmet: [], conds: [], onlyRequester: false, passes: false };
  const calls = mockApi({
    ...readsFor(W, t),
    [`GET /api/v1/work-orders/${W.id}/gates/${gate}/approvers`]: () => ({ body: approvers }),
    [`GET /api/v1/work-orders/${W.id}/dialogue`]: () => ({ body: dialogue }),
    ...extra,
  });
  window.location.hash = `#record/${W.id}`;
  mount(<RecordView />);
  await screen.findByRole("toolbar", { name: "Work order actions" }, { timeout: 4000 });
  return calls;
}

describe("Gates tab", () => {
  it("shows the approvals count, the approver rule and the open assumptions and objections for the waiting gate", async () => {
    await show();
    fireEvent.click(screen.getByRole("tab", { name: /^Gates/ }));
    await screen.findByText("Needs 1 approval from Line Lead");
    expect(document.getElementById(`gt-count-${gate}`)?.textContent).toBe("1 of 1 approvals");
    expect(await screen.findByText("Needs 1 approval from Line Lead")).toBeTruthy();
    expect(await screen.findByText("The ledger already stores minor units")).toBeTruthy();
    expect(screen.getByText("The spec skips refunds")).toBeTruthy();
  });
});

describe("Gates tab labels and counts (T-26)", () => {
  it("writes combined gates as G0+G1 and never says a passed gate has 0 of 1 approvals", async () => {
    const passed = Object.entries(W.gates).find(([k, g]) => g.status !== "waiting" && k !== gate)?.[0] ?? "G2";
    const t = travelerOf(W);
    W.gates[passed]!.status = "passed";
    t.gateProgress[passed] = { have: 0, need: 1, unmet: [], conds: [], onlyRequester: false, passes: true };
    await show();
    fireEvent.click(screen.getByRole("tab", { name: /^Gates/ }));
    await waitFor(() => expect(document.getElementById(`gt-count-${passed}`)).toBeTruthy());
    expect(document.getElementById(`gt-count-${passed}`)?.textContent).toBe("1 of 1 approvals");
    const table = document.getElementById("dz-gates") as HTMLElement;
    expect(table.textContent).not.toMatch(/G\d[A-Za-z]\d?G|G0G1|G3G3s/);
  });
});

describe("Request changes on the Gates tab", () => {
  it("asks for changes on the waiting gate from the Gates tab, pinned to the gate instance", async () => {
    const t = travelerOf(W);
    const calls = await show({ [`POST /api/v1/gate-instances/${encodeURIComponent(`${W.id}:${gate}:1`)}/reject`]: () => ({ body: { ok: true, msg: "Sent back." } }) });
    void t;
    fireEvent.click(screen.getByRole("tab", { name: /^Gates/ }));
    const row = await screen.findByRole("table", { name: /Gate decisions/ });
    const btn = await waitFor(() => { const b = Array.from(row.querySelectorAll("button")).find((x) => x.textContent === "Request changes"); if (!b) throw new Error("no button"); return b; });
    fireEvent.click(btn);
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(dlg.querySelector("textarea") as HTMLTextAreaElement, { target: { value: "Cover the retry path too" } });
    fireEvent.click(Array.from(dlg.querySelectorAll("button")).find((x) => x.textContent === "Request changes") as HTMLElement);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/reject"))).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/reject"))!.body).toMatchObject({ reason: "Cover the retry path too" });
  });
});

describe("Runs tab", () => {
  it("lists the model calls under Prompts and opens a call's manifest and trace", async () => {
    await show({
      [`GET /api/v1/prompt-calls`]: () => ({ body: { ok: true, calls: [{ requestId: "r1", run: "run-1", wo: W.id, project: "payments", surface: "run", station: "spec", turn: null, model: "claude-test-1", inputTokens: 1200, outputTokens: 300, costMicros: 42000, promptHash: HASH, trace: HASH, outcome: "ok", at: "2026-11-01T10:00:00.000Z" }] } }),
      [`GET /api/v1/prompt-traces/${HASH}`]: () => ({ body: { ok: true, trace: { v: 1, model: "claude-test-1", manifest: { hash: HASH, parts: [{ kind: "repo_context", name: "Repository context", source: "repo", version: null, sha256: HASH, bytes: 2048 }, { kind: "layer", name: "Agent", source: "agent_layers", version: 2, sha256: HASH, bytes: 900 }, { kind: "skill", name: "Refund rules", source: "skills", version: 3, sha256: HASH, bytes: 400 }] } } } }),
    });
    fireEvent.click(screen.getByRole("tab", { name: /^Runs/ }));
    expect(await screen.findByRole("heading", { name: /Prompts/ })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /Manifest and trace/ }));
    expect(await screen.findByText("Repository context")).toBeTruthy();
    expect(screen.getByText("Agent layer")).toBeTruthy();
    expect(screen.getByText("Refund rules")).toBeTruthy();
  });

  it("says so when the prompt records cannot be read, never an empty list", async () => {
    await show({ [`GET /api/v1/prompt-calls`]: () => ({ status: 500, body: { error: "boom" } }) });
    fireEvent.click(screen.getByRole("tab", { name: /^Runs/ }));
    expect(await screen.findByText(/Couldn't load the prompt records/)).toBeTruthy();
  });

  it("opens the run timeline and the station documents from buttons", async () => {
    await show({ [`GET /api/v1/work-orders/${W.id}/timeline`]: () => ({ body: { runs: [] } }), [`GET /api/v1/work-orders/${W.id}/documents`]: () => ({ body: { items: [] } }) });
    fireEvent.click(screen.getByRole("tab", { name: /^Runs/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Run timeline" }));
    expect(await screen.findByText("No runs yet")).toBeTruthy();
  });
});

describe("Actions menu and Traveler", () => {
  it("opens Reassign agent from the Actions menu", async () => {
    await show();
    fireEvent.click(document.getElementById("dz-actions") as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Reassign agent/ }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg.textContent).toMatch(/Reassign/);
  });

  it("the Traveler page opens the drawer with Journey and Documents", async () => {
    mockApi({ ...readsFor(W) });
    window.location.hash = `#traveler/${W.id}`;
    mount(<TravelerPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Journey, documents and activity/ }, { timeout: 4000 }));
    expect(await screen.findByRole("tab", { name: "Journey" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Documents" })).toBeTruthy();
  });
});
