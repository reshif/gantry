import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TravelerPage from "./traveler-page";
import DossierPage from "./dossier-page";
import ChangesView from "./changes";
import { VIEWS } from "./index";
import { ROUTES } from "../lib/routes";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { readsFor, recordOf, travelerOf, waitingWo } from "./traveler/testkit";

beforeEach(() => resetApp());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const W = waitingWo;

describe("Traveler, Dossier and Changes are routes of their own", () => {
  it("registers the traveler and dossier routes and their views", () => {
    for (const id of ["traveler", "dossier", "changes", "record"]) {
      expect(ROUTES.some((r) => r.id === id && r.project)).toBe(true);
      expect(VIEWS[id]).toBeTruthy();
    }
  });

  it("renders the Traveler page with Back to record and Print in the header", async () => {
    mockApi(readsFor(W));
    window.location.hash = `#traveler/${W.id}`;
    mount(<TravelerPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Traveler" }, { timeout: 4000 })).toBeTruthy();
    expect(document.getElementById("trv-sheet")).toBeTruthy();
    const print = vi.fn();
    vi.stubGlobal("print", print);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(print).toHaveBeenCalled();
    // the print button is in the page header, not below the sheet
    expect(document.querySelector(".ph")?.contains(screen.getByRole("button", { name: "Print" }))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to record" }));
    await waitFor(() => expect(window.location.hash).toContain(`record/${W.id}`));
  });

  it("renders the Dossier page with its five tabs and Back to record", async () => {
    mockApi(readsFor(W));
    window.location.hash = `#dossier/${W.id}`;
    mount(<DossierPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Dossier" }, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText(`The evidence pack for ${W.title}`)).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Summary", "Criteria", "Brief versions", "Checks", "Audit"]);
    for (const l of ["Criteria met", "Checks passed", "Review findings", "Diff"]) expect(screen.getByText(l)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Verdict" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Evidence trail" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Audit" }));
    await waitFor(() => expect(window.location.hash).toContain("%2Faudit"));
    expect(screen.queryByText("Export record")).toBeNull();
    expect(await screen.findByRole("heading", { name: `Audit trail for ${W.id}` })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to record" }));
    await waitFor(() => expect(window.location.hash).toContain(`record/${W.id}`));
  });


  it("the record status card sits 20px under the header, as in the prototype (no extra gap)", async () => {
    const fs = await import("node:fs");
    const css = fs.readFileSync(`${process.cwd()}/src/styles/views/dossier.css`, "utf8");
    expect(css).toMatch(/\.dz-top \{[^}]*gap: 0;/);
    const head = fs.readFileSync(`${process.cwd()}/src/views/dossier/Head.tsx`, "utf8");
    expect(head).not.toMatch(/wo-strip" style=\{\{ marginBottom/);
    expect(fs.readFileSync(`${process.cwd()}/src/views/dossier/Pack.tsx`, "utf8")).toMatch(/"approved" : "latest"/);
  });

  it("Export PDF downloads the record bundle and toasts (it does not open the print dialog)", async () => {
    const calls = mockApi({ ...readsFor(W), [`GET /api/v1/work-orders/${W.id}/record/export`]: () => ({ body: { manifest: { id: W.id, version: 1, algorithm: "sha256", files: [] }, files: {} } }) });
    const print = vi.fn();
    vi.stubGlobal("print", print);
    window.location.hash = `#dossier/${W.id}`;
    mount(<DossierPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Export PDF" }, { timeout: 4000 }));
    await waitFor(() => expect(JSON.stringify(calls)).toContain("record/export"));
    expect(print).not.toHaveBeenCalled();
  });

  it("the Actions menu has no heading row and a modal sits above its own scrim", async () => {
    const css = (await import("node:fs")).readFileSync(`${process.cwd()}/src/styles/cr/app.css`, "utf8");
    expect(css).toMatch(/\.dlg-wrap>\.dlg\{[^}]*z-index:1/);
    const src = (await import("node:fs")).readFileSync(`${process.cwd()}/src/views/dossier/Head.tsx`, "utf8");
    expect(src).toContain("ui.menu(anchor, null, [");
  });

  it("shows Not found with Back to work orders on the traveler, dossier and changes pages", async () => {
    const gone = { [`GET /api/v1/work-orders/${W.id}`]: () => ({ status: 404, body: { ok: false, msg: "No such work order." } }), [`GET /api/v1/work-orders/${W.id}/record`]: () => ({ status: 404, body: { ok: false, msg: "No such work order." } }) };
    for (const [hash, View] of [[`#traveler/${W.id}`, TravelerPage], [`#dossier/${W.id}`, DossierPage], [`#changes/${W.id}`, ChangesView]] as const) {
      cleanup();
      resetApp();
      mockApi(gone);
      window.location.hash = hash;
      mount(<View />);
      expect(await screen.findByRole("heading", { name: "Not found" }, { timeout: 4000 })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Back to work orders" })).toBeTruthy();
    }
  });
});

describe("Changes page", () => {
  it("makes each line number of the stored diff a button that opens a note", async () => {
    const rec = recordOf(W, { code: { pullRequests: [{ number: 12, state: "open", draft: false, headSha: null, title: "t", url: null, mergedAt: null }], commits: [], files: [{ path: "src/a.ts", status: "M", plus: 2, minus: 1, preview: [{ t: " ", s: "@@ -3,2 +3,3 @@" }, { t: " ", s: "x" }, { t: "+", s: "y" }] }], diff: { plus: 2, minus: 1, files: 1 }, tests: { passed: 3, failed: 0, added: 1 } } });
    const diff = { truncated: false, redactions: 0, missingPatches: [], files: [{ path: "src/a.ts", status: "modified", oldPath: null, binary: false, plus: 2, minus: 1, approximate: false, commits: [{ commit: "abc1234def", patch: "p1", plus: 2, minus: 1, status: "modified", hunks: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, header: "", lines: [{ kind: "ctx", old: 3, new: 3, text: "x" }, { kind: "add", old: null, new: 4, text: "y" }] }] }] }] };
    mockApi({ ...readsFor(W, travelerOf(W), rec), [`GET /api/v1/work-orders/${W.id}/diff`]: () => ({ body: diff }) });
    window.location.hash = `#changes/${W.id}`;
    mount(<ChangesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 3" }, { timeout: 4000 }));
    expect(await screen.findByRole("dialog", { name: "Comment on line" })).toBeTruthy();
    fireEvent.change(document.getElementById("chg-note-text") as HTMLElement, { target: { value: "Check the window edge" } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(await screen.findByText(/Check the window edge/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Plan, commits and guardrail" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Review summary" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Review / })).toBeTruthy();
  });
});
