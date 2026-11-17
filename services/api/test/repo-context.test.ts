import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildRepoContext } from "@gantry/domain";
import { repoContextSection } from "../src/areas/internal/spec.js";

const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const ctx = buildRepoContext("c".repeat(40), [{ path: "AGENTS.md", content: "Test: uv run pytest\nNever change: workflow files.\n" }, { path: "CONTRIBUTING.md", content: "Be nice." }], { scan: () => [], sha256 });

describe("the run spec's repository context section", () => {
  it("frames AGENTS.md as repository data with the stated precedence, and lists the other convention files", () => {
    const s = repoContextSection({ runData: { repoContext: { ...ctx, offeredAt: "2026-11-16T00:00:00Z" } } });
    expect(s.startsWith("## Repository context\n\n")).toBe(true);
    expect(s).toContain("factory rails > project overlay > repository conventions > agent defaults");
    expect(s).toContain("### AGENTS.md (repository data)");
    expect(s).toContain("Test: uv run pytest");
    expect(s).toMatch(/- CONTRIBUTING\.md \(8 bytes, sha256 [0-9a-f]{12}\)\n?/);
    expect(s).not.toContain("Be nice.");
  });
  it("is empty when the run has no manifest, an unavailable one, or a malformed one", () => {
    expect(repoContextSection({ runData: {} })).toBe("");
    expect(repoContextSection({ runData: { repoContext: { commit: null, files: [], hash: null, unavailable: true } } })).toBe("");
    expect(repoContextSection({ runData: { repoContext: { files: "x" } } })).toBe("");
  });
});
