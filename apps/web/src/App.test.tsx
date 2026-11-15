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
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(Array.from(nav.querySelectorAll(".nav-group-name")).map((e) => e.textContent)).toEqual(["Overview", "Project", "Agents", "Connect", "Govern"]);
    expect(within(nav).getByText("Access")).toBeTruthy();
    expect(within(nav).queryByText("Work order record")).toBeNull(); // nav:false
    expect(await screen.findByText("The floor could not be loaded")).toBeTruthy();
    expect(within(nav).getByText("Floor").closest("a")?.getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(within(nav).getByTitle("3 conversations waiting for you").textContent).toBe("3"));
    expect(document.title).toBe("Floor · Payments Platform · Gantry Software Factory");
    expect(window.location.hash).toBe("#/p/payments/floor");
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

  const homeApi = () => mockApi({ "/api/v1/me": () => ({ body: meBody() }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });
  const headers = (nav: HTMLElement) => Array.from(nav.querySelectorAll<HTMLButtonElement>(".nav-group-btn"));

  it("shows every nav group open, remembers a collapsed group and keeps the current page's group open", async () => {
    sessionStorage.clear();
    localStorage.removeItem("gantry.navClosed");
    homeApi();
    window.location.hash = "#home";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const open = () => headers(nav).filter((h) => h.getAttribute("aria-expanded") === "true").map((h) => h.id);
    expect(open()).toEqual(["navg-overview-btn", "navg-agents-btn", "navg-connect-btn", "navg-govern-btn"]);
    expect(within(nav).getByText("Skills")).toBeTruthy();
    const [overview, , agents] = headers(nav) as [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement];
    fireEvent.click(agents);
    expect(agents.getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem("gantry.navClosed") || "[]")).toEqual(["Agents"]);
    fireEvent.click(overview); // the current page's group cannot be collapsed
    expect(overview.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(agents);
    fireEvent.click(within(nav).getByText("Skills"));
    await waitFor(() => expect(window.location.hash).toBe("#skills"));
    expect(agents.getAttribute("aria-expanded")).toBe("true");
    localStorage.removeItem("gantry.navClosed");
  });

  it("marks the group of the current page and moves between headers with arrow keys", async () => {
    sessionStorage.clear();
    homeApi();
    window.location.hash = "#/p/payments/floor";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const hs = headers(nav);
    await waitFor(() => expect(headers(nav).filter((h) => h.dataset.activeGroup === "true").map((h) => h.id)).toEqual(["navg-project-btn"]));
    expect(nav.querySelector("#navg-project-btn")?.getAttribute("aria-expanded")).toBe("true");
    hs[0]!.focus();
    fireEvent.keyDown(hs[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(hs[1]);
    fireEvent.keyDown(hs[1]!, { key: "End" });
    expect(document.activeElement).toBe(hs[hs.length - 1]);
  });

  it("puts the one project switcher in the top bar after the logo, none in the sidebar", async () => {
    sessionStorage.clear();
    homeApi();
    window.location.hash = "#home";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const top = document.querySelector("#topbar") as HTMLElement;
    expect(top.querySelector("select")).toBeNull();
    expect(screen.queryByLabelText("Current project")).toBeNull();
    expect(document.querySelectorAll("#project-switcher").length).toBe(1);
    expect(nav.querySelector("#project-switcher")).toBeNull();
    const sw = top.querySelector("#project-switcher") as HTMLElement;
    expect(sw).toBeTruthy();
    expect(top.querySelector(".brand")?.compareDocumentPosition(sw)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(nav).queryByText("All projects")).toBeNull();
    expect(nav.querySelector("#navg-project-btn")?.textContent).not.toContain("Payments");
    act(() => { window.location.hash = "#/p/payments/floor"; });
    await waitFor(() => expect(top.querySelector("#project-switcher")?.textContent).toContain("Payments Platform"));
    expect(document.querySelector("#crumb")?.textContent).toBe("Floor"); // page path only, no project name
  });

  it("keeps the top bar calm: no demo pill, compact status, avatar-only user, Search field", async () => {
    mockApi({ "/api/v1/me": () => ({ body: meBody({ demo: true }) }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });
    window.location.hash = "#home";
    render(<App />);
    await screen.findByRole("navigation", { name: "Main" });
    const top = document.querySelector("#topbar") as HTMLElement;
    expect(top.textContent).not.toContain("Demo accounts on");
    expect(top.querySelector(".dev-dot")).toBeTruthy();
    expect(top.querySelector("#status-cluster")?.textContent).toBe("Running");
    expect(top.querySelector(".user-name")).toBeNull();
    expect(top.querySelector(".palette-label")?.textContent).toBe("Search");
  });

  it("icon rail shows only the five group buttons; a group opens a flyout of its items; one toggle", async () => {
    sessionStorage.clear();
    homeApi();
    window.location.hash = "#/p/payments/floor";
    updatePrefs({ navRail: true });
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(nav.querySelector("#nav-rail-toggle")).toBeNull();
    expect(nav.querySelectorAll("a.nav-link").length).toBe(0);
    const hs = Array.from(nav.querySelectorAll<HTMLButtonElement>(".nav-group-btn"));
    expect(hs.map((h) => h.getAttribute("aria-label"))).toEqual(["Overview", "Project", "Agents", "Connect", "Govern"]);
    expect(hs.filter((h) => h.dataset.activeGroup === "true").map((h) => h.id)).toEqual(["navg-project-btn"]);
    expect(hs.every((h) => h.getAttribute("aria-haspopup") === "menu")).toBe(true);
    fireEvent.click(hs[2]!);
    expect(hs[2]!.getAttribute("aria-expanded")).toBe("true");
    const menu = await screen.findByRole("menu", { name: "Agents" });
    expect(within(menu).getAllByRole("menuitem").map((e) => e.textContent)).toContain("Skills");
    // the single toggle is the top-bar menu button
    fireEvent.click(screen.getByLabelText("Toggle navigation"));
    expect(getPrefs().navRail).toBe(false);
  });

  it("disables the PROJECT group and asks to choose a project when none is selected", async () => {
    sessionStorage.clear();
    homeApi();
    window.location.hash = "#home";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(document.querySelector("#project-switcher")?.textContent).toBe("Choose a project");
    const h = nav.querySelector("#navg-project-btn") as HTMLButtonElement;
    expect(h.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(h);
    expect(h.getAttribute("aria-expanded")).toBe("false");
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
    expect((await screen.findByText("All projects (portfolio)")).getAttribute("href")).toBe("#projects");
    const search = await screen.findByLabelText("Find a project");
    fireEvent.change(search, { target: { value: "ris" } });
    const link = await screen.findByRole("link", { name: "risk" });
    expect(link.getAttribute("href")).toBe("#/p/risk/work-orders");
    fireEvent.click(link);
    act(() => { window.location.hash = "#/p/risk/work-orders"; });
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
