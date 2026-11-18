/** Round 2 in the Blueprint design: each screen is opened the way a person gets there and clicked (changes diff, prompts, brief editor, review verdict, redo, documents, criteria, floor). */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CATALOG } from "@gantry/domain";
import RecordView from "./record";
import ChangesView from "./changes";
import FloorView from "./floor";
import { updatePrefs } from "../lib/prefs";
import { mockApi, mount, resetApp, type Call } from "./floor/testkit";
import { intakeWo, readsFor, recordOf, travelerOf, waitingWo } from "./traveler/testkit";

beforeEach(() => resetApp());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const W = waitingWo;
const HASH = "0".repeat(64);
const sent = (calls: Call[], method: string, suffix: string) => calls.filter((c) => c.method === method && c.path.endsWith(suffix));

const hunk = (o: number, n: number, lines: Array<[string, number | null, number | null, string]>) => ({ oldStart: o, oldLines: 2, newStart: n, newLines: 3, header: "def refund():", lines: lines.map(([kind, old, nw, text]) => ({ kind, old, new: nw, text })) });
const DIFF = {
  truncated: false, redactions: 0, missingPatches: [] as string[],
  files: [
    { path: "src/refund.py", status: "modified", oldPath: null, binary: false, plus: 3, minus: 1, approximate: true, commits: [
      { commit: "aaaaaaa1111", patch: "p1", plus: 2, minus: 1, status: "modified", hunks: [hunk(10, 10, [["ctx", 10, 10, "def refund():"], ["del", 11, null, "    return old()"], ["add", null, 11, "    return new()"], ["add", null, 12, "    # idempotent"]])] },
      { commit: "bbbbbbb2222", patch: "p2", plus: 1, minus: 0, status: "modified", hunks: [hunk(30, 31, [["ctx", 30, 31, "x = 1"], ["add", null, 32, "y = 2"]])] },
    ] },
    { path: "assets/logo.png", status: "added", oldPath: null, binary: true, plus: 0, minus: 0, approximate: false, commits: [{ commit: "aaaaaaa1111", patch: "p1", plus: 0, minus: 0, status: "added", hunks: [] }] },
  ],
};
const CHANGES = {
  pullRequests: [], patches: [],
  commits: [{ sha: "aaaaaaa1111", message: "Add refund path", author: null, at: null, files: [] }, { sha: "bbbbbbb2222", message: "Tidy refund", author: null, at: null, files: [] }],
  // the record lists a path once per commit (the old page showed three rows here)
  files: [{ path: "src/refund.py", status: "modified", plus: 2, minus: 1 }, { path: "src/refund.py", status: "modified", plus: 1, minus: 0 }, { path: "assets/logo.png", status: "added", plus: 0, minus: 0 }, { path: "docs/gone.md", status: "added", plus: 4, minus: 0 }],
};

async function changes(over: Partial<typeof DIFF> = {}, diffStatus = 200) {
  mockApi({
    ...readsFor(W),
    [`GET /api/v1/work-orders/${W.id}/changes`]: () => ({ body: CHANGES }),
    [`GET /api/v1/work-orders/${W.id}/diff`]: () => (diffStatus === 200 ? { body: { ...DIFF, ...over } } : { status: diffStatus, body: { ok: false, msg: "no" } }),
  });
  window.location.hash = `#changes/${W.id}`;
  mount(<ChangesView />);
  return screen.findByRole("heading", { name: `Changes · ${W.id}` }, { timeout: 4000 });
}

describe("Changes: the agent's actual diff", () => {
  it("lists one row per file across commits and expands a file to its hunks with line numbers, per commit, marked approximate", async () => {
    await changes();
    await waitFor(() => expect(document.getElementById("chg-files")).toBeTruthy());
    const list = document.getElementById("chg-files") as HTMLElement;
    await waitFor(() => expect(within(list).getAllByText("assets/logo.png")).toHaveLength(1));
    // the record lists src/refund.py twice (once per commit); the page shows it once, plus the planned files the seed adds
    expect(within(list).getAllByText("src/refund.py")).toHaveLength(1);
    expect(within(list).getAllByText("docs/gone.md")).toHaveLength(1);
    expect(within(list).getByText("approx.")).toBeTruthy();
    fireEvent.click(within(list).getByText("src/refund.py"));
    const diff = await screen.findByRole("group", { name: "Diff of src/refund.py" });
    expect(document.getElementById("chg-approx")?.textContent).toMatch(/Approximate: 2 commits/);
    // per-commit sections with the commit message
    expect(within(diff).getByRole("region", { name: "Commit aaaaaaa" })).toBeTruthy();
    expect(within(diff).getByText("Tidy refund")).toBeTruthy();
    // hunk header and the lines with their numbers
    expect(within(diff).getByText(/@@ -10,2 \+10,3 @@ def refund\(\)/)).toBeTruthy();
    const row = Array.from(diff.querySelectorAll<HTMLElement>(".dfv-row")).find((r) => /# idempotent/.test(r.textContent ?? "")) as HTMLElement;
    expect(row.className).toMatch(/add/);
    expect(row.querySelectorAll(".n")[1]?.textContent).toBe("12");
    const del = Array.from(diff.querySelectorAll<HTMLElement>(".dfv-row")).find((r) => /return old\(\)/.test(r.textContent ?? "")) as HTMLElement;
    expect(del.className).toMatch(/del/);
    expect(del.querySelectorAll(".n")[0]?.textContent).toBe("11");
  });

  it("says a binary file has no text diff", async () => {
    await changes();
    fireEvent.click(await screen.findByText("assets/logo.png"));
    expect((await screen.findByText(/Binary file: it changed/)).id).toBe("chg-binary");
  });

  it("says why a listed file has no lines, never a blank diff: the diff passed its limit", async () => {
    await changes({ truncated: true, files: [DIFF.files[0]!] });
    fireEvent.click(await screen.findByText("docs/gone.md"));
    expect((await screen.findByText(/passed its size limit/))).toBeTruthy();
    fireEvent.click(screen.getByText("src/refund.py"));
    expect(await screen.findByText(/larger than the display limit/)).toBeTruthy();
  });

  it("says when stored patch text is gone and when secrets were redacted", async () => {
    await changes({ missingPatches: ["p9"], redactions: 2, files: [DIFF.files[0]!] });
    fireEvent.click(await screen.findByText("docs/gone.md"));
    expect(await screen.findByText(/stored text of a patch is gone/)).toBeTruthy();
    fireEvent.click(screen.getByText("src/refund.py"));
    expect((await screen.findByText(/stored text of 1 patch is gone/)).id).toBe("chg-missing-patch");
    expect(document.getElementById("chg-redacted")?.textContent).toMatch(/2 secrets .* \[REDACTED:kind\]/);
  });

  it("says the diff could not be loaded when the read fails, and still lists the files", async () => {
    await changes({}, 500);
    fireEvent.click(await screen.findByRole("link", { name: "src/refund.py" }));
    expect(await screen.findByText(/The diff could not be loaded/)).toBeTruthy();
    expect(Array.from(document.querySelectorAll("#chg-files a")).filter((a) => a.textContent === "src/refund.py")).toHaveLength(1);
  });
});

async function recordPage(over: { t?: Partial<ReturnType<typeof travelerOf>>; r?: Parameters<typeof recordOf>[1]; wo?: typeof W; extra?: Parameters<typeof mockApi>[0]; denied?: string[]; hash?: string } = {}) {
  const wo = over.wo ?? W;
  const calls = mockApi({ ...readsFor(wo, travelerOf(wo, over.t ?? {}), recordOf(wo, over.r ?? {})), ...(over.extra ?? {}) }, over.denied ? { denied: over.denied } : {});
  window.location.hash = over.hash ?? `#record/${wo.id}`;
  mount(<RecordView />);
  await screen.findByRole("toolbar", { name: "Work order actions" }, { timeout: 4000 });
  return calls;
}

describe("Runs tab: prompts", () => {
  it("opens a call's manifest: agent layer, repository context (AGENTS.md), skills with versions and station tools", async () => {
    await recordPage({ extra: {
      [`GET /api/v1/prompt-calls`]: () => ({ body: { ok: true, calls: [{ requestId: "r1", run: "run-1", wo: W.id, project: "payments", surface: "run", station: "build", turn: null, model: "claude-test-1", inputTokens: 1200, outputTokens: 300, costMicros: 42000, promptHash: HASH, trace: HASH, outcome: "ok", at: "2026-11-01T10:00:00.000Z" }] } }),
      [`GET /api/v1/prompt-traces/${HASH}`]: () => ({ body: { ok: true, trace: { v: 1, model: "claude-test-1", manifest: null, runPrompt: { promptHash: HASH, instructionPin: { agent: "ag-build", version: 2 }, manifest: { hash: HASH, parts: [
        { kind: "layer", name: "Builder", source: "agent_layers", version: 2, sha256: HASH, bytes: 900 },
        { kind: "repo_context", name: "Repository context", source: "the repository's convention files", version: null, sha256: HASH, bytes: 2048 },
        { kind: "skill", name: "Python style", source: "skills", version: 4, sha256: HASH, bytes: 400 },
        { kind: "skill", name: "Refund rules", source: "skills", version: 3, sha256: HASH, bytes: 400 },
        { kind: "station_tools", name: "Station tools", source: "runner", version: null, sha256: HASH, bytes: 700 },
      ] } } } } }),
    } });
    fireEvent.click(screen.getByRole("tab", { name: /^Runs/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Manifest and trace/ }));
    const parts = await screen.findByRole("list", { name: "What the model was given" });
    expect(within(parts).getByText("Repo context (AGENTS.md)")).toBeTruthy();
    expect(within(parts).getByText("Agent layer")).toBeTruthy();
    expect(within(parts).getByText("Station tools", { selector: ".chip, .chip *" })).toBeTruthy();
    expect(within(parts).getByText(/v4 · /)).toBeTruthy();
    expect(within(parts).getByText(/v3 · /)).toBeTruthy();
    expect(screen.getByText(/5 parts: agent layer, repository context \(AGENTS.md\), 2 skills, station tools/)).toBeTruthy();
    expect(screen.getByText("ag-build v2")).toBeTruthy();
  });
});

describe("Brief editor", () => {
  const I = intakeWo;
  const intake = { requestedBy: "p-someone-else" } as const;
  it("edits scope before confirming, with If-Match, and sends only what changed", async () => {
    const calls = await recordPage({ wo: I, t: intake, extra: { [`PATCH /api/v1/work-orders/${I.id}/brief`]: () => ({ body: { ok: true, msg: "Brief updated." } }) } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit brief" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText(/In scope/), { target: { value: "Refund endpoint\nIdempotency keys" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save brief" }));
    await waitFor(() => expect(sent(calls, "PATCH", "/brief")).toHaveLength(1));
    const c = sent(calls, "PATCH", "/brief")[0]!;
    expect(c.headers["if-match"]).toBe("7");
    expect(c.body).toEqual({ scopeIn: ["Refund endpoint", "Idempotency keys"] });
  });

  it("refuses an empty in-scope list and an unchanged form without calling the server", async () => {
    const calls = await recordPage({ wo: I, t: intake });
    fireEvent.click(await screen.findByRole("button", { name: "Edit brief" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Save brief" }));
    expect(await within(dlg).findByText("Nothing changed yet.")).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText(/In scope/), { target: { value: "  \n " } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save brief" }));
    expect(await within(dlg).findByText("Say what is in scope.")).toBeTruthy();
    expect(sent(calls, "PATCH", "/brief")).toHaveLength(0);
  });

  it("on a conflict says the brief changed and offers the latest", async () => {
    await recordPage({ wo: I, t: intake, extra: { [`PATCH /api/v1/work-orders/${I.id}/brief`]: () => ({ status: 409, body: { ok: false, msg: "This work order changed since you loaded it." } }) } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit brief" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText(/In scope/), { target: { value: "Something else" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save brief" }));
    expect((await within(dlg).findByRole("alert", {}, { timeout: 3000 })).textContent).toMatch(/The brief changed while you were editing/);
    fireEvent.click(within(dlg).getByRole("button", { name: "Load the latest" }));
    await waitFor(() => expect(document.getElementById("be-conflict")).toBeNull());
  });

  it("is locked, with the reason, for someone who may not answer on this work order", async () => {
    await recordPage({ wo: I, t: intake, denied: ["wo.answer"] });
    const btn = await screen.findByRole("button", { name: "Edit brief" });
    await waitFor(() => expect(btn.getAttribute("aria-disabled") === "true" || (btn as HTMLButtonElement).disabled).toBe(true));
  });

  it("lets an epic's children be edited and sent", async () => {
    const epic = { ...I, cls: "epic" };
    const calls = await recordPage({ wo: epic as typeof I, t: intake, extra: { [`PATCH /api/v1/work-orders/${I.id}/brief`]: () => ({ body: { ok: true, msg: "Brief updated." } }) } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit brief" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText(/Child work orders/), { target: { value: "Reports for billing\nReports for support" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save brief" }));
    await waitFor(() => expect(sent(calls, "PATCH", "/brief")).toHaveLength(1));
    expect(sent(calls, "PATCH", "/brief")[0]!.body).toEqual({ children: ["Reports for billing", "Reports for support"] });
  });

  it("offers no edit once the brief is confirmed", async () => {
    await recordPage();
    expect(screen.queryByRole("button", { name: "Edit brief" })).toBeNull();
  });
});

describe("Review verdict on the gate", () => {
  it("shows the Review agent's verdict, each criterion's result and its findings on the waiting gate", async () => {
    const gate = Object.entries(W.gates).find(([, g]) => g.status === "waiting")?.[0] ?? "G2";
    const review = {
      verdict: "approve", notes: "Looks right overall.",
      criteria: [{ criterion: "Refunds are idempotent", result: "pass", evidence: "src/refund.py:12" }, { criterion: "Audit row written", result: "untested", evidence: "" }],
      findings: [{ severity: "minor", file: "src/refund.py", line: 4, issue: "Name is vague", fix: "rename it" }],
    };
    const gates = [{ id: `${W.id}:${gate}:1`, gate, station: "review", status: "open", closedReason: null, headSha: null, openedAt: null, closedAt: null, pinned: { flowVersion: 1, ruleVersion: null, policyVersion: null }, basis: { review }, votes: [], decision: null }];
    await recordPage({ r: { gates: gates as never }, extra: {
      [`GET /api/v1/work-orders/${W.id}/gates/${gate}/approvers`]: () => ({ status: 404, body: { ok: false } }),
      [`GET /api/v1/work-orders/${W.id}/dialogue`]: () => ({ body: { questions: [], assumptions: [], objections: [] } }),
    } });
    fireEvent.click(screen.getByRole("tab", { name: /^Gates/ }));
    const card = await screen.findByRole("region", { name: "Review verdict" }, { timeout: 4000 });
    expect(within(card).getByText("Review approves")).toBeTruthy();
    expect(within(card).getByText("Looks right overall.")).toBeTruthy();
    const crit = within(card).getByRole("list", { name: "Criteria as Review judged them" });
    expect(within(crit).getByText("Met")).toBeTruthy();
    expect(within(crit).getByText("Not tested")).toBeTruthy();
    expect(within(crit).getByText(/src\/refund.py:12/)).toBeTruthy();
    const found = within(card).getByRole("list", { name: "Review findings" });
    expect(within(found).getByText(/Name is vague/)).toBeTruthy();
    expect(within(found).getByText(/src\/refund.py:4/)).toBeTruthy();
  });

  it("shows a request for changes as such", async () => {
    const gate = Object.entries(W.gates).find(([, g]) => g.status === "waiting")?.[0] ?? "G2";
    const review = { verdict: "changes_requested", notes: "", criteria: [], findings: [] };
    const gates = [{ id: "x", gate, station: "review", status: "open", closedReason: null, headSha: null, openedAt: null, closedAt: null, pinned: { flowVersion: 1, ruleVersion: null, policyVersion: null }, basis: { review }, votes: [], decision: null }];
    await recordPage({ r: { gates: gates as never }, extra: { [`GET /api/v1/work-orders/${W.id}/dialogue`]: () => ({ body: { questions: [], assumptions: [], objections: [] } }) } });
    fireEvent.click(screen.getByRole("tab", { name: /^Gates/ }));
    expect(await screen.findByText("Review asked for changes", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText("No findings.")).toBeTruthy();
  });
});

describe("Redo the current station", () => {
  it("sends the work order back to the station it is at, with the note and If-Match", async () => {
    const calls = await recordPage({ extra: { [`POST /api/v1/work-orders/${W.id}/send-back`]: () => ({ body: { ok: true, msg: "Redo started." } }) } });
    fireEvent.click(document.getElementById("dz-actions") as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Redo / }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText(/What should it do differently/), { target: { value: "ab" } });
    fireEvent.click(within(dlg).getByRole("button", { name: /^Redo / }));
    expect(await within(dlg).findByText(/at least 3 characters/)).toBeTruthy();
    expect(sent(calls, "POST", "/send-back")).toHaveLength(0);
    fireEvent.change(within(dlg).getByLabelText(/What should it do differently/), { target: { value: "Use the existing helper" } });
    fireEvent.click(within(dlg).getByRole("button", { name: /^Redo / }));
    await waitFor(() => expect(sent(calls, "POST", "/send-back")).toHaveLength(1));
    const c = sent(calls, "POST", "/send-back")[0]!;
    const stationId = DEFAULT_CATALOG.stations[W.station]!.id;
    expect(c.body).toMatchObject({ toStation: stationId, note: "Use the existing helper" });
    expect(c.headers["if-match"]).toBe("7");
  });

  it("is locked while the work order sits in a bay", async () => {
    await recordPage({ t: { bay: "person" } });
    fireEvent.click(document.getElementById("dz-actions") as HTMLElement);
    const item = await screen.findByRole("menuitem", { name: /^Redo / });
    expect(item.getAttribute("aria-disabled") === "true" || (item as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Station documents", () => {
  it("lists brief.md (recorded by Gantry) and build.md beside the agents' documents", async () => {
    const v = (id: string, doc: string, station: string, kind: "agent" | "system", n: number) => ({ id, doc, station, version: 1, supersedes: null, authorKind: kind, authorId: null, attemptId: null, size: 10, contentHash: "h".repeat(40), createdAt: n, acceptedBy: null });
    await recordPage({ extra: {
      [`GET /api/v1/work-orders/${W.id}/documents`]: () => ({ body: { items: [v("d1", "brief.md", "intake", "system", 1), v("d2", "spec.md", "spec", "agent", 2), v("d3", "build.md", "build", "agent", 3)] } }),
      [`GET /api/v1/work-orders/${W.id}/documents/d1`]: () => ({ body: { ...v("d1", "brief.md", "intake", "system", 1), body: "# Brief\n\nScope" } }),
      [`GET /api/v1/work-orders/${W.id}/documents/d2`]: () => ({ body: { ...v("d2", "spec.md", "spec", "agent", 2), body: "# Spec" } }),
      [`GET /api/v1/work-orders/${W.id}/doc-comments`]: () => ({ body: { items: [] } }),
      [`GET /api/v1/work-orders/${W.id}/sources`]: () => ({ body: { items: [] } }),
    } });
    fireEvent.click(screen.getByRole("tab", { name: /^Runs/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Station documents" }));
    const nav = await screen.findByRole("navigation", { name: "Documents" });
    expect(within(nav).getByText("brief.md")).toBeTruthy();
    expect(within(nav).getByText("build.md")).toBeTruthy();
    fireEvent.click(within(nav).getByText("brief.md"));
    expect(await screen.findByText(/recorded by Gantry from the work order's confirmed brief/)).toBeTruthy();
    expect(screen.getByText(/^Recorded by Gantry\./)).toBeTruthy();
    expect(screen.queryByText(/Agent-written/)).toBeNull();
  });
});

describe("Acceptance criteria: Verify's result", () => {
  it("shows passed, failed and not tested per criterion, the tests behind them and the test counts", async () => {
    const criteria = [
      { id: "AC-1", text: "Refunds are idempotent", status: "met", tests: [{ name: "test_refund_twice", result: "pass", ms: 12 }] },
      { id: "AC-2", text: "Audit row written", status: "not met", tests: [{ name: "test_audit", result: "fail", ms: 3 }] },
      { id: "AC-3", text: "Docs updated", status: "not tested", tests: [] },
    ];
    await recordPage({ r: { criteria, code: { pullRequests: [], commits: [], files: [], diff: { plus: 0, minus: 0, files: 0 }, tests: { passed: 5, failed: 1, added: 2 } } } });
    await waitFor(() => expect(document.getElementById("dz-criteria")).toBeTruthy());
    const list = document.getElementById("dz-criteria") as HTMLElement;
    expect(within(list).getByText("Passed")).toBeTruthy();
    expect(within(list).getByText("Failed")).toBeTruthy();
    expect(within(list).getByText("Not tested")).toBeTruthy();
    expect(within(list).getByText(/test_refund_twice passed/)).toBeTruthy();
    expect(within(list).getByText(/test_audit failed/)).toBeTruthy();
    expect(document.getElementById("dz-test-counts")?.textContent).toBe("5 tests passed, 1 failed, 2 added.");
  });

  it("says no tests were run, instead of implying a pass", async () => {
    const criteria = [{ id: "AC-1", text: "Refunds are idempotent", status: "not tested", tests: [] }];
    await recordPage({ r: { criteria } });
    await screen.findByText("Refunds are idempotent");
    expect(document.getElementById("dz-test-counts")?.textContent).toMatch(/^No tests were run/);
  });
});

describe("Floor shows real text, never undefined", () => {
  it("renders the live floor and its replay event list without the word undefined", async () => {
    updatePrefs({ project: "payments", floorView: "belt", boardSwim: "none", replay: null, collapsedBays: false, activeClass: null, boardFilters: { cls: "all", repo: "all", assignee: "all", prio: "all" } });
    const t = Date.now();
    mockApi({ "GET /api/v1/projects/payments/events": () => ({ body: [{ id: "e1", at: t - 1000, type: "wo.sendback", wo: "WO-2401", by: "p-asha", text: "Redo Build: use the helper" }, { id: "e2", at: t - 2000, type: "wo.brief.edit", wo: "WO-2403", by: "p-asha", text: "scopeIn" }] }) });
    mount(<FloorView />);
    expect(await screen.findByRole("heading", { name: "Floor" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/undefined/);
    expect(document.body.textContent).not.toMatch(/just now/);
  });
});
