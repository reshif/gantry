import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_HOSTS, PYTHON_TEST_HOSTS } from "../src/areas/internal/egress.js";
import { checkTestCommand, testCommandRules } from "../src/areas/onboarding/testcmd.js";

/** Test runs install Python dependencies from the package index only (owner decision 2026-11-18); nothing else about the allow-list widens. */
describe("egress for Python test runs", () => {
  it("allows exactly pypi.org and files.pythonhosted.org, as exact names", () => {
    expect([...PYTHON_TEST_HOSTS]).toEqual(["pypi.org", "files.pythonhosted.org"]);
    for (const h of PYTHON_TEST_HOSTS) expect(DEFAULT_RUN_HOSTS).toContain(h);
  });
  it("does not allow Python downloads from anywhere else, and has no wildcard", () => {
    for (const h of ["python.org", "www.python.org", "astral.sh", "pypi.example.com", "pythonhosted.org", "test.pypi.org", "raw.githubusercontent.com"]) expect(DEFAULT_RUN_HOSTS).not.toContain(h);
    expect(DEFAULT_RUN_HOSTS.some((h) => h.includes("*"))).toBe(false);
  });
  it("the confirmed test command still passes through the shell allow-list as a prefix rule", () => {
    expect(testCommandRules(["make test", "uv run pytest"])).toEqual(["Bash(make test:*)", "Bash(uv run pytest:*)"]);
    expect(checkTestCommand("python3 -m pytest").ok).toBe(false);
  });
});
