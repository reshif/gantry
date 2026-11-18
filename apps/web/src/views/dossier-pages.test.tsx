import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TravelerPage from "./traveler-page";
import DossierPage from "./dossier-page";
import ChangesView, { numbered } from "./changes";
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
    expect(await screen.findByRole("heading", { name: `Audit trail for ${W.id}` })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to record" }));
    await waitFor(() => expect(window.location.hash).toContain(`record/${W.id}`));
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
  it("numbers lines from the hunk header and makes each number a button", async () => {
    expect(numbered([{ t: " ", s: "@@ -40,9 +40,22 @@" }, { t: " ", s: "a" }, { t: "-", s: "b" }, { t: "+", s: "c" }, { t: "+", s: "d" }])).toEqual([{ n: null, hunk: true }, { n: 40, hunk: false }, { n: 41, hunk: false }, { n: 41, hunk: false }, { n: 42, hunk: false }]);
    const rec = recordOf(W, { code: { pullRequests: [{ number: 12, state: "open", draft: false, headSha: null, title: "t", url: null, mergedAt: null }], commits: [], files: [{ path: "src/a.ts", status: "M", plus: 2, minus: 1, preview: [{ t: " ", s: "@@ -3,2 +3,3 @@" }, { t: " ", s: "x" }, { t: "+", s: "y" }] }], diff: { plus: 2, minus: 1, files: 1 }, tests: { passed: 3, failed: 0, added: 1 } } });
    mockApi(readsFor(W, travelerOf(W), rec));
    window.location.hash = `#changes/${W.id}`;
    mount(<ChangesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 3" }, { timeout: 4000 }));
    expect((await screen.findAllByText(/Line comments are not available yet/)).length).toBeGreaterThan(1);
    expect(screen.getByRole("heading", { name: "Review summary" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Review / })).toBeTruthy();
  });
});
