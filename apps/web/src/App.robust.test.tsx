import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { canBatcher } from "./api/can";
import { invalidateSlices } from "./api/keys";
import { reloadPrefs } from "./lib/prefs";

const meBody = (id = "p-x") => ({
  person: { id, name: "Asha Raman", title: "Head", email: "asha@acme.dev", teams: [], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "asha", away: null },
  session: { id: "s1", person: id, method: "sso", device: "d", ip: "1", started: 0, lastSeen: 0, revoked: false },
  csrf: "csrf-1",
  projects: [],
  factory: { killed: null },
  config: { demoAccounts: false },
});

class FakeES {
  onopen: ((ev: Event) => unknown) | null = null;
  onerror = null;
  constructor() {
    setTimeout(() => this.onopen?.(new Event("open")), 0);
  }
  addEventListener() {}
  close() {}
}

let meMode: "ok" | "500" | "401" = "ok";
beforeEach(() => {
  meMode = "ok";
  vi.stubGlobal("EventSource", FakeES);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = (url as string).split("?")[0];
      if (path === "/api/v1/me") {
        if (meMode === "500") return new Response(JSON.stringify({ ok: false, msg: "boom" }), { status: 500 });
        if (meMode === "401") return new Response(JSON.stringify({ ok: false, msg: "Sign in.", config: { demoAccounts: false } }), { status: 401 });
        return new Response(JSON.stringify(meBody()));
      }
      if (path === "/api/v1/can") {
        const checks = (JSON.parse(String(init?.body)) as { checks: unknown[] }).checks;
        return new Response(JSON.stringify({ results: checks.map(() => ({ allowed: true, reason: "", needs: "" })) }));
      }
      return new Response(JSON.stringify({ approvals: [], conversations: [] }));
    }),
  );
  window.location.hash = "";
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  reloadPrefs();
  canBatcher.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("session robustness", () => {
  it("a failed /me refetch keeps the signed-in app mounted and shows a reconnect banner (P0 regression)", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Primary" });
    expect(document.getElementById("reconnect-banner")).toBeNull();

    meMode = "500";
    act(() => invalidateSlices(["session"]));
    const banner = await waitFor(() => {
      const el = document.getElementById("reconnect-banner");
      expect(el).toBeTruthy();
      return el!;
    }, { timeout: 5000 });
    expect(banner.getAttribute("role")).toBe("alert");
    // the app did not unmount: same nav element, no hard "could not be reached" screen
    expect(screen.getByRole("navigation", { name: "Primary" })).toBe(nav);
    expect(screen.queryByText(/could not be reached/)).toBeNull();
    expect(within(banner).getByRole("button", { name: "Retry" })).toBeTruthy();

    // recovery clears the banner
    meMode = "ok";
    act(() => within(banner).getByRole("button", { name: "Retry" }).click());
    await waitFor(() => expect(document.getElementById("reconnect-banner")).toBeNull());
  }, 15_000);

  it("a 401 after being signed in shows sign-in and clears storage that belongs to the session", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "Primary" });
    localStorage.setItem("gantry.navClosed", "x");
    localStorage.setItem("gantry.accessSim", "x");
    sessionStorage.setItem("gantry.stepup.draft", "{}");
    meMode = "401";
    // only the /me refetch sees the 401 here (nothing calls the API client's handler): still an expiry
    act(() => invalidateSlices(["session"]));
    await screen.findByText("Continue with Okta SSO");
    expect(localStorage.getItem("gantry.accessSim")).toBeNull();
    expect(localStorage.getItem("gantry.navClosed")).toBe("x");
    expect(sessionStorage.getItem("gantry.stepup.draft")).toBe("{}");
  });
  it("shows the connection state in the top bar", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "Primary" });
    await waitFor(() => expect(document.getElementById("conn-indicator")?.textContent).toMatch(/Live/));
  });
});
