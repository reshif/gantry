import { afterEach, describe, expect, it } from "vitest";
import { parseHash } from "./router";
import { writeQuery } from "./urlState";

afterEach(() => { window.history.replaceState(null, "", "/"); });

describe("prototype-style links carry page state after the hash route", () => {
  it("#/inbox?tab=stuck is the inbox route, not a route named 'inbox?tab=stuck'", () => {
    expect(parseHash("#/inbox?tab=stuck")).toEqual({ id: "inbox", param: null, project: null, q: expect.any(Object) });
    expect(parseHash("#/p/payments/work-orders?station=build")).toEqual({ id: "work-orders", param: null, project: "payments", q: expect.any(Object) });
  });

  it("writing a key removes it from the hash query so the new value wins", () => {
    window.history.replaceState(null, "", "/#/inbox?tab=stuck&x=1");
    writeQuery({ tab: "questions" });
    expect(window.location.search).toBe("?tab=questions");
    expect(window.location.hash).toBe("#/inbox?x=1");
  });
});
