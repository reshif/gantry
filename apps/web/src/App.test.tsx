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
  onopen: ((ev: Event) => unknown) | null = null;
  onerror = null;
  constructor(public url: string) {
    FakeES.instances.push(this);
    setTimeout(() => this.onopen?.(new Event("open")), 0);
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
    expect(document.querySelector("main.signin .panel")).toBeTruthy();
  });

  it("shows the guided two-step setup screen when the server says a Factory Admin needs a second factor", async () => {
    mockApi({ "/api/v1/me": () => ({ status: 401, body: { ok: false, msg: "Factory Admins sign in with two steps.", needs: "mfa_setup", config: { demoAccounts: false } } }) });
    render(<App />);
    await screen.findByText("Set up two-step sign-in");
    expect(document.getElementById("auth-mfa-go")).toBeTruthy();
    expect(screen.queryByText("Continue with GitHub")).toBeNull();
  });

  it("lists demo accounts only when config.demoAccounts is on, each linking with login_hint", async () => {
    mockApi({ "/api/v1/me": () => ({ status: 401, body: { ok: false, msg: "Sign in.", config: { demoAccounts: true } } }) });
    render(<App />);
    const link = (await screen.findByText("Asha Raman")).closest("a");
    expect(link?.getAttribute("href")).toBe("/auth/login?login_hint=asha%40acme.dev");
    expect(document.querySelectorAll("a.demo-acc")).toHaveLength(15);
  });

  it("lists the server's demo accounts with their real roles, and says nothing about MFA", async () => {
    const list = [
      { id: "p-asha", name: "Asha Raman", email: "asha@acme.dev", role: "Factory Admin", note: "Sensitive actions ask for a fresh sign-in." },
      { id: "p-tomas", name: "Tomás Ferreira", email: "tomas@acme.dev", role: "Engineer on Payments; Reviewer on Storefront (via QA)", note: "Teams: QA." },
      { id: "p-grace", name: "Grace Liu", email: "grace@acme.dev", role: "No roles yet", note: "Not in the organisation yet." },
    ];
    mockApi({ "/api/v1/me": () => ({ status: 401, body: { ok: false, msg: "Sign in.", config: { demoAccounts: true, demoAccountList: list } } }) });
    render(<App />);
    await screen.findByText("Asha Raman");
    expect(document.querySelectorAll("a.demo-acc")).toHaveLength(3);
    expect(document.getElementById("demo-p-tomas")?.textContent).toContain("Reviewer on Storefront (via QA)");
    expect(document.getElementById("demo-p-grace")?.textContent).toContain("No roles yet");
    expect(document.querySelector(".auth-demo")?.textContent).not.toMatch(/MFA/);
  });

  it("the fallback list (server sent none) claims no permissions and no MFA", async () => {
    mockApi({ "/api/v1/me": () => ({ status: 401, body: { ok: false, msg: "Sign in.", config: { demoAccounts: true } } }) });
    render(<App />);
    await screen.findByText("Asha Raman");
    const text = document.querySelector(".auth-demo")?.textContent ?? "";
    expect(text).not.toMatch(/MFA|Factory Admin|Engineer/);
    expect(text).toContain("People & teams");
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
    const nav = await screen.findByRole("navigation", { name: "Primary" });
    expect(Array.from(nav.querySelectorAll(".nav h3")).map((e) => e.textContent)).toEqual(["Overview", "Project line", "Agents", "Connect", "Govern", "Reference"]);
    expect(within(nav).getByText("Access")).toBeTruthy();
    expect(within(nav).queryByText("Work order record")).toBeNull(); // nav:false
    expect(await screen.findByText("Couldn't load the floor")).toBeTruthy(); // the shared failed state (ui/async)
    expect(within(nav).getByText("Floor").closest("a")?.getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(within(nav).getAllByTitle("3 conversations waiting for you")[0]?.textContent).toBe("3"));
    expect(document.title).toBe("Floor · Gantry Blueprint");
    expect(window.location.hash).toBe("#/p/payments/floor");
    expect(FakeES.instances[0]?.url).toBe("/api/v1/stream");
  });

  it("hides routes the roles do not allow and says so on the page asked for", async () => {
    mockApi({ "/api/v1/me": () => ({ body: meBody({ roles: [{ role: "engineer", scope: "payments" }] }) }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });
    window.location.hash = "#security";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Primary" });
    expect(within(nav).queryByText("Security")).toBeNull();
    expect(within(nav).queryByText("Agents")).toBeNull();
    expect(await screen.findByText("No access to this sheet")).toBeTruthy();
    expect(window.location.hash).toBe("#security");
    expect(within(nav).getByText("Home").closest("a")?.getAttribute("aria-current")).toBeNull();
  });

  it("shows the factory kill banner from me.factory", async () => {
    mockApi({
      "/api/v1/me": () => ({ body: meBody({ killed: { by: "p-x", at: Date.now(), reason: "Bad deploy", mode: "hold" } }) }),
      "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }),
      "/api/v1/people": () => ({ body: [person([])] }),
    });
    render(<App />);
    expect((await screen.findByText("Factory emergency stop is active.")).closest(".banner")?.className).toContain("is-kill");
  });

  const homeApi = () => mockApi({ "/api/v1/me": () => ({ body: meBody() }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });

  it("puts the one project switcher in the top bar after the logo, none in the sidebar", async () => {
    sessionStorage.clear();
    homeApi();
    window.location.hash = "#home";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Primary" });
    const top = document.querySelector("#topbar") as HTMLElement;
    expect(top.querySelector("select")).toBeNull();
    expect(screen.queryByLabelText("Current project")).toBeNull();
    expect(document.querySelectorAll("#project-switcher").length).toBe(1);
    expect(nav.querySelector("#project-switcher")).toBeNull();
    const sw = top.querySelector("#project-switcher") as HTMLElement;
    expect(sw).toBeTruthy();
    expect(nav.querySelector(".brand")).toBeTruthy(); // the mark and name live on the sidebar sheet
    expect(within(nav).queryByText("All projects")).toBeNull();
    act(() => { window.location.hash = "#/p/payments/floor"; });
    await waitFor(() => expect(top.querySelector("#project-switcher")?.textContent).toContain("Payments Platform"));
  });

  it("keeps the top bar calm: no demo pill, compact status, avatar-only user, Search field", async () => {
    mockApi({ "/api/v1/me": () => ({ body: meBody({ demo: true }) }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });
    window.location.hash = "#home";
    render(<App />);
    await screen.findByRole("navigation", { name: "Primary" });
    const top = document.querySelector("#topbar") as HTMLElement;
    expect(top.textContent).not.toContain("Demo accounts on");
    // the non-production marker rides on the account button, reachable via its title
    const acct = top.querySelector("#user-menu") as HTMLElement;
    expect(acct.title).toContain("non-production");
    await waitFor(() => expect(top.querySelector("#status-cluster")?.textContent).toBe("Live"));
    expect(top.querySelector(".user-name")).toBeNull();
    expect(top.querySelector(".palette-label")?.textContent).toBe("Search or jump to…");
  });

  it("switches project from the sidebar switcher and keeps the page", async () => {
    sessionStorage.clear();
    homeApi();
    window.location.hash = "#/p/payments/work-orders";
    render(<App />);
    const sw = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>("#project-switcher");
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(sw);
    // a prototype menu: PROJECT LINE heading, All projects, then one entry per project
    expect((await screen.findAllByText("Project line")).length).toBeGreaterThan(0);
    expect(await screen.findByRole("menuitem", { name: /All projects/ })).toBeTruthy();
    fireEvent.click(await screen.findByRole("menuitem", { name: /risk/ }));
    await waitFor(() => expect(getPrefs().project).toBe("risk"));
  });

  it("shows a clear no-access page for a project the person cannot see", async () => {
    homeApi();
    window.location.hash = "#/p/secret/floor";
    render(<App />);
    expect(await screen.findByText("You do not have access to this project")).toBeTruthy();
  });

  it("redirects legacy hashes to the project form and lands single-project people on their Floor", async () => {
    mockApi({ "/api/v1/me": () => ({ body: meBody({ roles: [{ role: "engineer", scope: "payments" }], projects: [project("payments")] }) }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });
    window.location.hash = "";
    render(<App />);
    await waitFor(() => expect(window.location.hash).toBe("#/p/payments/floor"));
  });

  it("shows only a no-access landing for a person with no grants", async () => {
    mockApi({ "/api/v1/me": () => ({ body: meBody({ roles: [], projects: [] }) }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });
    window.location.hash = "#home";
    render(<App />);
    expect(await screen.findByText("No access yet")).toBeTruthy();
  });

  it("opens the command palette with Ctrl+K and runs a view", async () => {
    mockApi({ "/api/v1/me": () => ({ body: meBody() }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });
    render(<App />);
    await screen.findByRole("navigation", { name: "Primary" });
    act(() => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    });
    const input = await screen.findByRole("combobox", { name: "Command palette" });
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
