import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRouteState } from "./routeState";

describe("route state and hashchange", () => {
  it("keeps ?tab= when a hashchange navigated nowhere, and drops it when the route really changed", () => {
    window.history.replaceState(null, "", "/?tab=sessions#security");
    const { result } = renderHook(() => useRouteState({ tab: "signin" }));
    expect(result.current[0].tab).toBe("sessions");
    // `location.hash = ""` on a URL with no fragment: old and new fragments are both empty
    act(() => { window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: "http://localhost:3000/?tab=sessions", newURL: "http://localhost:3000/?tab=sessions#" })); });
    expect(result.current[0].tab).toBe("sessions");
    act(() => { window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: "http://localhost:3000/?tab=sessions#security", newURL: "http://localhost:3000/?tab=sessions#audit" })); });
    expect(result.current[0].tab).toBe("signin");
  });
});
