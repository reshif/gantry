import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The web bundle pulls @gantry/domain through a barrel; without sideEffects:false a bundler keeps every module (and zod,
// the starter kit and the seed data) in the entry chunk. Subpath exports let a consumer import one module.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { sideEffects?: unknown; exports: Record<string, unknown> };

describe("package.json", () => {
  it("declares the package free of side effects so the bundler can tree-shake the barrel", () => {
    expect(pkg.sideEffects).toBe(false);
  });
  it("exports the barrel and every module as a subpath", () => {
    expect(Object.keys(pkg.exports)).toEqual([".", "./*"]);
    expect(pkg.exports["./*"]).toEqual({ types: "./dist/*.d.ts", default: "./dist/*.js" });
  });
});
