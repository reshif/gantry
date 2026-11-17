import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
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
    expect(document.getElementById("mcp-stats")!.textContent).toMatch(/Healthy11 not healthy/);
    fireEvent.change(document.getElementById("mcp-f-health")!, { target: { value: "healthy" } });
    expect(document.getElementById("mcp-row-mcp-chg-0001")).toBeNull();
    expect(document.getElementById("mcp-row-mcp-docs-1a2b")).toBeTruthy();
    fireEvent.change(document.getElementById("mcp-f-health")!, { target: { value: "disabled" } });
    expect(document.getElementById("mcp-row-mcp-chg-0001")).toBeTruthy();
    expect(document.getElementById("mcp-row-mcp-docs-1a2b")).toBeNull();
  });

  it("lists the registry with health, tool counts, sensitivity and the scope line, and shows the first server's detail", async () => {
    setup();
    mount();
    expect((await screen.findAllByText("Docs wiki")).length).toBeGreaterThan(0);
    const row = await byId("mcp-row-mcp-docs-1a2b");
    expect(row.textContent).toContain("https://mcp.example.net/mcp");
    expect(row.textContent).toContain("2/3");
    expect(row.textContent).toContain("gated");
    expect(row.textContent).toContain("internal");
    expect((await byId("mcp-row-mcp-chg-0001")).textContent).toContain("Disabled");
    // header meta
    const head = document.getElementById("mcp-stats")!.textContent!;
    expect(head).toContain("Servers2");
    expect(head).toContain("2 write tools");
    expect(head).toContain("Calls logged");
    fireEvent.click(await byId("mcp-open-mcp-docs-1a2b"));
    // detail: transport, protocol revision, masked credential, tools, write-gate shown on and locked
    expect(document.querySelector(".mcp-tb")!.textContent).toContain("2025-06-18");
    expect(document.querySelector(".mcp-tb")!.textContent).toContain("mcp-upstream-••••••••6789");
    expect(document.querySelectorAll(".mcp-tools tbody tr")).toHaveLength(3);
    const wg = document.getElementById("mcp-writegate") as HTMLInputElement;
    expect(wg.checked).toBe(true);
    expect(wg.getAttribute("aria-disabled")).toBe("true");
    expect(wg.getAttribute("data-reason")).toMatch(/always need a station pre-authorisation/);
  });

  it("shows the admin-set class next to the server's hint, and sets a tool's class and allow rule through PATCH with the version", async () => {
    const calls = setup({ "PATCH /api/v1/mcp/servers/mcp-docs-1a2b": () => ok({ server: DOCS }) });
    mount();
    fireEvent.click(await byId("mcp-open-mcp-docs-1a2b"));
    const sel = (await byId("mcp-tool-class-2")) as HTMLSelectElement;
    expect(sel.value).toBe("read");
    expect(sel.closest("td")!.textContent).toContain("server suggests write");
    fireEvent.change(sel, { target: { value: "write" } });
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]).toMatchObject({ path: "/api/v1/mcp/servers/mcp-docs-1a2b", body: { tools: [{ name: "list_pages", write: true }] }, headers: { "if-match": "4" } });
    fireEvent.click(await byId("mcp-tool-1"));
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]!.body).toEqual({ tools: [{ name: "update_page", allowed: true }] });
    expect(await screen.findByText("update_page allowed.")).toBeTruthy();
  });

  it("saves the scope as one PATCH, keeps Save disabled with a reason until something changes, and Revert restores the draft", async () => {
    const calls = setup({ "PATCH /api/v1/mcp/servers/mcp-docs-1a2b": () => ok({ server: DOCS }) });
    mount();
    fireEvent.click(await byId("mcp-open-mcp-docs-1a2b"));
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

  it("access check: asks the API with the chosen agent, project, repo, station, class and tool and shows its decision and rule", async () => {
    let q: URLSearchParams | null = null;
    const calls = setup({ "GET /api/v1/mcp/access-check": (url) => { q = new URL(url, "http://x").searchParams; return { body: { allowed: false, reason: "Not available at 06 Verify.", rule: "station scope" } }; } });
    mount();
    fireEvent.click(await byId("mcp-open-mcp-docs-1a2b"));
    const res = await byId("mcp-chk-result");
    await waitFor(() => expect(res.textContent).toContain("Denied"));
    expect(res.textContent).toContain("Not available at 06 Verify.");
    expect(res.textContent).toContain("station scope");
    expect(res.className).toContain("is-denied");
    expect(Object.fromEntries(q!.entries())).toMatchObject({ server: "mcp-docs-1a2b", tool: "search", agent: "ag-build", project: "payments" });
    fireEvent.change(await byId("mcp-chk-agent"), { target: { value: "ag-review" } });
    fireEvent.change(await byId("mcp-chk-repo"), { target: { value: "payments-api" } });
    await waitFor(() => expect(Object.fromEntries(q!.entries())).toMatchObject({ agent: "ag-review", repo: "payments-api" }));
    expect(calls.filter((c) => c.path === "/api/v1/mcp/access-check").length).toBeGreaterThan(1);
  });

  it("a locked caller sees every control disabled with the reason, and nothing is sent", async () => {
    const calls = setup({}, ["mcp.edit"]);
    mount();
    fireEvent.click(await byId("mcp-open-mcp-docs-1a2b"));
    expect(await screen.findByText(/Read-only for you: mcp server settings/i)).toBeTruthy();
    for (const id of ["mcp-add", "mcp-sc-save", "mcp-remove", "mcp-recheck"]) {
      const b = await byId(id);
      expect(b.getAttribute("aria-disabled"), id).toBe("true");
      expect(b.getAttribute("data-reason"), id).toMatch(/Needs Factory Admin/);
    }
    expect((await byId("mcp-tool-0")).getAttribute("aria-disabled")).toBe("true");
    expect((document.getElementById("mcp-sens") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(await byId("mcp-remove"));
    expect(document.getElementById("mcp-remove-go")).toBeNull();
    expect(calls.filter((c) => c.method !== "GET" && c.path !== "/api/v1/can")).toHaveLength(0);
  });

  it("a server disabled by a changed definition says so, marks the tool, cannot just be switched on, and re-approval posts /approve with the version", async () => {
    const calls = setup({ "POST /api/v1/mcp/servers/mcp-chg-0001/approve": () => ok({ server: { ...CHANGED, enabled: true } }) });
    mount();
    fireEvent.click(await byId("mcp-open-mcp-chg-0001"));
    const note = await byId("mcp-disabled-note");
    expect(note.textContent).toContain("Definition of search changed");
    expect(document.querySelector(".mcp-tools tbody")!.textContent).toContain("changed");
    const en = document.getElementById("mcp-enabled") as HTMLInputElement;
    expect(en.checked).toBe(false);
    expect(en.getAttribute("data-reason")).toMatch(/Re-approve/);
    fireEvent.click(await byId("mcp-approve"));
    fireEvent.click(await byId("mcp-approve-go"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/approve"))).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/approve"))!.headers["if-match"]).toBe("9");
  });

  it("Check again rediscovers through the edge and reports what it found", async () => {
    const calls = setup({ "POST /api/v1/mcp/servers/mcp-docs-1a2b/discover": () => ok({ msg: "Docs wiki answered with 3 tools.", server: DOCS }) });
    mount();
    fireEvent.click(await byId("mcp-open-mcp-docs-1a2b"));
    fireEvent.click(await byId("mcp-recheck"));
    expect(await screen.findByText("Docs wiki answered with 3 tools.")).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith("/discover"))!.headers["if-match"]).toBe("4");
  });

  it("Add: discovery lists the server's real tools (write ones start denied, class is the admin's to set), and Add posts the choices with an idempotency key", async () => {
    let disc: any = null;
    const calls = setup({
      "POST /api/v1/mcp/discover": (_u, init) => { disc = JSON.parse(String(init!.body)); return ok({ msg: "Found 2 tools. Write tools start denied.", tools: [{ name: "get_issue", write: false, allowed: true, hint: "read" }, { name: "create_issue", write: true, allowed: false, hint: "write" }], protocolRevision: "2025-06-18" }); },
      "POST /api/v1/mcp/servers": () => ok({ msg: "Tracker added. Scope it to projects, repos and agents before use.", server: { ...DOCS, id: "mcp-tracker-ffff", name: "Tracker" } }),
    });
    mount();
    fireEvent.click(await byId("mcp-add"));
    fireEvent.change(await byId("mcp-add-name"), { target: { value: "Tracker" } });
    fireEvent.change(await byId("mcp-add-url"), { target: { value: "https://tracker.example.net/mcp" } });
    // add before discovery
    fireEvent.click(await byId("mcp-add-go"));
    expect((await byId("mcp-add-err")).textContent).toMatch(/enter the secret/i);
    fireEvent.change(await byId("mcp-add-secret"), { target: { value: "tok-123456" } });
    fireEvent.click(await byId("mcp-add-go"));
    await waitFor(() => expect(document.getElementById("mcp-add-err")!.textContent).toBe("Discover tools before adding the server."));
    fireEvent.click(await byId("mcp-add-discover"));
    await byId("mcp-add-tool-1");
    expect(disc).toEqual({ name: "Tracker", transport: "http", url: "https://tracker.example.net/mcp", authMode: "bearer", secret: "tok-123456" });
    expect((document.getElementById("mcp-add-tool-0") as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById("mcp-add-tool-1") as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById("mcp-add-class-1") as HTMLSelectElement).value).toBe("write");
    // the admin sets create_issue to read despite the server's hint, and allows it
    fireEvent.change(document.getElementById("mcp-add-class-1")!, { target: { value: "read" } });
    expect(document.getElementById("mcp-add-class-1")!.closest("li")!.textContent).toContain("server suggests write");
    fireEvent.click(document.getElementById("mcp-add-tool-1")!);
    fireEvent.click(await byId("mcp-add-go"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/mcp/servers")).toBe(true));
    const add = calls.find((c) => c.method === "POST" && c.path === "/api/v1/mcp/servers")!;
    expect(add.body).toMatchObject({ name: "Tracker", transport: "http", url: "https://tracker.example.net/mcp", authMode: "bearer", secret: "tok-123456", sensitivity: "internal", tools: [{ name: "get_issue", write: false, allowed: true }, { name: "create_issue", write: false, allowed: true }] });
    expect(add.headers["idempotency-key"]).toBeTruthy();
    expect(await screen.findByText(/Tracker added/)).toBeTruthy();
  });

  it("Add: a discovery failure shows the reason, and changing the address drops the discovered list", async () => {
    setup({ "POST /api/v1/mcp/discover": () => ok({ msg: "Could not list tools: Could not reach the server: connect ECONNREFUSED", tools: [] }) });
    mount();
    fireEvent.click(await byId("mcp-add"));
    fireEvent.change(await byId("mcp-add-name"), { target: { value: "Tracker" } });
    fireEvent.change(await byId("mcp-add-url"), { target: { value: "https://tracker.example.net/mcp" } });
    fireEvent.click(await byId("mcp-add-discover"));
    expect(await screen.findByText(/ECONNREFUSED/)).toBeTruthy();
    expect(document.getElementById("mcp-add-tool-0")).toBeNull();
  });

  it("Remove: names the agents and projects that lose it, then DELETEs with the version", async () => {
    const calls = setup({ "DELETE /api/v1/mcp/servers/mcp-docs-1a2b": () => ok({ msg: "Docs wiki removed." }) });
    mount();
    fireEvent.click(await byId("mcp-open-mcp-docs-1a2b"));
    fireEvent.click(await byId("mcp-remove"));
    const go = await byId("mcp-remove-go");
    const dlg = go.closest("[role=dialog], .dialog, .dlg")!;
    expect(dlg.textContent).toContain("1 agent list it: Build agent.");
    expect(dlg.textContent).toContain("Enabled in Payments Platform.");
    fireEvent.click(go);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")!.headers["if-match"]).toBe("4");
  });

  it("Usage log: filters by server, agent, project and outcome, charts calls per server, labels removed servers and real outcomes", async () => {
    setup();
    mount();
    fireEvent.click(await byId("mcp-tab-usage"));
    const rows = () => document.querySelectorAll(".mcp-usage tbody tr");
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(document.querySelector(".mcp-usage")!.textContent).toContain("mcp-gone (removed)");
    expect(document.querySelector(".mcp-usage")!.textContent).toContain("✓ ok");
    expect(document.querySelector(".mcp-usage")!.textContent).toContain("⊘ denied");
    expect(document.querySelector(".mcp-usage")!.textContent).toContain("✕ error");
    expect(document.querySelectorAll(".mcp-bar")).toHaveLength(2);
    fireEvent.change(await byId("mcp-f-outcome"), { target: { value: "denied" } });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("update_page");
    expect(rows()[0]!.textContent).toContain("Build agent");
    expect(rows()[0]!.textContent).toContain("PAY");
    fireEvent.change(await byId("mcp-f-outcome"), { target: { value: "all" } });
    fireEvent.change(await byId("mcp-f-project"), { target: { value: "risk" } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(await byId("mcp-f-project"), { target: { value: "all" } });
    fireEvent.change(await byId("mcp-f-server"), { target: { value: "mcp-docs-1a2b" } });
    expect(rows()).toHaveLength(2);
  });

  it("with no servers it says so and offers Add", async () => {
    setup({ "GET /api/v1/mcp/servers": () => ({ body: [] }) });
    mount();
    expect(await screen.findByText("No MCP servers yet")).toBeTruthy();
    expect(await byId("mcp-add")).toBeTruthy();
  });
});
