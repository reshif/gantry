/** The shell against the prototype: nav entries and destinations, menus, drawers, the not-found sheet and the dialogs. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { canBatcher } from "../api/can";
import { reloadPrefs } from "../lib/prefs";

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
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const api = (home: object = { approvals: [], conversations: [] }) =>
  mockApi({ "/api/v1/me": () => ({ body: meBody() }), "/api/v1/home": () => ({ body: home }) });
const nav = async () => within(await screen.findByRole("navigation", { name: "Primary" }));

describe("shell fidelity", () => {
  it("lists Console and Conversations in the side nav, linking to their routes", async () => {
    api();
    window.location.hash = "#/home";
    render(<App />);
    const n = await nav();
    expect(n.getByText("Console").closest("a")?.getAttribute("href")).toBe("#console");
    expect(n.getByText("Conversations").closest("a")?.getAttribute("href")).toMatch(/conversations$/);
    expect(n.getByText("Audit ledger").closest("a")?.getAttribute("href")).toBe("#audit");
  });

  it("shows the Sheet not found page for an unknown route, with Go home", async () => {
    api();
    window.location.hash = "#/nonexistent";
    render(<App />);
    expect(await screen.findByText("Sheet not found")).toBeTruthy();
    expect(screen.getByText('There is no route called "nonexistent".')).toBeTruthy();
    expect(screen.getByText("Nothing drawn here")).toBeTruthy();
    expect(document.title).toBe("nonexistent · Gantry Blueprint");
    fireEvent.click(screen.getByRole("button", { name: "Go home" }));
    await waitFor(() => expect(window.location.hash).toBe("#home"));
  });

  it("opens the Line control menu from the LIVE chip", async () => {
    api();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Line control/ }));
    expect(await screen.findByText("Line control", { selector: ".micro" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Halt line/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Emergency stop/ })).toBeTruthy();
  });

  it("My account reaches the Account page with its sections, even for a person who may view people", async () => {
    api();
    window.location.hash = "#/home";
    render(<App />);
    fireEvent.click(await screen.findByLabelText("Account menu for Asha Raman"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /My account/ }));
    await waitFor(() => expect(window.location.hash).toBe("#account"));
    expect(await screen.findByRole("tab", { name: "Sessions" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Preferences" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Linked accounts" })).toBeTruthy();
  });

  it("drops stale acc.* and ppl.* query keys when another screen opens", async () => {
    api();
    window.history.replaceState(null, "", "/?acc.tab=check&ppl.tab=teams");
    window.location.hash = "#/home";
    render(<App />);
    await nav();
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("opens the Notifications drawer from the bell, with its two footer actions", async () => {
    api({ approvals: [{ wo: "WO-2417", gate: "G3", gateLabel: "G3", title: "Refund keys", project: "payments" }], conversations: [] });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    expect(await screen.findByText("Gate requests, questions and system messages")).toBeTruthy();
    expect(await screen.findByText("WO-2417 needs your approval")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notification routes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(window.location.hash).toContain("record/WO-2417"));
  });

  it("the account menu offers My account and Sign out, and the theme menu lists three themes", async () => {
    api();
    render(<App />);
    fireEvent.click(await screen.findByLabelText("Account menu for Asha Raman"));
    expect(await screen.findByText("My account")).toBeTruthy();
    act(() => { fireEvent.keyDown(document, { key: "Escape" }); });
    fireEvent.click(await screen.findByRole("button", { name: /^Theme:/ }));
    expect(await screen.findByRole("menuitem", { name: /Dark · blueprint/ })).toBeTruthy();
  });

  it("the palette uses the prototype copy and Go to hints, and has a Toggle theme action", async () => {
    api();
    render(<App />);
    await nav();
    act(() => { fireEvent.keyDown(document, { key: "k", ctrlKey: true }); });
    const input = await screen.findByPlaceholderText("Jump to a screen, work order, agent, repo or action…");
    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(await screen.findByText("No matches")).toBeTruthy();
    fireEvent.change(input, { target: { value: "theme" } });
    await waitFor(() => expect(document.querySelector("#palette-list .pal-label")?.textContent).toBe("Toggle theme"));
    fireEvent.change(input, { target: { value: "console" } });
    await waitFor(() => expect(document.querySelector("#palette-list .pal-hint")?.textContent).toBe("Go to · Overview"));
  });

  it("the Line control menu matches the Floor one: project halt, repos, whole factory", async () => {
    api();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Line control/ }));
    await screen.findByRole("menuitem", { name: /Halt line/ });
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(expect.arrayContaining(["Halt line (pause the project)", "Emergency stop"]));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)[0]).toBe("Halt line (pause the project)");
    expect(screen.getByText("Whole factory")).toBeTruthy(); // same sections as the Floor menu
  });

  it("the account menu has My account, a View as group with the three sheets (the session's own marked), and Sign out", async () => {
    api();
    render(<App />);
    fireEvent.click(await screen.findByLabelText("Account menu for Asha Raman"));
    expect(await screen.findByText("View as (preview only)", { selector: ".micro" })).toBeTruthy();
    const items = screen.getAllByRole("menuitem");
    expect(items.map((m) => m.textContent)).toEqual(["My account", "Factory admin", "Approver", "Read-only viewer", "Sign out"]);
    expect(items[1]?.getAttribute("aria-current")).toBe("true");
    // a preview of a lower sheet only removes rights: the heading follows it, and the admin entry brings the own sheet back
    fireEvent.click(items[2] as HTMLElement);
    expect(await screen.findByText("Viewing as Approver")).toBeTruthy();
    fireEvent.click(await screen.findByLabelText("Account menu for Asha Raman"));
    expect(screen.getByText(/viewing as Approver/, { selector: ".micro" })).toBeTruthy();
    const items2 = screen.getAllByRole("menuitem");
    fireEvent.click(items2[0] as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe("#account"));
  });

  it("choosing a project in the switcher keeps the person on the sheet and only changes the scope", async () => {
    api();
    window.location.hash = "#/home";
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Switch project/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Payments Platform/ }));
    expect(await screen.findByText("Project: Payments Platform")).toBeTruthy();
    expect(window.location.hash).toBe("#/home");
  });

  it("the palette lists work orders of every project and names the Project group 'Project line'", async () => {
    mockApi({
      "/api/v1/me": () => ({ body: meBody() }),
      "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }),
      "/api/v1/projects/risk/work-orders": () => ({ body: [{ id: "WO-2414", title: "Unsubscribe link in digest emails", state: "running", project: "risk" }] }),
      "/api/v1/projects/payments/work-orders": () => ({ body: [] }),
    });
    render(<App />);
    await nav();
    act(() => { fireEvent.keyDown(document, { key: "k", ctrlKey: true }); });
    const input = await screen.findByPlaceholderText("Jump to a screen, work order, agent, repo or action…");
    fireEvent.change(input, { target: { value: "sub" } });
    await waitFor(() => expect(document.querySelector("#palette-list .pal-label")?.textContent).toBe("WO-2414 · Unsubscribe link in digest emails"));
    fireEvent.change(input, { target: { value: "floor" } });
    await waitFor(() => expect(document.querySelector("#palette-list .pal-hint")?.textContent).toBe("Go to · Project line"));
    // nothing is pinned to the top unless the person pins it
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(document.querySelector("#palette-list .pal-label")?.textContent).toBe("Home"));
  });

  it("the Sheet not found page carries drawing GNT-GEN-00 and lights no nav item", async () => {
    api();
    window.location.hash = "#/nonexistent";
    render(<App />);
    await screen.findByText("Sheet not found");
    expect(screen.getByTitle("Drawing number").textContent).toBe("GNT-GEN-00");
    expect(document.querySelector("#side [aria-current=page]")).toBeNull();
  });

  it("the brand line shows the plant, or READ-ONLY SHEET for a session that can change nothing", async () => {
    mockApi({ "/api/v1/me": () => ({ body: { ...meBody(), org: { id: "acme", name: "Acme Payments", plant: "Plant 1 · Bengaluru", tz: "IST" } } }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [] } }) });
    render(<App />);
    const brand = (await nav()).getByText("Gantry").closest("a") as HTMLElement;
    expect(brand.textContent).toContain("PLANT 1 · BENGALURU");
  });

  it("choosing a project on a factory page scopes it: the project button, the eyebrow and the Inbox pill follow", async () => {
    api({ approvals: [{ wo: "WO-1", gate: "G3", title: "A", project: "payments" }, { wo: "WO-2", gate: "G3", title: "B", project: "risk" }], conversations: [] });
    window.location.hash = "#/home";
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /All projects/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Payments Platform/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Project Payments Platform/ })).toBeTruthy());
    expect(window.location.hash).toBe("#/home");
    expect(document.querySelector(".eyebrow")?.textContent).toContain("PAY");
    expect((await nav()).getByText("Inbox").closest("a")?.querySelector(".cnt")?.textContent).toBe("1");
  });

  it("View as Read-only viewer previews the read-only sheet: brand line and no write rights", async () => {
    api();
    render(<App />);
    fireEvent.click(await screen.findByLabelText("Account menu for Asha Raman"));
    fireEvent.click((await screen.findAllByRole("menuitem")).find((m) => m.textContent === "Read-only viewer") as HTMLElement);
    expect(await screen.findByText("READ-ONLY SHEET")).toBeTruthy();
  });

  it("the Emergency stop entry is plain, like the prototype's", async () => {
    api();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Line control/ }));
    expect((await screen.findByRole("menuitem", { name: /Emergency stop/ })).className).not.toMatch(/danger/);
  });
});
