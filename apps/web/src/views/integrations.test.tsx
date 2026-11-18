import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import IntegrationsView from "./integrations";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: any; ifMatch?: string }

const person = (id: string, name: string) => ({ id, name, title: "Engineer", email: `${id}@acme.dev`, teams: ["payments"], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "", away: null, version: 2 });
const PEOPLE = [person("p-asha", "Asha Raman")];
const project = (id: string, name: string) => ({ id, name, key: id.toUpperCase(), status: "active", teams: [], owner: "p-asha", template: "t", regulated: false, desc: "", approvers: {}, notifications: [], mcp: [], budget: { monthly: 1000, mtd: 0, alertAt: 0.8 }, created: 0, halted: null, killed: null, overlay: "", version: 1 });
const PAYMENTS = project("payments", "Payments Platform");
const RISK = project("risk", "Risk and Compliance");
const ME = { person: PEOPLE[0], session: { id: "s1", person: "p-asha", method: "sso", device: "Chrome", ip: "10.0.0.5", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: [PAYMENTS, RISK], factory: { killed: null }, config: {} };

const type = (id: string, name: string, category: string, o: object = {}) => ({ id, name, category, icon: "plug", auth: "token", payload: "json", builtIn: true, source: false, destination: true, fields: [], events: [], actions: [], available: true, ...o });
const TYPES = [type("slack", "Slack", "chat"), type("github", "GitHub", "source", { source: true, destination: false }), type("linear", "Linear", "tickets", { available: false, unavailableReason: "Not available in this version." })];
const inst = (id: string, name: string, t: string, o: object = {}) => ({ id, type: t, name, config: {}, secretMask: "••••", status: "healthy", connected: true, projects: "all", lastSync: Date.now() - 60000, createdBy: "p-asha", createdAt: 0, version: 1, ...o });
const INSTS = [inst("int-slack-1", "Slack (production)", "slack"), inst("int-gh-1", "GitHub org", "github", { status: "failing", projects: ["payments"] }), inst("int-slack-2", "Slack (staging)", "slack", { connected: false })];

const BASE: Record<string, Handler> = {
  "GET /api/v1/me": () => ({ body: ME }),
  "GET /api/v1/projects": () => ({ body: [PAYMENTS, RISK] }),
  "GET /api/v1/projects/payments/repos": () => ({ body: [] }),
  "GET /api/v1/projects/risk/repos": () => ({ body: [] }),
  "GET /api/v1/triggers": () => ({ body: [] }),
  "GET /api/v1/deliveries": () => ({ body: [] }),
  "GET /api/v1/integration-types": () => ({ body: TYPES }),
  "GET /api/v1/integrations": () => ({ body: INSTS }),
};

function setup(extra: Record<string, Handler> = {}, denied: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = { ...BASE, ...extra };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body, ifMatch: (init?.headers as Record<string, string> | undefined)?.["If-Match"] });
    if (u.pathname === "/api/v1/can") {
      const checks = (body as { checks: Array<{ action: string }> }).checks;
      return new Response(JSON.stringify({ results: checks.map((c) => (denied.includes(c.action) ? { allowed: false, reason: `No role holds ${c.action}.`, needs: "Needs Factory Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "", needs: "" })) }));
    }
    const h = base[`${method} ${u.pathname}`];
    const r = h ? h(url, init) : { status: 404, body: { ok: false, msg: `no mock ${method} ${u.pathname}` } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
  return calls;
}
const byId = (id: string) => waitFor(() => { const e = document.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; });
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider><IntegrationsView /></OverlayProvider></QueryClientProvider>);
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.path !== "/api/v1/can");
const text = () => document.body.textContent ?? "";
const locked = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true" || (el as HTMLButtonElement).disabled;

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Integrations screen", () => {
  it("lists the connections with their status, scope and the header counts", async () => {
    setup();
    mount();
    const table = await byId("int-table");
    expect(table.textContent).toContain("Slack (production)");
    expect(table.textContent).toContain("GitHub org");
    expect(table.textContent).toContain("failing");
    expect(table.textContent).toContain("disconnected");
    expect(table.textContent).toContain("Payments Platform");
    expect(document.getElementById("int-attn-int-gh-1")).toBeNull(); // no attention banner above the grid
    expect(text()).toContain("Catalogue3types");
    // the prototype's header has no actions: connecting is from the Catalogue tab, building from the Custom builder tab
    expect(document.getElementById("int-add")).toBeNull();
    expect(document.getElementById("int-build")).toBeNull();
    expect(text()).toMatch(/all lines/i);
  });

  it("holds the active tab in the URL and falls back to Connected for an unknown one", async () => {
    setup();
    mount();
    fireEvent.click(await byId("int-tab-catalogue"));
    await waitFor(() => expect(window.location.hash).toContain("?tab=catalogue"));
    fireEvent.click(await byId("int-tab-builder"));
    await waitFor(() => expect(window.location.hash).toContain("?tab=builder"));
    cleanup();
    window.history.replaceState(null, "", "/#/integrations?tab=nonsense");
    mount();
    await byId("int-table");
  });

  it("lists the catalogue as a panel with a Connect button per row, and opens one wide dialog 'Connect <type>'", async () => {
    setup();
    mount();
    fireEvent.click(await byId("int-tab-catalogue"));
    const panel = await byId("int-cat");
    expect(panel.textContent).toContain("Available integrations");
    expect(panel.textContent).toContain("Direction");
    expect(panel.textContent).toContain("Connected");
    expect(document.getElementById("int-cat-add-slack")?.textContent).toBe("Connect");
    fireEvent.click(await byId("int-cat-add-slack"));
    await waitFor(() => expect(document.querySelector("[role=dialog]")?.textContent).toContain("Connect Slack"));
    expect(document.getElementById("int-add-go")?.textContent).toBe("Connect");
  });

  it("titles the disconnect dialog 'Disconnect <name>?' with a danger submit", async () => {
    setup();
    mount();
    fireEvent.click(await byId("int-toggle-int-slack-1"));
    await waitFor(() => expect(document.querySelector("[role=dialog]")?.textContent).toContain("Disconnect Slack (production)?"));
    expect(document.getElementById("int-dis-go")?.textContent).toBe("Disconnect");
  });

  it("shows the catalogue with a type that cannot be connected yet", async () => {
    setup();
    mount();
    fireEvent.click(await byId("int-tab-catalogue"));
    await waitFor(() => expect(text()).toContain("Linear"));
    expect(text()).toContain("Slack");
    expect(text()).toContain("GitHub");
  });

  it("says nothing is connected when there are no connections, and still offers to add one", async () => {
    setup({ "GET /api/v1/integrations": () => ({ body: [] }) });
    mount();
    await waitFor(() => expect(text()).toContain("Nothing connected"));
    expect(text()).toContain("Connect an integration from the Catalogue tab.");
    expect(document.getElementById("int-table")).toBeNull();
  });

  it("shows the failure with a retry, not a blank list, and recovers on retry", async () => {
    let fail = true;
    setup({ "GET /api/v1/integrations": () => (fail ? { status: 500, body: { ok: false, msg: "The integrations store is down." } } : { body: INSTS }) });
    mount();
    const err = await byId("int-error");
    expect(err.textContent).toContain("Couldn't load connected integrations");
    expect(err.textContent).toContain("The integrations store is down.");
    expect(document.getElementById("int-table")).toBeNull();
    fail = false;
    fireEvent.click(await byId("int-error-retry"));
    await byId("int-table");
    expect(document.getElementById("int-error")).toBeNull();
  });

  it("says the catalogue is not visible when the read is refused with 403", async () => {
    setup({ "GET /api/v1/integration-types": () => ({ status: 403, body: { ok: false, msg: "Needs Integrations access." } }) });
    mount();
    fireEvent.click(await byId("int-tab-catalogue"));
    const hidden = await byId("int-cat-hidden");
    expect(hidden.textContent).toContain("Not visible to you");
    expect(hidden.textContent).toContain("Needs Integrations access.");
  });

  it("locks the write controls with the reason when the viewer may not add integrations, and sends nothing", async () => {
    const calls = setup({}, ["integration.add"]);
    mount();
    fireEvent.click(await byId("int-tab-catalogue"));
    const add = await byId("int-cat-add-slack");
    await waitFor(() => expect(locked(add)).toBe(true));
    expect(add.getAttribute("data-reason")).toMatch(/Factory Admin/);
    fireEvent.click(add);
    expect(document.querySelector("[role=dialog]")).toBeNull();
    fireEvent.click(await byId("int-tab-builder"));
    const save = await byId("int-b-save");
    await waitFor(() => expect(locked(save)).toBe(true));
    expect(((await byId("int-b-name")) as HTMLInputElement).disabled).toBe(true);
    expect(writes(calls)).toHaveLength(0);
  });

  it("says the connections are not visible when the list read is refused with 403", async () => {
    setup({ "GET /api/v1/integrations": () => ({ status: 403, body: { ok: false, msg: "Needs Integrations access." } }) });
    mount();
    const hidden = await byId("int-hidden");
    expect(hidden.textContent).toContain("Not visible to you");
    expect(document.getElementById("int-table")).toBeNull();
  });

  it("shows a visible error on the catalogue tab when only the types fail to load", async () => {
    setup({ "GET /api/v1/integration-types": () => ({ status: 500, body: { ok: false, msg: "Types are down." } }) });
    mount();
    await byId("int-table");
    fireEvent.click(await byId("int-tab-catalogue"));
    const err = await byId("int-cat-error");
    expect(err.textContent).toContain("Couldn't load the integration catalogue");
    expect(err.textContent).toContain("Types are down.");
  });

  it("locks Add on a type this version cannot connect, with its reason, and keeps the others open", async () => {
    const calls = setup();
    mount();
    fireEvent.click(await byId("int-tab-catalogue"));
    const linear = await byId("int-cat-add-linear");
    expect(locked(linear)).toBe(true);
    expect(linear.getAttribute("data-reason")).toContain("Not available in this version.");
    expect(locked(await byId("int-cat-add-slack"))).toBe(false);
    fireEvent.click(linear);
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(writes(calls)).toHaveLength(0);
  });

  it("opens the add dialog for someone who may add integrations", async () => {
    setup();
    mount();
    fireEvent.click(await byId("int-tab-catalogue"));
    fireEvent.click(await byId("int-cat-add-slack"));
    await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeTruthy());
  });
});
