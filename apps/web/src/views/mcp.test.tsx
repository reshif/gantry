import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import McpView from "./mcp";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: any; headers: Record<string, string>; query: URLSearchParams }

const NOW = Date.now();
const person = (id: string, name: string, roles: Array<{ role: string; scope: string }>) => ({ id, name, title: "Engineer", email: `${id}@acme.dev`, teams: ["payments"], roles, status: "active", oncall: false, github: "", away: null, version: 2 });
const PEOPLE = [person("p-asha", "Asha Raman", [{ role: "factory_admin", scope: "factory" }])];
const project = (id: string, name: string, key: string, mcp: string[] = []) => ({ id, name, key, status: "active", teams: ["payments"], owner: "p-asha", template: "t", regulated: false, desc: "", approvers: {}, notifications: [], mcp, budget: { monthly: 0, mtd: 0, alertAt: 0.8 }, created: 0, halted: null, killed: null, overlay: "", version: 1 });
const PAYMENTS = project("payments", "Payments Platform", "PAY", ["mcp-docs-1a2b"]);
const RISK = project("risk", "Risk and Compliance", "RSK");
const AGENTS = [
  { id: "ag-build", name: "Build agent", initials: "BA", mcp: ["mcp-docs-1a2b"], station: "build" },
  { id: "ag-review", name: "Review agent", initials: "RA", mcp: [], station: "review" },
];
const REPOS = [{ id: "payments-api", name: "payments-api", project: "payments" }];
const tool = (name: string, o: object = {}) => ({ name, write: false, allowed: true, hint: "read", description: `${name} tool`, hash: "h".repeat(64), ...o });
const DOCS = {
  id: "mcp-docs-1a2b", name: "Docs wiki", transport: "http", url: "https://mcp.example.net/mcp", auth: "Bearer token", authMode: "bearer", authHeader: null, authMask: "mcp-upstream-••••••••6789", health: "healthy", sensitivity: "internal", writeGate: true,
  tools: [tool("search"), tool("update_page", { write: true, allowed: false, hint: "write" }), tool("list_pages", { hint: "write" })],
  projects: ["payments"], repos: "all", agents: ["ag-build"], stations: ["build"], classes: "all", protocolRevision: "2025-06-18", enabled: true, disabledReason: null, healthDetail: null, discoveredAt: NOW - 3_600_000, version: 4,
};
const CHANGED = { ...DOCS, id: "mcp-chg-0001", name: "Issue tracker", health: "healthy", enabled: false, disabledReason: "Definition of search changed", tools: [tool("search", { changed: true }), tool("create_issue", { write: true })], version: 9 };
const CALLS = [
  { id: 3, at: NOW - 60_000, server: "mcp-docs-1a2b", tool: "search", agent: "ag-build", project: "payments", outcome: "ok", ms: 31, wo: "WO-1", station: "build", argsHash: "a".repeat(64), reason: null },
  { id: 2, at: NOW - 120_000, server: "mcp-docs-1a2b", tool: "update_page", agent: "ag-build", project: "payments", outcome: "denied", ms: 0, wo: "WO-1", station: "build", argsHash: null, reason: "no pre-authorisation" },
  { id: 1, at: NOW - 3 * 86_400_000, server: "mcp-gone", tool: "x", agent: "ag-review", project: "risk", outcome: "error", ms: 9, wo: null, station: null, argsHash: null, reason: "boom" },
];
const ME = { person: PEOPLE[0], session: { id: "s1", person: "p-asha", method: "sso", device: "Chrome", ip: "1", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: [PAYMENTS, RISK], factory: { killed: null }, config: {} };

function setup(extra: Record<string, Handler> = {}, denied: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: ME }),
    "GET /api/v1/people": () => ({ body: PEOPLE }),
    "GET /api/v1/projects": () => ({ body: [PAYMENTS, RISK] }),
    "GET /api/v1/agents": () => ({ body: AGENTS }),
    "GET /api/v1/catalog": () => ({ body: DEFAULT_CATALOG }),
    "GET /api/v1/projects/payments/repos": () => ({ body: REPOS }),
    "GET /api/v1/projects/risk/repos": () => ({ body: [] }),
    "GET /api/v1/mcp/servers": () => ({ body: [DOCS, CHANGED] }),
    "GET /api/v1/mcp/calls": () => ({ body: CALLS }),
    "GET /api/v1/mcp/access-check": () => ({ body: { allowed: true, reason: "Allowed by project, repo, agent, station, work class and tool scope.", rule: "scope" } }),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x");
    const method = init?.method ?? "GET";
    const hdr: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (hdr[k] = v));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body, headers: hdr, query: u.searchParams });
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
  return render(<QueryClientProvider client={qc}><OverlayProvider><McpView /></OverlayProvider></QueryClientProvider>);
}
const ok = (extra: object = {}) => ({ body: { ok: true, msg: "Done.", ...extra } });
const patches = (calls: Call[]) => calls.filter((c) => c.method === "PATCH");
/** A server's own page is a route (#mcp/<id>) with its tab in ?tab=. */
const openSrv = (id: string, tab = "overview") => { window.location.hash = `#mcp/${id}`; window.history.replaceState(null, "", `/?tab=${tab}${window.location.hash}`); };

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

describe("MCP servers screen", () => {
  it("says Not visible to you when the registry read is refused, instead of No MCP servers yet", async () => {
    setup({ "GET /api/v1/mcp/servers": () => ({ status: 403, body: { ok: false, msg: "Needs Factory Admin to see MCP servers." } }) });
    mount();
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
    expect(screen.getByText("Needs Factory Admin to see MCP servers.")).toBeTruthy();
    expect(screen.queryByText("No MCP servers yet")).toBeNull();
  });

  it("maps a 'down' health to the failing tone", async () => {
    const { Health } = await import("./mcp/kit");
    const { container } = render(<Health st="down" />);
    expect(container.querySelector(".tone-block")).toBeTruthy();
  });

  it("keeps Disabled out of the Healthy filter and counts a disabled server as not healthy", async () => {
    setup();
    mount();
    await byId("mcp-row-mcp-chg-0001");
    expect(document.getElementById("mcp-stats")!.textContent).toMatch(/Healthy1/);
    fireEvent.change(document.getElementById("mcp-f-health")!, { target: { value: "healthy" } });
    expect(document.getElementById("mcp-row-mcp-chg-0001")).toBeNull();
    expect(document.getElementById("mcp-row-mcp-docs-1a2b")).toBeTruthy();
    fireEvent.change(document.getElementById("mcp-f-health")!, { target: { value: "disabled" } });
    expect(document.getElementById("mcp-row-mcp-chg-0001")).toBeTruthy();
    expect(document.getElementById("mcp-row-mcp-docs-1a2b")).toBeNull();
  });

  it("lists the registry with health, tool counts, sensitivity and the writes chip, linking each server to its own page", async () => {
    setup();
    mount();
    const row = await byId("mcp-row-mcp-docs-1a2b");
    expect(row.textContent).toContain("https://mcp.example.net/mcp");
    expect(row.textContent).toContain("2/3");
    expect(Array.from(row.querySelectorAll(".chip.ok")).map((c) => c.textContent)).toContain("gated"); // the Writes column is gated or open, from the server's write gate
    expect(row.textContent).toContain("internal");
    expect((await byId("mcp-row-mcp-chg-0001")).textContent).toContain("disabled");
    expect((await byId("mcp-open-mcp-docs-1a2b")).getAttribute("href")).toBe("#mcp/mcp-docs-1a2b");
    const head = document.getElementById("mcp-stats")!.textContent!;
    expect(head).toContain("Servers2");
    expect(head).toContain("gated"); // the prototype's sub: how many calls waited at a gate
    expect(head).toContain("Calls logged");
    expect(document.getElementById("mcp-add")!.textContent).toBe("Register server");
    expect(document.getElementById("mcp-tab-registry")).toBeTruthy();
    expect(document.getElementById("mcp-tab-usage")).toBeTruthy();
  });

  it("a server's page has a breadcrumb, the URL, five tabs, and a kv list with the write gate on and locked", async () => {
    setup();
    openSrv("mcp-docs-1a2b");
    mount();
    expect((await screen.findAllByText("Docs wiki")).length).toBeGreaterThan(0);
    for (const t of ["overview", "tools", "scope", "check", "calls"]) expect(document.getElementById(`mcp-dtab-${t}`), t).toBeTruthy();
    expect(document.querySelector("nav.kicker")!.textContent).toContain("MCP servers");
    expect(document.body.textContent).toContain("https://mcp.example.net/mcp");
    const kv = (await byId("mcp-server")).textContent!;
    expect(kv).not.toContain("2025-06-18"); // protocol revision and last discovery are not on the overview
    expect(kv).toContain("mcp-upstream-••••••••6789");
    const wg = document.getElementById("mcp-writegate") as HTMLInputElement;
    expect(wg.checked).toBe(true);
    expect(wg.getAttribute("aria-disabled")).toBeNull(); // it toggles as in the prototype; the rail stays on and the toast says why
    fireEvent.click(wg);
    expect(await screen.findByText(/always need a station pre-authorisation/)).toBeTruthy();
    expect((document.getElementById("mcp-writegate") as HTMLInputElement).checked).toBe(true);
    for (const id of ["mcp-enabled", "mcp-remove", "mcp-recheck", "mcp-sens"]) expect(document.getElementById(id), id).toBeNull();
    expect(document.body.textContent).toContain("Writes need approval");
  });

  it("an unknown server id says it does not exist", async () => {
    setup();
    openSrv("mcp-nope");
    mount();
    expect(await screen.findByText("That server does not exist.")).toBeTruthy();
  });

  it("shows the admin-set class next to the server's hint, and sets a tool's class and allow rule through PATCH with the version", async () => {
    const calls = setup({ "PATCH /api/v1/mcp/servers/mcp-docs-1a2b": () => ok({ server: DOCS }) });
    openSrv("mcp-docs-1a2b", "tools");
    mount();
    await byId("mcp-tool-0");
    expect(document.querySelector("#mcp-tools select")).toBeNull(); // the Tools tab is switches and Read only / Writes data
    fireEvent.click(await byId("mcp-dtab-scope"));
    fireEvent.click(await byId("mcp-sc-edit"));
    const sel = (await byId("mcp-tool-class-2")) as HTMLSelectElement;
    expect(sel.value).toBe("read");
    expect(sel.closest(".switch-row")!.textContent).toContain("server suggests write");
    fireEvent.change(sel, { target: { value: "write" } });
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]).toMatchObject({ path: "/api/v1/mcp/servers/mcp-docs-1a2b", body: { tools: [{ name: "list_pages", write: true }] }, headers: { "if-match": "4" } });
    fireEvent.click(await byId("mcp-dtab-tools"));
    fireEvent.click(await byId("mcp-tool-1"));
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]!.body).toEqual({ tools: [{ name: "update_page", allowed: true }] });
    expect(await screen.findByText("update_page allowed")).toBeTruthy();
  });

  it("saves the scope as one PATCH, keeps Save disabled with a reason until something changes, and Revert restores the draft", async () => {
    const calls = setup({ "PATCH /api/v1/mcp/servers/mcp-docs-1a2b": () => ok({ server: DOCS }) });
    openSrv("mcp-docs-1a2b", "scope");
    mount();
    fireEvent.click(await byId("mcp-sc-edit"));
    const save = await byId("mcp-sc-save");
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.getAttribute("data-reason")).toBe("No changes to save.");
    expect((await byId("mcp-sc-projects-payments") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(await byId("mcp-sc-projects-risk"));
    fireEvent.click(await byId("mcp-sc-agents-ag-review"));
    expect(save.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(await byId("mcp-sc-revert"));
    expect((document.getElementById("mcp-sc-projects-risk") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(await byId("mcp-sc-projects-risk"));
    fireEvent.click(await byId("mcp-sc-agents-ag-review"));
    fireEvent.click(await byId("mcp-sc-classes-all"), {});
    fireEvent.click(await byId("mcp-sc-save"));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.body).toEqual({ projects: ["payments", "risk"], repos: "all", agents: ["ag-build", "ag-review"], stations: ["build"], classes: [] });
    expect(patches(calls)[0]!.headers["if-match"]).toBe("4");
    expect(await screen.findByText("Scope saved for Docs wiki.")).toBeTruthy();
  });

  it("access check: only the form until Check access is pressed, then asks the API with the chosen agent and tool and shows the decision", async () => {
    let q: URLSearchParams | null = null;
    const calls = setup({ "GET /api/v1/mcp/access-check": (url) => { q = new URL(url, "http://x").searchParams; return { body: { allowed: false, reason: "Not available at 06 Verify.", rule: "station scope" } }; } });
    openSrv("mcp-docs-1a2b", "check");
    mount();
    const res = await byId("mcp-chk-result");
    expect(res.textContent).toBe("");
    expect(document.getElementById("mcp-chk-more")).toBeNull();
    expect(calls.filter((c) => c.path === "/api/v1/mcp/access-check")).toHaveLength(0);
    fireEvent.click(await byId("mcp-chk-run"));
    await waitFor(() => expect(res.textContent).toContain("Denied"));
    expect(res.textContent).toContain("Not available at 06 Verify.");
    expect(res.querySelector(".callout.bad")).toBeTruthy();
    expect(Object.fromEntries(q!.entries())).toMatchObject({ server: "mcp-docs-1a2b", tool: "search", agent: "ag-build", project: "payments" });
  });

  it("a locked caller sees every control disabled with the reason, and nothing is sent", async () => {
    const calls = setup({}, ["mcp.edit"]);
    openSrv("mcp-docs-1a2b");
    mount();
    expect(await screen.findByText(/Read-only for you: mcp server settings/i)).toBeTruthy();
    expect(document.getElementById("mcp-remove")).toBeNull();
    fireEvent.click(await byId("mcp-dtab-tools"));
    expect((await byId("mcp-tool-0")).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(await byId("mcp-dtab-scope"));
    expect((await byId("mcp-sc-edit")).getAttribute("aria-disabled")).toBe("true");
    expect(calls.filter((c) => c.method !== "GET" && c.path !== "/api/v1/can")).toHaveLength(0);
  });

  it("Register server is locked with the reason for a caller without mcp.edit", async () => {
    setup({}, ["mcp.edit"]);
    mount();
    const b = await byId("mcp-add");
    await waitFor(() => expect(b.getAttribute("aria-disabled")).toBe("true"));
    expect(b.getAttribute("data-reason")).toMatch(/Needs Factory Admin/);
  });

  it("a server disabled by a changed definition says so, marks the tool, cannot just be switched on, and re-approval posts /approve with the version", async () => {
    const calls = setup({ "POST /api/v1/mcp/servers/mcp-chg-0001/approve": () => ok({ server: { ...CHANGED, enabled: true } }) });
    openSrv("mcp-chg-0001", "overview");
    mount();
    const note = await byId("mcp-disabled-note");
    expect(note.textContent).toContain("Definition of search changed");
    fireEvent.click(await byId("mcp-dtab-tools"));
    expect((await byId("mcp-tools")).textContent).toContain("changed");
    fireEvent.click(await byId("mcp-dtab-scope"));
    fireEvent.click(await byId("mcp-sc-edit"));
    const en = (await byId("mcp-enabled")) as HTMLInputElement;
    expect(en.checked).toBe(false);
    expect(en.getAttribute("data-reason")).toMatch(/Re-approve/);
    fireEvent.click(await byId("mcp-dtab-overview"));
    fireEvent.click(await byId("mcp-approve"));
    fireEvent.click(await byId("mcp-approve-go"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/approve"))).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/approve"))!.headers["if-match"]).toBe("9");
  });

  it("Check again rediscovers through the edge and reports what it found", async () => {
    const calls = setup({ "POST /api/v1/mcp/servers/mcp-docs-1a2b/discover": () => ok({ msg: "Docs wiki answered with 3 tools.", server: DOCS }) });
    openSrv("mcp-docs-1a2b", "scope");
    mount();
    fireEvent.click(await byId("mcp-sc-edit"));
    fireEvent.click(await byId("mcp-recheck"));
    expect(await screen.findByText("Docs wiki answered with 3 tools.")).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith("/discover"))!.headers["if-match"]).toBe("4");
  });

  it("Add is the prototype's Name, URL, Transport form (plus sensitivity); Register discovers the tools, asks for auth only when discovery fails, and posts the discovered tools", async () => {
    let disc: any = null;
    let n = 0;
    const calls = setup({
      "POST /api/v1/mcp/discover": (_u, init) => { disc = JSON.parse(String(init!.body)); n += 1; return n === 1 ? ok({ msg: "Could not list tools: the server answered 401.", tools: [] }) : ok({ msg: "Found 2 tools. Write tools start denied.", tools: [{ name: "get_issue", write: false, allowed: true, hint: "read" }, { name: "create_issue", write: true, allowed: false, hint: "write" }], protocolRevision: "2025-06-18" }); },
      "POST /api/v1/mcp/servers": () => ok({ msg: "Tracker added. Scope it to projects, repos and agents before use.", server: { ...DOCS, id: "mcp-tracker-ffff", name: "Tracker" } }),
    });
    mount();
    fireEvent.click(await byId("mcp-add"));
    expect(document.getElementById("mcp-add-auth")).toBeNull();
    expect(document.getElementById("mcp-add-discover")).toBeNull();
    fireEvent.click(await byId("mcp-add-go"));
    expect(await screen.findByText("Name is required.")).toBeTruthy();
    expect(screen.getByText("URL is required.")).toBeTruthy(); // both at once
    fireEvent.change(await byId("mcp-add-name"), { target: { value: "Tracker" } });
    fireEvent.change(await byId("mcp-add-url"), { target: { value: "https://tracker.example.net/mcp" } });
    fireEvent.click(await byId("mcp-add-go"));
    await waitFor(() => expect(document.getElementById("mcp-add-err")!.textContent).toMatch(/401/));
    fireEvent.change(await byId("mcp-add-secret"), { target: { value: "tok" } });
    fireEvent.change(await byId("mcp-add-auth"), { target: { value: "bearer" } });
    fireEvent.change(await byId("mcp-add-secret"), { target: { value: "tok-123456" } });
    fireEvent.click(await byId("mcp-add-go"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/mcp/servers")).toBe(true));
    expect(disc).toEqual({ name: "Tracker", transport: "http", url: "https://tracker.example.net/mcp", authMode: "bearer", secret: "tok-123456" });
    const add = calls.find((c) => c.method === "POST" && c.path === "/api/v1/mcp/servers")!;
    expect(add.body).toMatchObject({ name: "Tracker", transport: "http", url: "https://tracker.example.net/mcp", authMode: "bearer", secret: "tok-123456", sensitivity: "internal", tools: [{ name: "get_issue", write: false, allowed: true }, { name: "create_issue", write: true, allowed: false }] });
    expect(add.headers["idempotency-key"]).toBeTruthy();
    expect(await screen.findByText("Server registered")).toBeTruthy();
  });

  it("Remove: names the agents and projects that lose it, then DELETEs with the version", async () => {
    const calls = setup({ "DELETE /api/v1/mcp/servers/mcp-docs-1a2b": () => ok({ msg: "Docs wiki removed." }) });
    openSrv("mcp-docs-1a2b", "scope");
    mount();
    fireEvent.click(await byId("mcp-sc-edit"));
    fireEvent.click(await byId("mcp-remove"));
    const go = await byId("mcp-remove-go");
    const dlg = go.closest("[role=dialog], .dialog, .dlg")!;
    expect(dlg.textContent).toContain("1 agent list it: Build agent.");
    expect(dlg.textContent).toContain("Enabled in Payments Platform.");
    fireEvent.click(go);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")!.headers["if-match"]).toBe("4");
  });

  it("Usage log: Recent tool calls panel with Outcome and Server filters, relative times, raw server ids, latency, sortable", async () => {
    setup();
    mount();
    fireEvent.click(await byId("mcp-tab-usage"));
    const panel = await byId("mcp-usage-panel");
    expect(panel.textContent).toContain("Recent tool calls");
    const rows = () => document.querySelectorAll("#mcpu tbody tr");
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(panel.textContent).toContain("mcp-gone");
    // outcome tones follow the prototype: ok green, gated amber, anything else red
    const chip = (w: string) => Array.from(panel.querySelectorAll(".chip")).find((c) => c.textContent === w)!;
    expect(chip("ok").className).toContain("ok");
    expect(chip("denied").className).toContain("bad");
    expect(panel.textContent).toContain("ago");
    expect(panel.textContent).toContain("Latency");
    expect(document.getElementById("mcpu-table-sort-at") ?? panel.querySelector("th button")).toBeTruthy();
    fireEvent.change(await byId("mcpu-f-outcome"), { target: { value: "denied" } });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("update_page");
    expect(rows()[0]!.textContent).toContain("Build agent");
    expect(rows()[0]!.textContent).toContain("Payments Platform");
    fireEvent.change(await byId("mcpu-f-outcome"), { target: { value: "" } });
    fireEvent.change(await byId("mcpu-f-server"), { target: { value: "mcp-docs-1a2b" } });
    expect(rows()).toHaveLength(2);
  });

  it("with no servers it says so and offers Add", async () => {
    setup({ "GET /api/v1/mcp/servers": () => ({ body: [] }) });
    mount();
    expect(await screen.findByText("No MCP servers yet")).toBeTruthy();
    expect(await byId("mcp-add")).toBeTruthy();
  });

  it("a server whose address changed shows Needs re-approval in the list and on its page, with the way forward, and cannot be switched on", async () => {
    const NEEDS = { ...DOCS, id: "mcp-new-0002", name: "Wiki two", enabled: false, disabledReason: null, needsReapproval: true, version: 5 };
    const calls = setup({
      "GET /api/v1/mcp/servers": () => ({ body: [DOCS, NEEDS] }),
      "POST /api/v1/mcp/servers/mcp-new-0002/discover": () => ok({ msg: "Wiki two answered with 3 tools.", server: NEEDS }),
    });
    mount();
    const row = await byId("mcp-row-mcp-new-0002");
    expect(row.textContent).toContain("needs re-approval");
    expect(document.getElementById("mcp-row-mcp-docs-1a2b")!.textContent).not.toContain("needs re-approval");
    cleanup();
    openSrv("mcp-new-0002", "overview");
    mount();
    const note = await byId("mcp-reapproval-note");
    expect(note.textContent).toContain("Needs re-approval");
    expect(note.textContent).toContain("Discover its tools and approve them before switching it on");
    expect(document.getElementById("mcp-disabled-note")).toBeNull();
    // The note wraps (F-11): the text takes its own row and the buttons sit in a wrapping row, so nothing runs past the panel at 320 px.
    expect(note.querySelector(".mcp-reapproval-why")).toBeTruthy();
    expect(note.querySelector(".mcp-reapproval-actions #mcp-reapproval-approve")).toBeTruthy();
    expect(readFileSync(resolve(__dirname, "../styles/views/mcp.css"), "utf8")).toMatch(/#mcp-reapproval-note\s*\{\s*flex-wrap:\s*wrap/);
    fireEvent.click(await byId("mcp-reapproval-discover"));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/mcp-new-0002/discover"))).toBe(true));
    fireEvent.click(await byId("mcp-dtab-scope"));
    fireEvent.click(await byId("mcp-sc-edit"));
    const en = (await byId("mcp-enabled")) as HTMLInputElement;
    expect(en.checked).toBe(false);
    expect(en.getAttribute("data-reason")).toMatch(/Needs re-approval.*Discover its tools/);
    fireEvent.click(en);
    expect(patches(calls)).toHaveLength(0);
  });

  it("a failed repo read says so with Try again, instead of an empty repo list", async () => {
    let fail = true;
    setup({ "GET /api/v1/projects/payments/repos": () => (fail ? { status: 500, body: { ok: false, msg: "Repo store is down." } } : { body: REPOS }) });
    openSrv("mcp-docs-1a2b", "overview");
    mount();
    const note = await byId("repos-read");
    expect(note.textContent).toContain("Couldn't load every repo");
    expect(note.textContent).toContain("Repo store is down.");
    fail = false;
    fireEvent.click(await byId("repos-read-retry"));
    await waitFor(() => expect(document.getElementById("repos-read")).toBeNull());
  });
});
