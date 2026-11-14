import { describe, expect, it } from "vitest";
import { lifecycle, nextStep } from "./onboarding-session.js";
import type { RepoOnboarding } from "./types.js";

const doc = (o: Partial<RepoOnboarding>): RepoOnboarding => ({ stage: "assessed", findings: [], pr: null, timeline: [], exception: null, startedAt: 0, ...o });
const gap = { id: "agents", check: "AGENTS.md", ok: false, sev: "high" as const, fix: "Add it", file: "AGENTS.md" };
const pr = (checks: "pending" | "running" | "green" | "red") => ({ number: 1, title: "t", branch: "b", files: [], checks, state: "open" as const, reviewers: [], mergedBy: null });

describe("onboarding session lifecycle", () => {
  it("marks steps done before the current stage and todo after", () => {
    expect(lifecycle(doc({ stage: "assessed" })).map((s) => s.state)).toEqual(["done", "current", "todo", "todo", "todo", "todo", "todo"]);
    expect(lifecycle(doc({ stage: "ready" })).every((s) => s.state === "done")).toBe(true);
    // A stopped repo keeps the step it stopped at.
    expect(lifecycle(doc({ stage: "person", pr: pr("red"), findings: [gap] })).map((s) => s.state)[3]).toBe("current");
  });
  it("says who acts next", () => {
    const o = { agent: true, pendingProposal: false as boolean | "merge", canMerge: true };
    expect(nextStep(doc({ findings: [gap] }), o)).toMatchObject({ actor: "agent" });
    expect(nextStep(doc({ findings: [gap] }), { ...o, agent: false })).toMatchObject({ actor: "gantry" });
    expect(nextStep(doc({ findings: [gap] }), { ...o, pendingProposal: true })).toMatchObject({ actor: "you" });
    expect(nextStep(doc({ stage: "pr_checks", pr: pr("green") }), o)).toMatchObject({ actor: "you", text: expect.stringMatching(/merge/) });
    expect(nextStep(doc({ stage: "pr_checks", pr: pr("green") }), { ...o, canMerge: false })).toMatchObject({ actor: "reviewer" });
    expect(nextStep(doc({ stage: "pr_checks", pr: pr("red") }), o)).toMatchObject({ actor: "agent", text: expect.stringMatching(/failing/) });
    expect(nextStep(doc({ stage: "pr_opened", pr: pr("pending") }), o)).toMatchObject({ actor: "github" });
    expect(nextStep(doc({ stage: "pr_checks", pr: pr("green") }), { ...o, pendingProposal: "merge", canMerge: false })).toMatchObject({ actor: "reviewer" });
    expect(nextStep(doc({ busy: "merging" }), o)).toMatchObject({ actor: "github" });
  });
});
