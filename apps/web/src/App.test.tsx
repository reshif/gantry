import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { canBatcher } from "./api/can";
import { getPrefs, reloadPrefs, updatePrefs } from "./lib/prefs";

type Json = unknown;
const person = (roles: Array<{ role: string; scope: string }>) => ({ id: "p-x", name: "Asha Raman", title: "Head", email: "asha@acme.dev", teams: ["platform"], roles, status: "active", oncall: false, github: "asha", away: null });
const project = (id: string, extra: object = {}) => ({ id, name: id === "payments" ? "Payments Platform" : id, key: id.slice(0, 3).toUpperCase(), status: "active", halted: null, killed: null, ...extra });
const meBody = (o: { roles?: Array<{ role: string; scope: string }>; projects?: object[]; killed?: object | null; demo?: boolean } = {}) => ({
  person: person(o.roles ?? [{ role: "factory_admin", scope: "factory" }]),
  session: { id: "s1", person: "p-x", method: "sso", device: "d", ip: "1", started: 0, lastSeen: 0, revoked: false },
  csrf: "csrf-1",
  projects: o.projects ?? [project("payments"), project("risk")],
  factory: { killed: o.killed ?? null },
  config: { demoAccounts: !!o.demo },
});

function mockApi(routes: Record<string, (url: string, init?: RequestInit) => { status?: number; body: Json }>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const path = url.split("?")[0] ?? url;
      if (path === "/api/v1/can") {
        const checks = (JSON.parse(String(init?.body)) as { checks: unknown[] }).checks;
        return new Response(JSON.stringify({ results: checks.map(() => ({ allowed: true, reason: "", needs: "" })) }));
      }
      const h = routes[path];
      const r = h ? h(url, init) : { status: 404, body: { ok: false, msg: "none" } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

class FakeES {
  static instances: FakeES[] = [];
  onopen = null;
  onerror = null;
  constructor(public url: string) {
    FakeES.instances.push(this);
  }
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeES);
  window.location.hash = "";
  try { localStorage.clear(); } catch { /* ignore */ }
  reloadPrefs();
  canBatcher.clear();
  FakeES.instances = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("signed out", () => {
  it("shows the sign-in screen with SSO and GitHub, and no demo accounts by default", async () => {
    mockApi({ "/api/v1/me": () => ({ status: 401, body: { ok: false, msg: "Sign in.", config: { demoAccounts: false } } }) });
    render(<App />);
    await screen.findByText("Continue with SSO");
    expect(screen.getByText("Continue with GitHub")).toBeTruthy();
    expect(screen.queryByText(/Demo accounts/)).toBeNull();
    expect(document.querySelector(".auth-belt li")).toBeTruthy(); // stations from the catalogue
  });

  it("lists demo accounts only when config.demoAccounts is on, each linking with login_hint", async () => {
    mockApi({ "/api/v1/me": () => ({ status: 401, body: { ok: false, msg: "Sign in.", config: { demoAccounts: true } } }) });
    render(<App />);
    const link = (await screen.findByText("Asha Raman")).closest("a");
    expect(link?.getAttribute("href")).toBe("/auth/login?login_hint=asha%40acme.dev");
    expect(document.querySelectorAll("a.demo-acc")).toHaveLength(10);
  });

  it("SSO and GitHub buttons go to /auth/login with the method", async () => {
    mockApi({ "/api/v1/me": () => ({ status: 401, body: { ok: false, msg: "x" } }) });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, hash: "", search: "" });
    render(<App />);
    fireEvent.click(await screen.findByText("Continue with SSO"));
    fireEvent.click(screen.getByText("Continue with GitHub"));
    expect(assign.mock.calls).toEqual([["/auth/login?method=sso"], ["/auth/login?method=github"]]);
  });
});

describe("signed in", () => {
  it("renders the shell, nav groups for a factory admin, and the placeholder for the route", async () => {
    mockApi({ "/api/v1/me": () => ({ body: meBody() }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [], badges: { conversations: { n: 3, label: "3 conversations waiting for you" } } } }) });
    window.location.hash = "#floor";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(Array.from(nav.querySelectorAll(".nav-group-name")).map((e) => e.textContent)).toEqual(["Overview", "Project · Payments Platform", "Agents", "Connect", "Govern"]);
    expect(within(nav).getByText("Access")).toBeTruthy();
    expect(within(nav).queryByText("Work order record")).toBeNull(); // nav:false
    expect(await screen.findByText("The floor could not be loaded")).toBeTruthy();
    expect(within(nav).getByText("Floor").closest("a")?.getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(within(nav).getByTitle("3 conversations waiting for you").textContent).toBe("3"));
    expect(document.title).toBe("Floor · Gantry Software Factory");
    expect(FakeES.instances[0]?.url).toBe("/api/v1/stream");
  });

  it("hides routes the roles do not allow and falls back to home with a notice", async () => {
    mockApi({ "/api/v1/me": () => ({ body: meBody({ roles: [{ role: "engineer", scope: "payments" }] }) }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });
    window.location.hash = "#security";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).queryByText("Security")).toBeNull();
    expect(within(nav).queryByText("Agents")).toBeNull();
    expect(await screen.findByText("You do not have access to Security.")).toBeTruthy();
    expect(within(nav).getByText("Home").closest("a")?.getAttribute("aria-current")).toBe("page");
  });

  it("shows the factory kill banner from me.factory", async () => {
    mockApi({
      "/api/v1/me": () => ({ body: meBody({ killed: { by: "p-x", at: Date.now(), reason: "Bad deploy", mode: "hold" } }) }),
      "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }),
      "/api/v1/people": () => ({ body: [person([])] }),
    });
    render(<App />);
    expect((await screen.findByText("FACTORY KILLED")).closest(".stop-banner")?.className).toContain("is-kill");
    expect(document.getElementById("sysbanner")?.hasAttribute("hidden")).toBe(false);
  });

  it("collapses a nav group and persists the preference", async () => {
    mockApi({ "/api/v1/me": () => ({ body: meBody() }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });
    render(<App />);
    const btn = await screen.findByRole("button", { name: /Agents/ });
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem("gantry.prefs") ?? "{}").navCollapsed).toEqual({ Agents: true });
  });

  it("switches the project from the top bar", async () => {
    mockApi({ "/api/v1/me": () => ({ body: meBody() }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });
    render(<App />);
    const sel = (await screen.findByLabelText("Current project")) as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "risk" } });
    expect(getPrefs().project).toBe("risk");
    expect(await screen.findByText("Project: risk.")).toBeTruthy();
  });

  it("opens the command palette with Ctrl+K and runs a view", async () => {
    mockApi({ "/api/v1/me": () => ({ body: meBody() }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });
    render(<App />);
    await screen.findByRole("navigation", { name: "Main" });
    act(() => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    });
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "people" } });
    const opt = await waitFor(() => {
      const el = document.querySelector("#palette-list .pal-label");
      expect(el?.textContent).toBe("People & teams");
      return el as HTMLElement;
    });
    fireEvent.mouseDown(opt.closest("li") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe("#people"));
  });

  it("the user menu signs out through POST /auth/logout", async () => {
    const calls = mockApi({
      "/api/v1/me": () => ({ body: meBody() }),
      "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }),
      "/auth/logout": () => ({ body: { ok: true, msg: "Signed out." } }),
    });
    render(<App />);
    fireEvent.click(await screen.findByLabelText("Account menu for Asha Raman"));
    fireEvent.click(await screen.findByText("Sign out"));
    await waitFor(() => expect(calls).toContain("POST /auth/logout"));
  });

  it("stores local prefs defensively when storage throws", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(() => updatePrefs({ navRail: true })).not.toThrow();
    expect(getPrefs().navRail).toBe(true);
  });
});
