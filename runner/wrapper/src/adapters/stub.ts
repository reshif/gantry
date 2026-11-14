import { createHash } from "node:crypto";
import type { Adapter, AdapterContext, AdapterOutcome } from "../adapter.js";
import type { RunSpec } from "../spec.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const text = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));

/** Pulls a title-ish string out of the input without assuming its shape. */
function subject(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (typeof input === "object" && input !== null) {
    const o = input as Record<string, unknown>;
    for (const k of ["title", "brief", "summary", "goal"]) if (typeof o[k] === "string" && (o[k] as string).trim() !== "") return (o[k] as string).trim();
  }
  return "";
}

/**
 * Deterministic station result built only from the spec. No model, no randomness, no clock: the same spec always yields
 * the same output. Every field is agent-reported (spec 10.3); the stub observes nothing about the repository, so it
 * reports no commits and no files changed.
 */
export function stubStationResult(spec: RunSpec): Record<string, unknown> {
  const subj = subject(spec.input);
  const digest = sha(`${spec.station}\n${spec.instructions}\n${text(spec.input)}`).slice(0, 12);
  const base = { station: spec.station, subject: subj, digest, provenance: "agent-reported" };
  switch (spec.station) {
    case "intake":
      return { ...base, class: "feature", confidence: 0.5, rationale: "stub adapter: no model consulted", route: "default", clarifyingQuestions: [], misses: [] };
    case "research":
      return { ...base, findings: [], sources: [], openQuestions: [] };
    case "spec":
      return { ...base, goal: subj, scope: { in: [], out: [] }, acceptanceCriteria: [] };
    case "design":
      return { ...base, designNotes: "", affectedComponents: [], risks: [] };
    case "plan":
      return { ...base, steps: [], childWorkOrders: [] };
    case "build":
      return { ...base, commits: [], filesChanged: [] };
    case "verify":
      return { ...base, testsRun: [], criteria: [], checks: [] };
    case "review":
    case "merge":
    case "review-merge":
      return { ...base, reviewNotes: "", pullRequestDescription: subj, commentResponses: [] };
    case "close":
      return { ...base, releaseNotes: "", tag: null, summary: subj };
    default:
      return { ...base };
  }
}

export const stubAdapter: Adapter = {
  name: "stub",
  capabilities: { cancel: true, resume: false, mcp: false, usageDetail: false },
  async run(ctx: AdapterContext): Promise<AdapterOutcome> {
    const { spec } = ctx;
    ctx.setTurn(1);
    if (spec.stub?.delayMs) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, spec.stub?.delayMs);
        ctx.signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
      if (ctx.signal.aborted) return { status: "interrupted", usage: [] };
    }
    if (spec.stub?.failWith !== undefined) return { status: "failed", usage: [], error: { code: "stub_failure", msg: spec.stub.failWith } };
    const output = spec.stub?.output !== undefined ? spec.stub.output : stubStationResult(spec);
    await ctx.checkpoint({ turn: 1, kind: "artefact", name: `${spec.station}-result.json`, contentType: "application/json", content: JSON.stringify(output) });
    return { status: "succeeded", output, usage: [] };
  },
};
