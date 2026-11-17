import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { MeState } from "../../api/queries";
import { deriveSession, noteUnauthorized, registerSessionReset, resetSessionState, useSessionLifecycle } from "./session";
import { currentReturnTo, loginUrlWithReturn } from "./returnTo";
import { watchPopupClosed } from "./popupWatch";

const inState = (id: string): MeState => ({ status: "in", me: { person: { id } } as never });
const outState: MeState = { status: "out", config: null, reason: "" };

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("deriveSession", () => {
  it("branches on data first", () => {
    expect(deriveSession({ data: inState("a"), isPending: false, isError: true })).toEqual({ state: "in", stale: true });
    expect(deriveSession({ data: inState("a"), isPending: false, isError: false })).toEqual({ state: "in", stale: false });
    expect(deriveSession({ data: outState, isPending: false, isError: true })).toEqual({ state: "out", stale: false });
    expect(deriveSession({ data: undefined, isPending: false, isError: true }).state).toBe("offline");
    expect(deriveSession({ data: undefined, isPending: true, isError: false }).state).toBe("unknown");
  });
});

describe("resetSessionState", () => {
  it("sign-out clears the query cache, registered stores and every gantry.* key", () => {
    const qc = new QueryClient();
    qc.setQueryData(["home"], 1);
    localStorage.setItem("gantry.prefs", "{}");
    localStorage.setItem("other", "keep");
    sessionStorage.setItem("gantry.stepup.draft", "{}");
    const store = vi.fn();
    const off = registerSessionReset(store);
    resetSessionState(qc, "signed_out");
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
    expect(store).toHaveBeenCalledTimes(1);
    expect(Object.keys(localStorage).filter((k) => k.startsWith("gantry."))).toEqual([]);
    expect(Object.keys(sessionStorage).filter((k) => k.startsWith("gantry."))).toEqual([]);
    expect(localStorage.getItem("other")).toBe("keep");
    off();
  });
  it("expiry keeps unsent drafts", () => {
    sessionStorage.setItem("gantry.stepup.draft", "{}");
    sessionStorage.setItem("gantry.draft.agent-1", "text");
    localStorage.setItem("gantry.prefs", "{}");
    resetSessionState(new QueryClient(), "expired");
    expect(sessionStorage.getItem("gantry.stepup.draft")).toBe("{}");
    expect(sessionStorage.getItem("gantry.draft.agent-1")).toBe("text");
    expect(localStorage.getItem("gantry.prefs")).toBeNull();
  });
  it("identity change drops other people's data but keeps the /me query", () => {
    const qc = new QueryClient();
    qc.setQueryData(["me"], inState("b"));
    qc.setQueryData(["agents"], [1]);
    resetSessionState(qc, "identity_changed");
    expect(qc.getQueryData(["me"])).toBeTruthy();
    expect(qc.getQueryData(["agents"])).toBeUndefined();
  });
});

describe("useSessionLifecycle", () => {
  it("resets when a different person appears, and on in -> out", () => {
    const qc = new QueryClient();
    qc.setQueryData(["agents"], [1]);
    const { rerender } = renderHook(({ d }) => useSessionLifecycle(qc, d), { initialProps: { d: inState("a") as MeState } });
    expect(qc.getQueryData(["agents"])).toEqual([1]);
    rerender({ d: inState("b") });
    expect(qc.getQueryData(["agents"])).toBeUndefined();
    qc.setQueryData(["agents"], [2]);
    sessionStorage.setItem("gantry.draft.x", "t");
    noteUnauthorized();
    rerender({ d: outState });
    expect(qc.getQueryData(["agents"])).toBeUndefined();
    expect(sessionStorage.getItem("gantry.draft.x")).toBe("t"); // expired, drafts kept
  });
  it("a deliberate sign-out wipes drafts too", () => {
    const qc = new QueryClient();
    const { rerender } = renderHook(({ d }) => useSessionLifecycle(qc, d), { initialProps: { d: inState("a") as MeState } });
    sessionStorage.setItem("gantry.draft.x", "t");
    noteUnauthorized(0);
    rerender({ d: outState });
    expect(sessionStorage.getItem("gantry.draft.x")).toBeNull();
  });
});

describe("return_to", () => {
  it("is added only when there is a hash route", () => {
    expect(currentReturnTo("")).toBeNull();
    expect(currentReturnTo("#")).toBeNull();
    expect(loginUrlWithReturn("sso", undefined, "")).toBe("/auth/login?method=sso");
    expect(loginUrlWithReturn("sso", undefined, "#/p/pay/record/wo-1")).toBe("/auth/login?method=sso&return_to=%2F%23%2Fp%2Fpay%2Frecord%2Fwo-1");
    expect(loginUrlWithReturn("sso", "a@b.dev", "#home")).toContain("login_hint=a%40b.dev&return_to=");
  });
});

describe("watchPopupClosed", () => {
  it("fires after the window closes plus a grace period, and not if stopped first", () => {
    vi.useFakeTimers();
    const win = { closed: false };
    const onClosed = vi.fn();
    const stop = watchPopupClosed(win, onClosed, { pollMs: 100, graceMs: 300 });
    vi.advanceTimersByTime(500);
    expect(onClosed).not.toHaveBeenCalled();
    win.closed = true;
    vi.advanceTimersByTime(100);
    expect(onClosed).not.toHaveBeenCalled(); // grace
    vi.advanceTimersByTime(300);
    expect(onClosed).toHaveBeenCalledTimes(1);
    stop();

    const win2 = { closed: true };
    const cb2 = vi.fn();
    const stop2 = watchPopupClosed(win2, cb2, { pollMs: 100, graceMs: 300 });
    vi.advanceTimersByTime(100);
    stop2(); // success message arrived during grace
    vi.advanceTimersByTime(1000);
    expect(cb2).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
