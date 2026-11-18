/**
 * Round 2, Control room: each fix is reached from a screen by clicking, against the server's route shapes (diff, record.review, prompt traces with the run's
 * manifest, brief edit with If-Match, redo as a send-back to the current station, station documents, audit-shaped activity).
 */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { updatePrefs } from "../lib/prefs";
import ChangesView from "./changes";
import RecordView from "./record";
import FloorView from "./floor";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { posts, readsFor, recordOf, travelerOf, waitingWo } from "./traveler/testkit";

beforeEach(() => {
  resetApp();
  updatePrefs({ scopeAll: false, project: "payments", floorView: "belt", replay: null, activeClass: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const W = waitingWo;
const hunk = (lines: Array<[string, number | null, number | null, string]>, o = { oldStart: 10, newStart: 10 }) => ({ oldStart: o.oldStart, oldLines: 3, newStart: o.newStart, newLines: 4, header: "def refund():", lines: lines.map(([kind, old, nw, text]) => ({ kind, old, new: nw, text })) });
const commit = (sha: string, patch: string, hunks: unknown[], plus = 1, minus = 0) => ({ commit: sha, patch, plus, minus, status: "modified", hunks });
const DIFF = {
  truncated: true, redactions: 2, missingPatches: ["p-gone"],
  files: [
    { path: "src/a.py", status: "modified", oldPath: null, binary: false, plus: 3, minus: 1, approximate: true, commits: [
      commit("1111111aaaa", "p1", [hunk([["ctx", 10, 10, "def refund():"], ["del", 11, null, "    return None"], ["add", null, 11, "    return charge(key=KEY)"]])], 1, 1),
      commit("2222222bbbb", "p2", [hunk([["ctx", 20, 21, "x = 1"], ["add", null, 22, "y = [REDACTED:aws-key]"]], { oldStart: 20, newStart: 21 })], 2, 0),
    ] },
    { path: "src/b.png", status: "added", oldPath: null, binary: true, plus: 0, minus: 0, approximate: false, commits: [commit("1111111aaaa", "p1", [], 0, 0)] },
    { path: "src/c.py", status: "modified", oldPath: null, binary: false, plus: 4, minus: 0, approximate: false, commits: [commit("3333333cccc", "p-gone", [], 4, 0)] },
    { path: "src/d.py", status: "renamed", oldPath: "src/old_d.py", binary: false, plus: 0, minus: 0, approximate: false, commits: [] },
  ],
};
const REVIEW = {
  verdict: "changes_requested", reported: "changes_requested", notes: "The helper is added but never called.",
  criteria: [{ criterion: "Refunds use the helper", result: "fail", evidence: "src/a.py: never called" }, { criterion: "Tests cover it", result: "pass", evidence: "test_refund" }],
  findings: [{ severity: "major", file: "src/a.py", line: 11, issue: "helper never used", fix: "call it from refund()" }],
};

function showChanges(extra: Parameters<typeof mockApi>[0] = {}, rec = recordOf(W)) {
  const calls = mockApi({ ...readsFor(W, travelerOf(W), rec), [`GET /api/v1/work-orders/${W.id}/diff`]: () => ({ body: DIFF }), ...extra });
  window.location.hash = `#changes/${W.id}`;
  mount(<ChangesView />);
  return calls;
}
const rowOf = (name: string) => within(document.getElementById("chg") as HTMLElement).getByText(name).closest("a") as HTMLElement;

describe("Changes: the stored diff", () => {
  it("lists one row per file, opens the diff with real line numbers, and says what is approximate, redacted and cut", async () => {
    const calls = showChanges();
    await screen.findByRole("heading", { name: "Changes" }, { timeout: 4000 });
    await waitFor(() => expect(document.getElementById("chg-file")).toBeTruthy());
    expect(calls.some((c) => c.path === `/api/v1/work-orders/${W.id}/diff`)).toBe(true);
    // one row per path, not one per commit
    const rows = [...document.querySelectorAll("#chg .list a")].map((a) => a.querySelector(".t1")?.textContent);
    expect(rows.filter((r) => ["a.py", "b.png", "c.py", "d.py"].includes(r ?? ""))).toEqual(["a.py", "b.png", "c.py", "d.py"]);
    // a.py was touched by two commits: marked approximate, one section per commit, hunks with numbers from the patch
    expect(document.getElementById("chg-approx")).toBeTruthy();
    expect(document.getElementById("chg-approx-note")?.textContent).toContain("2 commits");
    expect(document.getElementById("chg-commit-0")?.textContent).toContain("Commit 1111111");
    expect(document.getElementById("chg-commit-1")?.textContent).toContain("Commit 2222222");
    expect(document.getElementById("chg-commit-0")?.textContent).toContain("@@ -10,3 +10,4 @@ def refund():");
    expect(document.getElementById("chg-commit-0")?.textContent).toContain("return charge(key=KEY)");
    expect(screen.getByRole("button", { name: "Comment on line 11" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Comment on removed line 11" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Comment on line 22" })).toBeTruthy();
    // redactions and the size cap are said, not hidden
    expect(document.getElementById("chg-redacted")?.textContent).toContain("2 values");
    expect(document.getElementById("chg-truncated")?.textContent).toContain("800 KB");
    // a binary file, a patch whose text is gone and a file with no stored patch each say so
    fireEvent.click(rowOf("b.png"));
    await waitFor(() => expect(document.getElementById("chg-file")?.textContent).toContain("Binary file"));
    fireEvent.click(rowOf("c.py"));
    expect(await screen.findByText("Patch no longer stored")).toBeTruthy();
    fireEvent.click(rowOf("d.py"));
    expect(await screen.findByText("No stored diff")).toBeTruthy();
    expect(document.getElementById("chg-file-status")?.textContent).toBe("renamed");
    expect(document.getElementById("chg-file")?.textContent).toContain("from src/old_d.py");
  });

  it("a diff that fails to load is a failure with Try again, never an empty diff", async () => {
    showChanges({ [`GET /api/v1/work-orders/${W.id}/diff`]: () => ({ status: 500, body: { ok: false, msg: "boom" } }) });
    expect(await screen.findByText(/Couldn.t load the stored diff/, undefined, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("No stored diff")).toBeNull();
  });
});

describe("G5 and the review gate show the Review agent's verdict", () => {
  const gate = Object.entries(W.gates).find(([, g]) => g.status === "waiting")![0];
  const rec = () => recordOf(W, { review: REVIEW as never, gates: [{ id: `${W.id}:${gate}:1`, gate, station: null, status: "waiting", closedReason: null, headSha: null, openedAt: null, closedAt: null, pinned: { flowVersion: 1, ruleVersion: null, policyVersion: null }, basis: { review: REVIEW as never }, votes: [], decision: null }] });
  it("shows the verdict, the findings and the verdict per criterion on the Changes page and inside the Review dialog", async () => {
    showChanges({}, rec());
    const summary = await waitFor(() => { const e = document.getElementById("chg-review-verdict"); if (!e) throw new Error("no verdict"); return e; }, { timeout: 4000 });
    expect(summary.textContent).toContain("Changes requested");
    expect(summary.textContent).toContain("The helper is added but never called.");
    expect(within(summary).getByRole("list", { name: "Review findings" }).textContent).toContain("helper never used");
    expect(within(summary).getByRole("list", { name: "Review verdict per criterion" }).textContent).toMatch(/Failed.*Refunds use the helper.*Passed.*Tests cover it/);
    fireEvent.click(await screen.findByRole("button", { name: /^Review / }));
    const dlg = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dlg).getByText("Review agent")).toBeTruthy());
    expect(dlg.textContent).toContain("call it from refund()");
    expect(dlg.textContent).toContain("src/a.py:11");
  });
  it("says so when Review has recorded no verdict", async () => {
    showChanges({}, recordOf(W, { review: null }));
    expect(await screen.findByText("The Review agent has not recorded a verdict on this work order yet.", undefined, { timeout: 4000 })).toBeTruthy();
  });
});

describe("Acceptance criteria show Verify's status and test counts", () => {
  it("reads Passed, Failed or Not tested per criterion with the test runs, and the counts from the record", async () => {
    const rec = recordOf(W, {
      criteria: [
        { id: "AC-1", text: "Refunds accept a key", status: "met", tests: [{ name: "test_key", result: "pass", ms: 0 }] },
        { id: "AC-2", text: "A repeat returns the first", status: "not met", tests: [{ name: "test_repeat", result: "fail", ms: 0 }] },
        { id: "AC-3", text: "Documented", status: "not tested", tests: [] },
      ],
      code: { pullRequests: [], commits: [], files: [], diff: { plus: 0, minus: 0, files: 0 }, tests: { passed: 2, failed: 1, added: 0 } },
    });
    mockApi(readsFor(W, travelerOf(W), rec));
    window.location.hash = `#record/${W.id}`;
    mount(<RecordView />);
    await screen.findByRole("toolbar", { name: "Work order actions" }, { timeout: 4000 });
    const list = await waitFor(() => { const e = document.getElementById("crit-list"); if (!e) throw new Error("no criteria"); return e; });
    expect(document.getElementById("crit-counts")?.textContent).toBe("Verify ran 3 tests: 2 passed, 1 failed.");
    expect(document.getElementById("crit-AC-1")?.textContent).toContain("Passed");
    expect(document.getElementById("crit-AC-1")?.textContent).toContain("passed: test_key");
    expect(document.getElementById("crit-AC-2")?.textContent).toContain("Failed");
    expect(document.getElementById("crit-AC-3")?.textContent).toContain("Not tested");
    expect(list.textContent).not.toContain("Met");
  });
  it("says Verify recorded no test run instead of showing zeros", async () => {
    mockApi(readsFor(W, travelerOf(W), recordOf(W, { criteria: [{ id: "AC-1", text: "x", status: "not tested", tests: [] }] })));
    window.location.hash = `#record/${W.id}`;
    mount(<RecordView />);
    expect(await screen.findByText("Verify has recorded no test run for this work order.", undefined, { timeout: 4000 })).toBeTruthy();
  });
});

describe("Prompts tab: the manifest of a station run", () => {
  const H = "a".repeat(64);
  const CALL = { requestId: "r1", run: "run-1", wo: W.id, project: "payments", surface: "run", station: "build", turn: null, model: "m-1", inputTokens: 10, outputTokens: 5, costMicros: 1000, promptHash: "b".repeat(64), trace: H, outcome: "ok", at: new Date().toISOString() };
  const part = (kind: string, name: string, source: string, version: number | null) => ({ kind, name, source, version, sha256: "c".repeat(64), bytes: 100 });
  it("groups the run's parts: agent layers, repository context (AGENTS.md), skills with versions, station tools, even when the edge trace holds only messages", async () => {
    const manifest = { hash: "9".repeat(64), parts: [part("layer", "Agent: Builder", "instructions", 4), part("repo_context", "AGENTS.md", "repo AGENTS.md", null), part("skill", "Code review", "skill_versions sk-review", 3), part("skill", "Python", "skill_versions sk-py", 1), part("station_tools", "Station tools", "runner/wrapper", null)] };
    mockApi({ ...readsFor(W), "GET /api/v1/prompt-calls": () => ({ body: { ok: true, calls: [CALL] } }), [`GET /api/v1/prompt-traces/${H}`]: () => ({ body: { ok: true, trace: { v: 1, request: { messages: [] }, runPrompt: { promptHash: "b".repeat(64), manifest, instructionPin: null } } } }) });
    window.location.hash = `#record/${W.id}`;
    mount(<RecordView />);
    await screen.findByRole("toolbar", { name: "Work order actions" }, { timeout: 4000 });
    fireEvent.click(screen.getByRole("tab", { name: "Prompts" }));
    const row = await waitFor(() => { const r = document.getElementById(`dz-prompt-${H.slice(0, 12)}`); if (!r) throw new Error("no row"); return r; });
    fireEvent.click(row.querySelector("button")!);
    await waitFor(() => expect(document.getElementById("dz-prompt-detail")).toBeTruthy());
    const sec = (id: string) => document.getElementById(`dz-prompt-${id}`)?.textContent ?? "";
    expect(sec("layers")).toContain("Agent layers (1)");
    expect(sec("layers")).toContain("Agent: Builder");
    expect(sec("repo")).toContain("AGENTS.md");
    expect(sec("skills")).toContain("Skills (2)");
    expect(sec("skills")).toMatch(/Code review.*3/);
    expect(sec("tools")).toContain("Station tools");
    expect(document.getElementById("dz-prompt-detail")?.textContent).toContain("9".repeat(64));
    expect(document.getElementById("dz-prompt-nomanifest")).toBeNull();
  });
});

describe("Redo the current station", () => {
  it("is in the Actions menu, needs a note, and sends the work order back to the station it is at", async () => {
    const t = travelerOf(W);
    const cur = DEFAULT_CATALOG.stations[t.station]!.id;
    const calls = mockApi({ ...readsFor(W, t), [`POST /api/v1/work-orders/${W.id}/send-back`]: () => ({ body: { ok: true, msg: "Sent back to redo." } }) });
    window.location.hash = `#record/${W.id}`;
    mount(<RecordView />);
    await screen.findByRole("toolbar", { name: "Work order actions" }, { timeout: 4000 });
    fireEvent.click(document.getElementById("dz-more") as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Redo this station/ }));
    const dlg = await screen.findByRole("dialog", { name: /^Redo .* on / });
    fireEvent.click(within(dlg).getByRole("button", { name: "Redo station" }));
    expect(await within(dlg).findByText(/at least 3 characters/)).toBeTruthy();
    expect(posts(calls, `/api/v1/work-orders/${W.id}/send-back`)).toHaveLength(0);
    fireEvent.change(document.getElementById("redo-note") as HTMLElement, { target: { value: "Look at the retry path too" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Redo station" }));
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/send-back`)).toHaveLength(1));
    expect(posts(calls, `/api/v1/work-orders/${W.id}/send-back`)[0]!.body).toMatchObject({ toStation: cur, note: "Look at the retry path too" });
  });
  it("is refused with the server's reason shown in the dialog", async () => {
    mockApi({ ...readsFor(W), [`POST /api/v1/work-orders/${W.id}/send-back`]: () => ({ status: 422, body: { ok: false, msg: "Pick this station or an earlier one." } }) });
    window.location.hash = `#record/${W.id}`;
    mount(<RecordView />);
    await screen.findByRole("toolbar", { name: "Work order actions" }, { timeout: 4000 });
    fireEvent.click(document.getElementById("dz-more") as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Redo this station/ }));
    fireEvent.change(await screen.findByLabelText(/What should it do differently/), { target: { value: "try again please" } });
    fireEvent.click(screen.getByRole("button", { name: "Redo station" }));
    expect(await screen.findByText("Pick this station or an earlier one.")).toBeTruthy();
  });
});

describe("Station documents include the brief and the build record", () => {
  it("opens the documents from the work order page and lists brief.md and build.md, marking system records", async () => {
    const doc = (id: string, name: string, station: string, kind: string) => ({ id, doc: name, station, version: 1, supersedes: null, authorKind: kind, authorId: null, attemptId: null, size: 100, contentHash: "f".repeat(64), createdAt: Date.now(), acceptedBy: null });
    mockApi({
      ...readsFor(W),
      [`GET /api/v1/work-orders/${W.id}/documents`]: () => ({ body: { items: [doc("d1", "brief.md", "intake", "system"), doc("d2", "research.md", "research", "agent"), doc("d3", "build.md", "build", "system")] } }),
      [`GET /api/v1/work-orders/${W.id}/documents/d1`]: () => ({ body: { ...doc("d1", "brief.md", "intake", "system"), body: "# Brief\nIn scope: refunds" } }),
    });
    window.location.hash = `#record/${W.id}`;
    mount(<RecordView />);
    await screen.findByRole("toolbar", { name: "Work order actions" }, { timeout: 4000 });
    fireEvent.click(document.getElementById("rec-documents") as HTMLElement);
    const nav = await screen.findByRole("navigation", { name: "Documents" }, { timeout: 4000 });
    expect(within(nav).getByText("brief.md")).toBeTruthy();
    expect(within(nav).getByText("build.md")).toBeTruthy();
    expect(within(nav).getByText("research.md")).toBeTruthy();
    expect(await screen.findByText(/recorded by Gantry at Intake/)).toBeTruthy();
    expect(await screen.findByText(/In scope: refunds/)).toBeTruthy();
  });
});

describe("Floor ticker", () => {
  it("shows the text of real audit rows and never 'undefined'", async () => {
    const at = Date.now() - 5000;
    mockApi({
      "GET /api/v1/activity": () => ({ body: { items: [
        { id: 3, seq: 3, at, actor: "p-asha", action: "wo.enter", target: "WO-1005", entity: { type: "wo", id: "WO-1005" }, project: "payments", after: JSON.stringify({ station: "build" }) },
        { id: 2, seq: 2, at: at - 1000, actor: "p-asha", action: "wo.submit", target: "WO-1006", entity: { type: "wo", id: "WO-1006" }, project: "payments", after: null },
      ], next: null } }),
    });
    mount(<FloorView />);
    const tk = await waitFor(() => { const e = document.querySelector(".ticker .tk"); if (!e || !e.textContent) throw new Error("no ticker"); return e; }, { timeout: 4000 });
    expect(tk.textContent).toContain("WO-1005 moved to Build");
    expect(tk.textContent).toContain("WO-1006 submitted");
    expect(tk.textContent).not.toContain("undefined");
    expect(tk.textContent).toContain("just now");
  });
});
