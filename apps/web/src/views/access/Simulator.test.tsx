import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { OverlayProvider } from "../../ui/Overlay";
import { Simulator } from "./Simulator";
import { PolicyCards } from "./Policies";

afterEach(cleanup);
const roles = [{ id: "release_manager", name: "Release Manager" }] as never;
const people = [{ id: "p-k", name: "Kenji Watanabe", status: "active", roles: [{ role: "release_manager", scope: "identity" }] }] as never;
const actions = [{ id: "release", name: "Release", scope: "project" }] as never;
const evaluated = { sim: { person: "p-k", action: "release", project: "payments", repo: "", date: "2026-01-01", time: "10:00" }, t: 0, result: { decision: { allowed: true, reason: "x", rule: { kind: "matrix", id: "MATRIX" } }, trace: [], week: [] } } as never;

describe("Access check banner (gov1-092)", () => {
  it("names the held role even when none is held on the picked project", () => {
    const { container } = render(<QueryClientProvider client={new QueryClient()}><OverlayProvider><Simulator roles={roles} people={people} projects={[]} repos={[]} actions={actions} sim={(evaluated as { sim: never }).sim} setSim={() => undefined} evaluated={evaluated} onEvaluate={() => undefined} onShowRule={() => undefined} presetsList={[]} /></OverlayProvider></QueryClientProvider>);
    const t = container.querySelector("#acc-sim-result")!.textContent!;
    expect(t).toContain("holds Release Manager, which includes release.");
    expect(t).not.toContain("holds no role");
  });
});

describe("Policies When (gov1-087)", () => {
  const base = { roles: ["*"], actions: ["release"], where: {}, enabled: true, version: 1 };
  it("shows the freeze window and plain 'always' for an on-call policy without hours", () => {
    const pols = [
      { ...base, id: "POL-103", name: "Freeze", effect: "deny", where: { freeze: true }, when: null },
      { ...base, id: "POL-104", name: "Oncall", effect: "allow", when: null, oncallOnly: true },
    ] as never;
    const from = Date.UTC(2026, 11, 20), to = Date.UTC(2027, 0, 5);
    const { container } = render(<OverlayProvider><PolicyCards policies={pols} hl={null} roles={[]} onEdit={() => undefined} freezes={[{ id: "F", name: "Year-end", repos: "all", from, to, by: "p" }] as never} /></OverlayProvider>);
    const whens = Array.from(container.querySelectorAll("td .mono")).map((e) => e.textContent);
    expect(whens).toContain("Dec 20 – Jan 5");
    expect(whens).toContain("always");
  });
});
