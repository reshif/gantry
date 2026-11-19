import { describe, expect, it } from "vitest";
import { evaluateGuardrails, pathMatches } from "./guardrails.js";

describe("guardrail path matching", () => {
  it("matches globs and directories, case-insensitively", () => {
    expect(pathMatches(".github/workflows/ci.yml", ".github/workflows/**")).toBe(true);
    expect(pathMatches(".GitHub/Workflows/ci.yml", ".github/workflows/**")).toBe(true);
    expect(pathMatches("src/auth/login.ts", "src/auth")).toBe(true);
    expect(pathMatches("src/authx/login.ts", "src/auth")).toBe(false);
    expect(pathMatches("a/b/secrets.env", "**/*.env")).toBe(true);
    expect(pathMatches("secrets.env", "**/*.env")).toBe(true);
    expect(pathMatches("src/a/b.ts", "src/*.ts")).toBe(false);
    expect(pathMatches("./CODEOWNERS", "/CODEOWNERS")).toBe(true);
  });
  it("matches slash-less patterns at any depth, but keeps rooted and slashed patterns anchored", () => {
    expect(pathMatches("sub/.env", ".env")).toBe(true);
    expect(pathMatches("a/b/k.pem", "*.pem")).toBe(true);
    expect(pathMatches("pkg/package.json", "package.json")).toBe(true);
    expect(pathMatches("a/b/.ENV", ".env")).toBe(true);
    expect(pathMatches("certs/.env/x", ".env")).toBe(true);
    expect(pathMatches("a/.envrc", ".env")).toBe(false);
    expect(pathMatches("a/CODEOWNERS", "/CODEOWNERS")).toBe(false);
    expect(pathMatches("a/src/x.ts", "src/*.ts")).toBe(false);
    expect(evaluateGuardrails([{ path: "nested/.env" }, { path: "certs/k.pem" }], { forbidden: [".env", "*.pem"] }).forbiddenTouched).toEqual(["nested/.env", "certs/k.pem"]);
  });
  it("evaluates forbidden, protected and size", () => {
    const f = evaluateGuardrails([{ path: "src/a.ts", additions: 200, deletions: 150 }, { path: "infra/prod.tf", additions: 1, deletions: 0 }], { forbidden: ["infra/**"], protectedPaths: ["src/a.ts"], maxDiff: 300 });
    expect(f).toEqual({ size: 351, over: true, forbiddenTouched: ["infra/prod.tf"], protectedTouched: ["src/a.ts"] });
    expect(evaluateGuardrails([{ path: "x", additions: 999 }], {}).over).toBe(false);
  });
});
