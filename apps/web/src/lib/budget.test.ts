import { describe, expect, it } from "vitest";
import { monthlyCap } from "./budget";

describe("monthlyCap (T-55, T-56)", () => {
  it("is null for no cap, whatever the shape", () => {
    for (const b of [undefined, null, {}, { monthly: 0 }, { monthly: null }, { monthly: Number.NaN }, { monthly: -5 }]) expect(monthlyCap(b)).toBeNull();
  });
  it("is the amount for a real cap", () => expect(monthlyCap({ monthly: 7000 })).toBe(7000));
});
