import { describe, expect, it } from "vitest";
import type { Catalog } from "@gantry/domain";
import { allClasses } from "./classes";

describe("allClasses", () => {
  it("lists built-in and custom classes of any project once (Model change included)", () => {
    const cat = { classes: [{ id: "feature", name: "Feature" }, { id: "mc", name: "Model change", custom: true }] } as unknown as Catalog;
    const flow = { classes: [{ id: "feature", name: "Feature" }] };
    expect(allClasses(cat, { flow } as never).map((c) => c.name)).toEqual(["Feature", "Model change"]);
  });
});
