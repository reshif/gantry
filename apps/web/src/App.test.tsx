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
  it("shows the sign-in screen with SSO (no GitHub button, as the prototype), and no demo accounts by default", async () => {
    mockApi({ "/api/v1/me": () => ({ status: 401, body: { ok: false, msg: "Sign in.", config: { demoAccounts: false } } }) });
    render(<App />);
    await screen.findByText("Continue with SSO");
    expect(screen.queryByText("Continue with GitHub")).toBeNull();
    expect(screen.queryByText(/Demo accounts/)).toBeNull();
    expect(document.querySelector(".belt-card .tok")).toBeTruthy(); // the belt-card preview of the prototype
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

  it("the SSO button goes to /auth/login with the method", async () => {
    mockApi({ "/api/v1/me": () => ({ status: 401, body: { ok: false, msg: "x" } }) });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, hash: "", search: "" });
    render(<App />);
    fireEvent.click(await screen.findByText("Continue with SSO"));
    expect(assign.mock.calls).toEqual([["/auth/login?method=sso"]]);
  });
});

describe("signed in", () => {
  it("renders the Control Room shell: top bar, rail groups, status bar and the route", async () => {
    mockApi({ "/api/v1/me": () => ({ body: meBody() }), "/api/v1/home": () => ({ body: { approvals: [{ wo: "WO-1", gate: "G2", project: "payments", projectName: "Payments Platform" }, { wo: "WO-2", gate: "G4", project: "payments", projectName: "Payments Platform" }], conversations: [{ wo: "WO-3", title: "Q", project: "payments" }], badges: { floor: { n: 9 } } } }) });
    window.location.hash = "#floor";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(Array.from(nav.querySelectorAll(".navgrp")).map((e) => e.textContent)).toEqual(["Operate", "Portfolio", "Workforce", "Connect", "Govern", "Reference"]);
    expect(within(nav).getByText("Access")).toBeTruthy();
    expect(within(nav).queryByText("Work order record")).toBeNull(); // nav:false
    expect(await screen.findByText("This view failed to load")).toBeTruthy(); // the shared failed state (ui/async)
    expect(within(nav).getByText("Floor").closest("a")?.getAttribute("aria-current")).toBe("page");
    // one badge on the rail, as in the prototype: the Inbox counts approvals plus questions; Floor carries none
    await waitFor(() => expect(within(nav).getByTitle("3 waiting for you").textContent).toBe("3"));
    expect(nav.querySelectorAll(".badge")).toHaveLength(1);
    expect(Array.from(nav.querySelectorAll(".navlink span:not(.badge)")).map((e) => e.textContent).slice(0, 7)).toEqual(["Home", "Inbox", "Floor", "Work orders", "Agents at work", "Conversations", "Console"]);
    expect(document.title).toBe("Floor · Payments Platform · Gantry Control Room");
    expect(window.location.hash).toBe("#/p/payments/floor");
    expect(document.querySelector("#app.app > .top")).toBeTruthy();
    expect(document.querySelector("#app.app > footer.sbar #clock")?.textContent).toMatch(/^\d\d:\d\d:\d\d UTC$/);
    expect(document.querySelector("#app.app > footer.sbar")?.textContent).toContain("WORKERS");
    expect(FakeES.instances[0]?.url).toBe("/api/v1/stream");
  });

  it("puts the one project switcher in the top bar after the logo, none in the rail", async () => {
    sessionStorage.clear();
    homeApi();
    window.location.hash = "#home";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const top = document.querySelector("#topbar") as HTMLElement;
    expect(document.querySelectorAll("#project-switcher").length).toBe(1);
    expect(nav.querySelector("#project-switcher")).toBeNull();
    const sw = top.querySelector("#project-switcher") as HTMLElement;
    expect(top.querySelector(".brand")?.compareDocumentPosition(sw)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    act(() => { window.location.hash = "#/p/payments/floor"; });
    await waitFor(() => expect(top.querySelector("#project-switcher")?.textContent).toContain("Payments Platform"));
    expect(document.querySelector("#crumb")?.textContent).toBe("Floor"); // screen-reader path only
  });

  it("keeps the top bar to the prototype's set: brand, switcher, palette, theme, bell, avatar", async () => {
    mockApi({ "/api/v1/me": () => ({ body: meBody({ demo: true }) }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });
    window.location.hash = "#home";
    render(<App />);
    await screen.findByRole("navigation", { name: "Main" });
    const top = document.querySelector("#topbar") as HTMLElement;
    expect(top.textContent).not.toContain("Demo accounts on");
    expect(top.querySelector(".dev-dot")).toBeNull();
    expect((top.querySelector("#user-menu") as HTMLElement).title).toContain("non-production");
    expect(top.querySelector("#palette-btn")?.textContent).toContain("Search or jump to");
    expect(top.querySelectorAll(".themesw button").length).toBe(3);
  });

  it("switches the theme from the three-way control and remembers it", async () => {
    sessionStorage.clear();
    homeApi();
    window.location.hash = "#home";
    render(<App />);
    await screen.findByRole("navigation", { name: "Main" });
    fireEvent.click(screen.getByRole("button", { name: "Dark theme" }));
    expect(getPrefs().theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Dark theme" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Light theme" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("opens project routes on the remembered or first project, and the switcher starts at All projects", async () => {
    sessionStorage.clear();
    homeApi();
    window.location.hash = "#home";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(document.querySelector("#project-switcher")?.textContent).toContain("All projects");
    for (const name of ["Floor", "Conversations", "Project config"]) expect((within(nav).getByText(name).closest("a") as HTMLAnchorElement).getAttribute("href")).toMatch(/^#\/p\/[a-z-]+\//);
  });

  it("hides routes the roles do not allow and says so on the page asked for", async () => {
    mockApi({ "/api/v1/me": () => ({ body: meBody({ roles: [{ role: "engineer", scope: "payments" }] }) }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });
    window.location.hash = "#security";
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).queryByText("Security")).toBeNull();
    expect(within(nav).queryByText("Agents")).toBeNull();
    expect(await screen.findByText("Security isn't available to your roles")).toBeTruthy();
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
    expect((await screen.findByText("Factory stopped.")).closest(".stop-banner")?.className).toContain("is-kill");
    expect(document.getElementById("sysbanner")?.hasAttribute("hidden")).toBe(false);
  });

  const homeApi = () => mockApi({ "/api/v1/me": () => ({ body: meBody() }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });







  it("the project switcher is a menu: filter, All projects, rows with a key tag and a check; picking one keeps the page and toasts", async () => {
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
    const menu = await screen.findByRole("menu", { name: "Projects" });
    expect(sw.getAttribute("aria-haspopup")).toBe("menu");
    expect(within(menu).getByRole("menuitemradio", { name: /All projects/ }).getAttribute("aria-checked")).toBe("false");
    expect(within(menu).getByRole("menuitemradio", { name: /Payments Platform/ }).getAttribute("aria-checked")).toBe("true");
    const search = await screen.findByLabelText("Find project");
    fireEvent.change(search, { target: { value: "ris" } });
    const row = await screen.findByRole("menuitemradio", { name: /risk/i });
    expect(row.querySelector(".tag")).toBeTruthy();
    fireEvent.click(row);
    await waitFor(() => expect(window.location.hash).toBe("#/p/risk/work-orders"));
    expect(await screen.findByText(/^Showing /)).toBeTruthy();
    expect(getPrefs().scopeAll).toBe(false);
  });

  it("All projects in the switcher sets the portfolio scope and toasts", async () => {
    sessionStorage.clear();
    homeApi();
    window.location.hash = "#home";
    render(<App />);
    await screen.findByRole("navigation", { name: "Main" });
    act(() => { updatePrefs({ scopeAll: false, project: "payments" }); });
    expect(document.querySelector("#project-switcher")?.textContent).toContain("Payments");
    fireEvent.click(document.querySelector("#project-switcher") as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /All projects/ }));
    expect(await screen.findByText("Showing All projects")).toBeTruthy();
    expect(getPrefs().scopeAll).toBe(true);
    expect(document.querySelector("#project-switcher")?.textContent).toContain("All projects");
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
    expect(input.getAttribute("placeholder")).toBe("Jump to a screen, work order, agent, person…");
    expect(document.querySelector(".pal-foot")?.textContent).toContain("↑↓ move · Enter open · Esc close");
    fireEvent.change(input, { target: { value: "people" } });
    const opt = await waitFor(() => {
      const el = document.querySelector("#palette-list .pal-label");
      expect(el?.textContent).toBe("People");
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

  const shellApi = () =>
    mockApi({
      "/api/v1/me": () => ({ body: meBody() }),
      "/api/v1/home": () => ({ body: { approvals: [{ wo: "WO-1", gate: "G2", gateLabel: "G2", gateName: "Spec", title: "Rate limit", project: "payments", projectName: "Payments Platform" }], conversations: [] } }),
      "/api/v1/activity": () => ({ body: [{ id: 5, at: Date.now() - 60_000, type: "wo.enter", wo: "WO-9", station: "build", project: "payments" }] }),
    });

  it("the theme menu lists System, Dark, Light as radio items with a check on the chosen one", async () => {
    shellApi();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^Theme: / }));
    const menu = await screen.findByRole("menu", { name: "Theme" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["System", "Dark", "Light"]);
    expect(items[0]!.getAttribute("aria-checked")).toBe("true");
    expect(items[0]!.querySelector("svg:last-child")).toBeTruthy();
    fireEvent.click(items[1]!);
    expect(getPrefs().theme).toBe("dark");
  });

  it("the user menu heads with the title and role names and links to the account page and carries Sign out, not theme rows", async () => {
    shellApi();
    render(<App />);
    fireEvent.click(await screen.findByLabelText("Account menu for Asha Raman"));
    const menu = await screen.findByRole("menu", { name: "Account menu" });
    expect(menu.querySelector(".mh")?.textContent).toBe("Asha RamanHead · Factory Admin");
    expect(menu.querySelector(".mh")?.getAttribute("role")).toBe("link");
    expect(within(menu).getByText("Sign out")).toBeTruthy();
    expect(within(menu).queryByText(/Theme/)).toBeNull();
  });

  it("the bell opens a Notifications drawer (Recent activity, waiting items then events, settings and Close) and the dot clears", async () => {
    shellApi();
    render(<App />);
    const bell = await screen.findByRole("button", { name: "Notifications" });
    await waitFor(() => expect(bell.querySelector(".dot")).toBeTruthy());
    fireEvent.click(bell);
    const drawer = await screen.findByRole("dialog", { name: "Details" });
    expect(within(drawer).getByText("Recent activity")).toBeTruthy();
    expect(within(drawer).getByText("Notifications").className).toContain("label");
    await waitFor(() => expect(drawer.querySelectorAll(".li")).toHaveLength(2));
    expect(drawer.querySelector(".li .t1")?.textContent).toContain("WO-1");
    expect(within(drawer).getByRole("link", { name: "Notification settings" }).getAttribute("href")).toBe("#notifications");
    expect(drawer.querySelector(".drawer-f .btn:last-child")?.textContent).toBe("Close");
    fireEvent.click(drawer.querySelector(".drawer-f .btn:last-child") as HTMLElement);
    await waitFor(() => expect(document.querySelector(".drawer")).toBeNull());
    expect(document.querySelector("#inbox-btn .dot")).toBeNull();
  });

  it("the hamburger is labelled Open navigation and reports its state (the rail is a drawer up to 1100px)", async () => {
    shellApi();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    render(<App />);
    const btn = await screen.findByRole("button", { name: "Open navigation" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute("aria-expanded")).toBe("true"));
  });

  it("the palette groups results (Go to, Actions, Projects, ...) and says No results", async () => {
    shellApi();
    render(<App />);
    await screen.findByRole("navigation", { name: "Main" });
    act(() => { fireEvent.keyDown(document, { key: "k", ctrlKey: true }); });
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    expect(input.getAttribute("placeholder")).toBe("Jump to a screen, work order, agent, person…");
    await waitFor(() => expect(Array.from(document.querySelectorAll("#palette-list .pal-grp")).map((e) => e.textContent)).toEqual(expect.arrayContaining(["Go to", "Actions", "Projects"])));
    const labels = Array.from(document.querySelectorAll("#palette-list .pal-label")).map((e) => e.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Conversations", "Console", "Toggle theme (dark / light)", "Emergency stop the factory…", "Mark all notifications read", "Submit a work order"].filter((l) => l !== "Submit a work order")));
    fireEvent.change(input, { target: { value: "zzzzqq" } });
    expect(await screen.findByText("No results")).toBeTruthy();
  });

  it("an address that names no page shows Page not found with a Go Home link", async () => {
    shellApi();
    window.location.hash = "#/nowhere-at-all";
    render(<App />);
    expect(await screen.findByText("Page not found")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go Home" }).getAttribute("href")).toBe("#home");
  });

  it("? outside a field toasts the shortcuts", async () => {
    shellApi();
    render(<App />);
    await screen.findByRole("navigation", { name: "Main" });
    act(() => { fireEvent.keyDown(document.body, { key: "?" }); });
    expect(await screen.findByText(/Shortcuts: Ctrl\+K/)).toBeTruthy();
  });

  it("the status bar shows throughput, workers and a UTC clock", async () => {
    shellApi();
    render(<App />);
    await screen.findByRole("navigation", { name: "Main" });
    const bar = document.querySelector("#statusbar") as HTMLElement;
    await waitFor(() => expect(bar.querySelector("#sb-throughput")?.textContent).toBe("THROUGHPUT 0.2/h"));
    expect(bar.querySelector("#sb-workers")?.textContent).toContain("WORKERS");
    expect(bar.querySelector("#clock")?.textContent).toMatch(/UTC$/);
    expect(bar.textContent).not.toContain("SHIPPED TODAY");
  });

  it("stores local prefs defensively when storage throws", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(() => updatePrefs({ navRail: true })).not.toThrow();
    expect(getPrefs().navRail).toBe(true);
  });
});
