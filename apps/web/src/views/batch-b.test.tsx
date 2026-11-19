import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import { useUI } from "../ui/overlay-context";
import { failureOf } from "../ui/async";
import { ViewHead } from "../ui/primitives";
import { updatePrefs } from "../lib/prefs";
import { setQS } from "./govern/kit";
import { writeHashQuery } from "./floor/urlState";
import { WoStatus } from "./dossier/stateTone";
import { useScope } from "./tabparam";

beforeEach(() => { window.location.hash = "#/people"; window.history.replaceState(null, "", "/#/people"); });
afterEach(cleanup);

describe("view state is in the hash route, not before it (T-23)", () => {
  it("setQS writes the hash query and leaves the address search empty", () => {
    setQS({ "ppl.tab": "teams" });
    expect(window.location.hash).toBe("#/people?ppl.tab=teams");
    expect(window.location.search).toBe("");
    setQS({ "ppl.tab": "" });
    expect(window.location.hash).toBe("#/people");
  });
  it("writeHashQuery moves an older ?tab= before the hash into the hash", () => {
    window.history.replaceState(null, "", "/?tab=old#/security");
    writeHashQuery("tab", "sessions");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#/security?tab=sessions");
  });
});

describe("plain words (T-32, T-26)", () => {
  it("a query key never reaches a person", () => {
    expect(failureOf(new Error('["factory","stops"] data is undefined')).msg).not.toContain("factory");
    expect(failureOf(new ApiError(500, "The server answered 500.", "x")).msg).toContain("500");
  });
  it("a waiting work order at the brief gate reads At G0+G1", () => {
    render(<WoStatus state="waiting" gate="G0G1" />);
    expect(screen.getByText("At G0+G1")).toBeTruthy();
  });
  it("the same toast twice is one toast", () => {
    function Fire() { const ui = useUI(); return <button type="button" onClick={() => ui.toast("Checked all services", "ok")}>fire</button>; }
    render(<OverlayProvider><Fire /></OverlayProvider>);
    fireEvent.click(screen.getByText("fire"));
    fireEvent.click(screen.getByText("fire"));
    expect(screen.getAllByText("Checked all services")).toHaveLength(1);
  });
});

describe("the scope eyebrow follows the switcher (T-18, T-30)", () => {
  function Scope() { const s = useScope(); return <span data-testid="s">{`${s.id ?? "all"}|${s.kicker}`}</span>; }
  it("with All projects chosen the scope is every line even though a project was chosen last", () => {
    updatePrefs({ project: "payments", scopeAll: true });
    render(<QueryClientProvider client={new QueryClient()}><Scope /></QueryClientProvider>);
    expect(screen.getByTestId("s").textContent).toBe("all|All lines");
  });
  it("a page about every line says ALL LINES even with a project chosen", () => {
    updatePrefs({ project: "payments", scopeAll: false });
    act(() => { window.location.hash = "#/projects"; });
    render(<QueryClientProvider client={new QueryClient()}><ViewHead title="Projects" kicker="ALL LINES" /></QueryClientProvider>);
    expect(document.querySelector(".eyebrow")?.textContent).toMatch(/ALL LINES$/);
    expect(document.querySelector(".eyebrow")?.textContent).not.toMatch(/PAY|payments/i);
  });
});

describe("text is shown whole (T-27, T-28)", () => {
  const css = (f: string): string => readFileSync(resolve(process.cwd(), "src", f), "utf8");
  it("vendor cards, the residency line, the Workload bar labels and Integrations values wrap instead of ending in an ellipsis", () => {
    expect(css("styles/views/models.shared.css")).not.toMatch(/\.tb-vendor dd[^}]*text-overflow: ellipsis/);
    expect(css("styles/blueprint.css")).not.toMatch(/\.md-resid\{[^}]*text-overflow:ellipsis/);
    expect(css("styles/views/workload.shared.css")).not.toMatch(/\.barlist-l\{[^}]*text-overflow:ellipsis/);
    expect(css("styles/views/integrations.css")).toMatch(/\.int-card-kv dd \{[^}]*overflow-wrap: break-word/);
    expect(css("styles/views/integrations.css")).not.toMatch(/\.int-card-kv dd \{[^}]*anywhere/);
  });
  it("the Audit target wraps and the role matrix columns are narrow enough to show every role", () => {
    expect(readFileSync(resolve(process.cwd(), "src/views/audit.tsx"), "utf8")).not.toMatch(/className="trunc"[^>]*maxWidth: 340/);
    expect(readFileSync(resolve(process.cwd(), "src/views/access/Matrix.tsx"), "utf8")).toMatch(/minWidth: 84, whiteSpace: "normal"/);
  });
});
