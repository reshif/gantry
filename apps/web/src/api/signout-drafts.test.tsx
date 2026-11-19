import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ops } from "./ops";
import { clearDrafts, isDraftDirty, useDraft } from "../lib/useDraft";

afterEach(() => {
  vi.unstubAllGlobals();
  clearDrafts();
});

describe("sign-out forgets drafts", () => {
  it("clears every draft when the session ends", async () => {
    const h = renderHook(() => useDraft({ scope: "t", id: "x", server: { a: "1" }, rev: 1, save: async () => ({ ok: true, msg: "", status: 200 }) }));
    act(() => h.result.current.set("a", "2"));
    expect(isDraftDirty("t", "x")).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "c", ok: true }), { status: 200, headers: { "content-type": "application/json" } })));
    const r = await ops.signOut();
    expect(r.ok).toBe(true);
    expect(isDraftDirty("t", "x")).toBe(false);
  });
});
