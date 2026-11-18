import { describe, expect, it } from "vitest";
import { gateLabelOf } from "./gate-label";

describe("gateLabelOf", () => {
  it("writes combined gates with the plus, whether the label is missing or is the id", () => {
    expect(gateLabelOf(undefined, "G0G1")).toBe("G0+G1");
    expect(gateLabelOf("G3G3s", "G3G3s")).toBe("G3+G3s");
    expect(gateLabelOf("G0+G1", "G0G1")).toBe("G0+G1");
    expect(gateLabelOf("G2", "G2")).toBe("G2");
  });
});
