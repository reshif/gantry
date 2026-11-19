import { describe, expect, it } from "vitest";
import { parseHash } from "./router";

describe("hash router", () => {
  it("a query after the route (prototype deep link) is not part of the route", () => {
    expect(parseHash("#/work-orders?view=board")).toEqual({ id: "work-orders", param: null, project: null, q: expect.any(Object) });
    expect(parseHash("#/p/pay/work-orders?view=board&station=build")).toEqual({ id: "work-orders", param: null, project: "pay", q: expect.any(Object) });
  });
});
