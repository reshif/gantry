import { describe, expect, it } from "vitest";
import { needs, plural } from "./plural";

describe("plural", () => {
  it("agrees with the count for 0, 1 and 2", () => {
    expect(plural(0, "project")).toBe("0 projects");
    expect(plural(1, "project")).toBe("1 project");
    expect(plural(2, "project")).toBe("2 projects");
    expect(plural(1, "work order")).toBe("1 work order");
    expect(plural(2, "story", "stories")).toBe("2 stories");
  });
  it("the verb agrees too: 1 item needs attention, 2 items need attention", () => {
    expect(`${plural(1, "item")} ${needs(1)} attention`).toBe("1 item needs attention");
    expect(`${plural(2, "item")} ${needs(2)} attention`).toBe("2 items need attention");
  });
});
