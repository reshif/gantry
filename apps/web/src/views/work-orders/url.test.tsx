import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useUrlState } from "./url";

describe("work orders URL state", () => {
  it("reads and writes the query after the hash route, as the prototype does", () => {
    window.location.hash = "#/work-orders?view=board";
    const { result } = renderHook(() => useUrlState({ view: "list", tab: "all" }));
    expect(result.current[0].view).toBe("board");
    act(() => result.current[1]({ tab: "mine" }));
    expect(window.location.hash).toBe("#/work-orders?view=board&tab=mine");
    act(() => result.current[1]({ view: "list" }));
    expect(window.location.hash).toBe("#/work-orders?tab=mine");
  });
});
