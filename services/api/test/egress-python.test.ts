import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_HOSTS, PYTHON_TEST_HOSTS, TEST_STATIONS } from "../src/areas/internal/egress.js";
import { checkTestCommand, testCommandRules } from "../src/areas/onboarding/testcmd.js";

/** Test runs install Python dependencies from the package index only (owner decision 2026-11-18); nothing else about the allow-list widens. */
describe("egress for Python test runs", () => {
  it("names exactly pypi.org and files.pythonhosted.org, as exact names, for Verify and Build only", () => {
    expect([...PYTHON_TEST_HOSTS]).toEqual(["pypi.org", "files.pythonhosted.org"]);
    expect([...TEST_STATIONS].sort()).toEqual(["build", "verify"]);
  });
  it("the default allow-list every run gets does not include the package index (it is added per station), and has no wildcard", () => {
    for (const h of PYTHON_TEST_HOSTS) expect(DEFAULT_RUN_HOSTS).not.toContain(h);
    for (const h of ["python.org", "www.python.org", "astral.sh", "pypi.example.com", "pythonhosted.org", "test.pypi.org", "raw.githubusercontent.com"]) expect(DEFAULT_RUN_HOSTS).not.toContain(h);
    expect(DEFAULT_RUN_HOSTS.some((h) => h.includes("*"))).toBe(false);
  });
  it("the confirmed test command still passes through the shell allow-list as a prefix rule", () => {
    expect(testCommandRules(["make test", "uv run pytest"])).toEqual(["Bash(make test:*)", "Bash(uv run pytest:*)"]);
    expect(checkTestCommand("python3 -m pytest").ok).toBe(false);
  });
});

/** The deployed image must carry the toolchain: uv without an interpreter (it may never download one) would fail Verify. */
describe("runner image toolchain", () => {
  const docker = readFileSync(new URL("../../../runner/Dockerfile", import.meta.url), "utf8");
  it("builds the full toolchain by default, with Python 3.12 baked in and no interpreter download at run time", () => {
    expect(docker).toMatch(/ARG RUNNER_TOOLCHAIN=full/);
    expect(docker).toMatch(/ARG PYTHON_VERSION=3\.12/);
    expect(docker).toMatch(/UV_PYTHON_DOWNLOADS=never/);
    expect(docker).toMatch(/uv python install "\$PYTHON_VERSION"/);
  });
  it("a non-full image does not ship uv (so it cannot half work), and no deploy file overrides the toolchain to minimal", () => {
    expect(docker).toMatch(/else\s+\\?\s*rm -f \/usr\/local\/bin\/uv/);
    for (const f of ["compose.yml", "compose.prod.yml"]) {
      const y = readFileSync(new URL(`../../../deploy/${f}`, import.meta.url), "utf8");
      expect(y, f).not.toMatch(/RUNNER_TOOLCHAIN:\s*["']?minimal/);
    }
  });
});
