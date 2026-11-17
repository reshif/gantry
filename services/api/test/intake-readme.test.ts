import { describe, expect, it } from "vitest";
import { RepoFacts } from "@gantry/domain";
import { WO_TOOLS, type WoSessionCtx } from "../src/areas/workorders/session/tools.js";

const SHA = "b".repeat(40);
const facts = RepoFacts.parse({
  repo: "acme/nautobot-jobs", defaultBranch: "main", headSha: SHA, language: "Python", languages: { Python: 1 },
  files: ["README.md", "pyproject.toml", "jobs/a.py", "assets/logo.png"], contents: { "README.md": "# Nautobot jobs\nRun with nautobot-server.", "pyproject.toml": "[project]" },
  secrets: { scanned: 0, complete: true, hits: [] }, protection: null,
});
const ctx = (): WoSessionCtx => ({ repoFull: "acme/nautobot-jobs", inspect: async () => ({ ok: true, facts }), cards: [], used: [], drafts: {}, next: 1 } as unknown as WoSessionCtx);
const tool = (name: string) => WO_TOOLS.find((t) => t.name === name)!;

describe("the Intake agent reads the repository snapshot", () => {
  it("reads README.md through read_file (it was refused before: the broker never fetched it)", async () => {
    const r = (await tool("read_file").run(ctx(), { path: "README.md" })) as { content?: string; error?: string };
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("Run with nautobot-server");
  });
  it("says why a listed file cannot be read, instead of a bare refusal, and still serves nothing outside the snapshot", async () => {
    const listed = (await tool("read_file").run(ctx(), { path: "assets/logo.png" })) as { error: string };
    expect(listed.error).toMatch(/in the repository but its text is not part of the snapshot/);
    const unknown = (await tool("read_file").run(ctx(), { path: "../../etc/passwd" })) as { error: string; content?: string };
    expect(unknown.content).toBeUndefined();
    expect(unknown.error).toMatch(/Only files the assessment reads/);
  });
  it("has no tool that writes to the repository", () => {
    expect(WO_TOOLS.map((t) => t.name).filter((n) => /write|commit|push|create_file|delete/.test(n))).toEqual([]);
  });
});
