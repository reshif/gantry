import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { render, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import type { MeState } from "../../api/queries";
import { classifyEnd, deriveSession, noteSignedOut, noteUnauthorized, registerSessionReset, resetSessionState, useSessionLifecycle } from "./session";
import { getPrefs, resetPrefsInMemory, updatePrefs, reloadPrefs } from "../prefs";
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
    // layout choices are not sensitive and survive an expiry; other gantry.* keys go
    expect(localStorage.getItem("gantry.prefs")).toBe("{}");
    localStorage.setItem("gantry.other", "x");
    resetSessionState(new QueryClient(), "expired");
    expect(localStorage.getItem("gantry.other")).toBeNull();
  });
  it("sign-out and identity change drop prefs and drafts; the chunk-reload guard always survives", () => {
    for (const reason of ["signed_out", "identity_changed"] as const) {
      localStorage.setItem("gantry.prefs", "{}");
      sessionStorage.setItem("gantry.stepup.draft", "{}");
      sessionStorage.setItem("gantry.chunk-reload", "123");
      resetSessionState(new QueryClient(), reason);
      expect(localStorage.getItem("gantry.prefs")).toBeNull();
      expect(sessionStorage.getItem("gantry.stepup.draft")).toBeNull();
      expect(sessionStorage.getItem("gantry.chunk-reload")).toBe("123");
    }
  });
  it("registered stores learn the reason, so prefs reset in memory unless the session only expired", () => {
    updatePrefs({ theme: "dark" });
    const seen: string[] = [];
    const off = registerSessionReset((r) => {
      seen.push(r);
      if (r !== "expired") resetPrefsInMemory();
    });
    resetSessionState(new QueryClient(), "expired");
    expect(getPrefs().theme).toBe("dark");
    resetSessionState(new QueryClient(), "signed_out");
    expect(getPrefs().theme).toBe("system");
    expect(seen).toEqual(["expired", "signed_out"]);
    off();
    reloadPrefs();
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

describe("expiry classification", () => {
  it("a /me 401 alone (noteUnauthorized, no other call) is an expiry; a deliberate sign-out wins even with a 401", () => {
    const t = 1_000_000;
    noteUnauthorized(t);
    expect(classifyEnd(t + 1000)).toBe("expired");
    expect(classifyEnd(t + 60_000)).toBe("signed_out");
    noteSignedOut(t + 2000);
    expect(classifyEnd(t + 3000)).toBe("signed_out");
  });
  it("an expiry found by /me keeps the step-up draft through the lifecycle hook; identity change wipes it", () => {
    const qc = new QueryClient();
    const { rerender } = renderHook(({ d }) => useSessionLifecycle(qc, d), { initialProps: { d: inState("a") as MeState } });
    sessionStorage.setItem("gantry.stepup.draft", "{}");
    noteSignedOut(0);
    noteUnauthorized();
    rerender({ d: outState });
    expect(sessionStorage.getItem("gantry.stepup.draft")).toBe("{}");
    rerender({ d: inState("a") });
    rerender({ d: inState("b") });
    expect(sessionStorage.getItem("gantry.stepup.draft")).toBeNull();
  });
  it("on identity change the previous person's cache is gone in the layout phase, before paint", () => {
    const qc = new QueryClient();
    qc.setQueryData(["agents"], ["old person data"]);
    let seen: unknown = "unset";
    function Probe({ d }: { d: MeState }) {
      useSessionLifecycle(qc, d);
      // declared after the hook: runs in the same commit, so a passive reset would not have happened yet
      useLayoutEffect(() => {
        if (d.status === "in" && d.me.person.id === "b") seen = qc.getQueryData(["agents"]);
      });
      return null;
    }
    const { rerender } = render(<Probe d={inState("a")} />);
    rerender(<Probe d={inState("b")} />);
    expect(seen).toBeUndefined();
  });
});

describe("return_to", () => {
  it("never sends the window hash twice when a hash is passed in", () => {
    window.location.hash = "#/floor";
    try {
      expect(loginUrlWithReturn("sso", undefined, "#/p/pay")).toBe("/auth/login?method=sso&return_to=%2F%23%2Fp%2Fpay");
    } finally { window.location.hash = ""; }
  });
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
