import { updatePrefs } from "../lib/prefs";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecordView from "./record";
import { WOS, mockApi, mount, resetApp } from "./floor/testkit";
import { posts, readsFor, recordOf, travelerOf, waitingWo } from "./traveler/testkit";

beforeEach(() => resetApp());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const W = waitingWo;

async function showRecord(extra: Parameters<typeof mockApi>[0] = {}, o: Parameters<typeof mockApi>[1] = {}) {
  const calls = mockApi({ ...readsFor(W), ...extra }, o);
  window.location.hash = `#record/${W.id}?full=1`;
  mount(<RecordView />);
  await screen.findByText("Completeness", {}, { timeout: 4000 });
  return calls;
}

describe("Work order record", () => {
  it("renders the eleven sections with the completeness meter and the written-by-Gantry summary", async () => {
    await showRecord();
    expect(screen.getByText("4/11")).toBeTruthy();
    for (const label of ["Summary", "Request", "Clarification", "Agreement", "Station by station", "Changes", "Verification", "Merge and release", "Approvals", "After release", "Full timeline"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByText("Tomás asked for it. It is waiting at a gate.")).toBeTruthy();
    expect(screen.getByText("Written by Gantry from the record")).toBeTruthy();
    // sections without data say so
    expect(screen.getAllByText("no data yet").length).toBeGreaterThan(0);
  });

  it("saves a written summary with the version in If-Match and shows who wrote it", async () => {
    const calls = await showRecord({ [`PUT /api/v1/work-orders/${W.id}/record/summary`]: () => ({ body: { ok: true, msg: `Summary saved on ${W.id}.` } }) });
    fireEvent.click(document.getElementById("rec-rewrite") as HTMLElement);
    const ta = await screen.findByLabelText("Summary");
    fireEvent.change(ta, { target: { value: "" } });
    expect(document.getElementById("rec-rw-save")?.getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(ta, { target: { value: "Settlement status shipped behind a flag." } });
    fireEvent.click(document.getElementById("rec-rw-save") as HTMLElement);
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/record/summary`)).toHaveLength(1));
    const put = posts(calls, `/api/v1/work-orders/${W.id}/record/summary`)[0]!;
    expect(put.method).toBe("PUT");
    expect(put.body).toEqual({ text: "Settlement status shipped behind a flag." });
    expect(put.headers["if-match"]).toBe("7");
    expect(await screen.findByText(`Summary saved on ${W.id}.`)).toBeTruthy();
  });

  it("locks the summary edit for someone who may not answer and sends nothing", async () => {
    const calls = await showRecord({}, { denied: ["wo.answer"] });
    const btn = document.getElementById("rec-rewrite") as HTMLElement;
    await waitFor(() => expect(btn.getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(btn);
    expect(screen.queryByLabelText("Summary")).toBeNull();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("copies the record as Markdown from the record.md read", async () => {
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    const calls = await showRecord({ [`GET /api/v1/work-orders/${W.id}/record.md`]: () => ({ body: "# WO\n\nline two" }) });
    fireEvent.click(document.getElementById("rec-copy") as HTMLElement);
    await waitFor(() => expect(calls.some((c) => c.path === `/api/v1/work-orders/${W.id}/record.md`)).toBe(true));
    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(await screen.findByText(new RegExp(`Copied ${W.id} as Markdown`))).toBeTruthy();
  });

  it("exports the bundle with its hashes", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const calls = await showRecord({ [`GET /api/v1/work-orders/${W.id}/record/export`]: () => ({ body: { manifest: { id: W.id, version: 7, algorithm: "sha256", files: [{ name: "record.json", sha256: "ab", bytes: 3 }] }, files: {} } }) });
    fireEvent.click(document.getElementById("rec-export") as HTMLElement);
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/record/export"))).toBe(true));
    expect(await screen.findByText(/Exported .*1 parts, each with its sha256 hash/)).toBeTruthy();
  });

  it("steps through the journey with the scrubber", async () => {
    await showRecord();
    expect(document.querySelector(".rec-scrub-n")?.textContent).toBe("2/2");
    fireEvent.click(document.getElementById("rec-scrub-prev") as HTMLElement);
    expect(document.querySelector(".rec-scrub-n")?.textContent).toBe("1/2");
    expect(document.getElementById("rec-scrub-prev")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("shows the approvals of each gate with the pinned versions and votes", async () => {
    const gate = Object.keys(W.gates).find((g) => W.gates[g]!.status === "passed") ?? "G0G1";
    const rec = recordOf(W, {
      gates: [{ id: `${W.id}:${gate}:1`, gate, station: null, status: "closed", closedReason: "decision", headSha: null, openedAt: null, closedAt: null, pinned: { flowVersion: 3, ruleVersion: 2, policyVersion: 5 }, basis: {}, votes: [{ by: "p-priya", vote: "approve", comment: "", at: new Date().toISOString(), via: "web", role: null }], decision: null }],
    });
    await showRecord(readsFor(W, travelerOf(W), rec));
    expect(await screen.findByText(new RegExp(`pinned to flow v3, rule v2, policy v5`))).toBeTruthy();
  });

  it("shows the picker when no record is selected and the not-found state when the record is not visible", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: { items: WOS.slice(0, 2), next: null, total: 2 } }) });
    window.location.hash = "#record";
    updatePrefs({ record: null });
    mount(<RecordView />);
    expect(await screen.findByText("Work order records", {}, { timeout: 4000 })).toBeTruthy();
    expect(await screen.findByText(WOS[0]!.id)).toBeTruthy();
    cleanup();
    mockApi({ [`GET /api/v1/work-orders/${W.id}`]: () => ({ status: 404, body: { ok: false, msg: "No such work order." } }), [`GET /api/v1/work-orders/${W.id}/record`]: () => ({ status: 404, body: { ok: false, msg: "No such work order." } }), "GET /api/v1/projects/payments/work-orders": () => ({ body: { items: [], next: null, total: 0 } }) });
    window.location.hash = `#record/${W.id}`;
    mount(<RecordView />);
    expect(await screen.findByText(`${W.id} does not exist`, {}, { timeout: 4000 })).toBeTruthy();
  });

});
