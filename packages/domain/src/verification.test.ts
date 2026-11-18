import { describe, expect, it } from "vitest";
import { checkMatches, criteriaFor } from "./lifecycle.js";

const wo = { cls: "feature", brief: { ac: ["Lists devices", "Handles empty"] } } as never;

describe("criteriaFor with Verify's report", () => {
  it("is not tested without a report", () => {
    expect(criteriaFor(wo).every((c) => c.status === "not tested")).toBe(true);
  });
  it("carries each verdict and the runs named in its evidence", () => {
    const c = criteriaFor(wo, {
      criteria: [{ criterion: "Lists devices", result: "pass", evidence: "test_lists ok" }, { criterion: "Handles empty", result: "fail", evidence: "test_empty failed" }],
      testsRun: [{ name: "test_lists", result: "pass" }, { name: "test_empty", result: "fail" }],
    });
    expect(c.map((x) => x.status)).toEqual(["met", "not met", "not tested", "not tested"]);
    expect(c[0]!.tests).toEqual([{ name: "test_lists", result: "pass", ms: 0 }]);
    expect(c[1]!.tests[0]!.result).toBe("fail");
  });
  it("an untested verdict stays not tested", () => {
    expect(criteriaFor(wo, { criteria: [{ criterion: "Lists devices", result: "untested", evidence: "could not run" }] })[0]!.status).toBe("not tested");
  });
});

describe("criteriaFor does not trust a verdict the evidence contradicts", () => {
  const rep = (result: string, evidence: string) => ({ criteria: [{ criterion: "Lists devices", result, evidence }] });
  it("a met criterion whose named run failed is not met", () => {
    expect(criteriaFor(wo, { ...rep("pass", "test_lists"), testsRun: [{ name: "test_lists", result: "fail" }] })[0]!.status).toBe("not met");
  });
  it("a met criterion is unconfirmed when the platform observed failing tests and no named run passed", () => {
    expect(criteriaFor(wo, { ...rep("pass", "looked fine"), testsRun: [], observedFailed: 2 })[0]!.status).toBe("not tested");
    expect(criteriaFor(wo, { ...rep("pass", "test_lists"), testsRun: [{ name: "test_lists", result: "pass" }], observedFailed: 2 })[0]!.status).toBe("met");
  });
  it("keeps a reported duration", () => {
    expect(criteriaFor(wo, { ...rep("pass", "test_lists"), testsRun: [{ name: "test_lists", result: "pass", ms: 42 }] })[0]!.tests[0]!.ms).toBe(42);
  });
});

describe("checkMatches", () => {
  it("a required status context matches the check run's job name", () => {
    expect(checkMatches("ci/test", "test")).toBe(true);
    expect(checkMatches("ci / test", "test")).toBe(true);
    expect(checkMatches("ci/test", "ci/test")).toBe(true);
    expect(checkMatches("ci/test", "lint")).toBe(false);
    expect(checkMatches("ci/test", "latest")).toBe(false);
    expect(checkMatches("test", "ci/test")).toBe(false);
    // Only the last segment matches, so a different job never satisfies a required check, whatever its prefix.
    expect(checkMatches("ci/lint", "test")).toBe(false);
    expect(checkMatches("other/test-e2e", "test")).toBe(false);
  });
});
