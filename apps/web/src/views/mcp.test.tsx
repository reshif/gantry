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
/** The deep links the screen keeps for what the prototype does not draw (scope and access, usage log). */
const goto = (q: string) => { window.history.replaceState(null, "", `/?${q}`); window.dispatchEvent(new Event("gantry:urlstate")); };
const openScope = (id: string) => goto(`view=scope&server=${id}`);
const openDocs = async () => { await byId("mcp-open-mcp-docs-1a2b"); openScope("mcp-docs-1a2b"); await waitFor(() => { if (!document.querySelector(".dlg")) throw new Error("no dialog"); }); };
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

  it("lists the registry as cards (auth, tools and write tools, tool tags, agents, Manage tools) with a banner for a changed definition", async () => {
    setup();
    mount();
    const row = await byId("mcp-row-mcp-docs-1a2b");
    expect(row.textContent).toContain("Docs wiki");
    expect(row.textContent).toContain("https://mcp.example.net/mcp");
    expect(row.textContent).toContain("3 tools, 1 write");
    expect(row.textContent).toContain("Agents: Build agent");
    expect(row.textContent).toContain("update_page");
    expect(within(row).getByText("internal")).toBeTruthy();
    expect(within(row).getByText("Manage tools")).toBeTruthy();
    const banner = await byId("mcp-changed-mcp-chg-0001");
    expect(banner.textContent).toContain("changed a tool definition. It stays paused until re-approved.");
    expect(within(banner).getByText("Review change")).toBeTruthy();
    expect(document.getElementById("mcp-add")!.textContent).toBe("Register server");
    expect(document.getElementById("mcp-stats")).toBeNull();
  });

  it("search narrows the cards, is held in the URL and shows the count; Clear filters resets it", async () => {
    setup();
    mount();
    await byId("mcp-row-mcp-docs-1a2b");
    fireEvent.change(await byId("mcp-q"), { target: { value: "issue" } });
    await waitFor(() => expect(window.location.search).toContain("q=issue"));
    expect(document.getElementById("mcp-row-mcp-docs-1a2b")).toBeNull();
    expect(document.getElementById("mcp-row-mcp-chg-0001")).toBeTruthy();
    expect(document.body.textContent).toContain("1 of 2");
    fireEvent.change(await byId("mcp-q"), { target: { value: "zzz" } });
    fireEvent.click(await byId("mcp-clear"));
    await waitFor(() => expect(document.getElementById("mcp-row-mcp-docs-1a2b")).toBeTruthy());
  });

  it("Scope and access is reached from the Manage tools drawer, and the Usage log by the view switch", async () => {
    setup();
    mount();
    fireEvent.click(await byId("mcp-open-mcp-docs-1a2b"));
    fireEvent.click(await byId("mcp-d-scope"));
    await waitFor(() => { if (!document.querySelector(".dlg")) throw new Error("no dialog"); });
    expect(window.location.search).toContain("view=scope");
    cleanup();
    window.history.replaceState(null, "", "/");
    mount();
    await byId("mcp-registry");
    fireEvent.click(screen.getByLabelText("Usage log"));
    await waitFor(() => expect(window.location.search).toContain("view=usage"));
    expect(document.body.textContent).toContain("Usage log:");
    fireEvent.click(screen.getByLabelText("Registry"));
    await byId("mcp-registry");
  });

  it("the registry shows the sensitivity as a plain lower-case chip, and the drawer has only the prototype's foot (Refresh definitions, Done)", async () => {
    setup();
    mount();
    const row = await byId("mcp-row-mcp-docs-1a2b");
    const chip = within(row).getByText("internal");
    expect(chip.className).toContain("plain");
    fireEvent.click(await byId("mcp-open-mcp-docs-1a2b"));
    await byId("mcp-d-refresh");
    expect(document.getElementById("mcp-d-more")).toBeNull();
    expect(document.getElementById("mcp-d-usage")).toBeNull();
    expect(document.querySelector("details")).toBeNull();
    expect(document.querySelector(".drawer-f")!.textContent).toBe("Refresh definitionsScope and accessDone");
  });

  it("Manage tools opens a drawer: eyebrow MCP SERVER, URL/Auth/Health, a Tools card with switches and Refresh definitions in the foot", async () => {
    setup();
    mount();
    fireEvent.click(await byId("mcp-open-mcp-docs-1a2b"));
    await byId("mcp-d-refresh");
    expect(document.querySelector(".drawer-h")!.textContent!.toUpperCase()).toContain("MCP SERVER");
    const kv = document.querySelector(".drawer-b .kv")!.textContent!;
    expect(kv).toContain("URL");
    expect(kv).toContain("Auth");
    expect(kv).toContain("Health");
    expect(document.querySelector(".drawer-f")!.textContent).toContain("Refresh definitions");
    expect(document.getElementById("mcp-dtool-1")).toBeTruthy();
    expect(window.location.search).not.toContain("open=");
  });

  it("lists the first server's detail in the drawer: transport, revision, masked credential, tools, write-gate on and locked", async () => {
    setup();
    mount();
    await openDocs();
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
    await openDocs();
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
    await openDocs();
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
    await openDocs();
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
    await openDocs();
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
    await byId("mcp-open-mcp-chg-0001");
    openScope("mcp-chg-0001");
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
    await openDocs();
    fireEvent.click(await byId("mcp-recheck"));
    expect(await screen.findByText("Docs wiki answered with 3 tools.")).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith("/discover"))!.headers["if-match"]).toBe("4");
  });

  it("Review change opens the prototype's approval dialog: sub with the server id, evidence, diff, Rule/Eligible/Waiting, a comment, and Cancel, Request changes, Reject, Approve", async () => {
    setup();
    mount();
    fireEvent.click(await byId("mcp-review-mcp-chg-0001"));
    await byId("mcp-approve-go");
    const dlg = document.querySelector(".dlg")!;
    expect(dlg.textContent).toContain("Re-approve changed definitions of Issue tracker");
    expect(dlg.textContent).toContain("MCP server mcp-chg-0001");
    expect(dlg.textContent).toContain("Tool search changed its definition. 1 tool unchanged.");
    expect(dlg.querySelector("pre.diff")!.textContent).toBe("~ search");
    for (const w of ["Rule", "1 approver (0 of 1 so far)", "Eligible", "Waiting", "Comment"]) expect(dlg.textContent).toContain(w);
    expect(Array.from(dlg.querySelectorAll(".dlg-f button, footer button")).map((b) => b.textContent)).toEqual(["Cancel", "Request changes", "Reject", "Approve"]);
  });

  it("a tool switch in the drawer toasts 'Enabled <tool> allowed' or 'Disabled <tool> allowed'", async () => {
    setup({ "PATCH /api/v1/mcp/servers/mcp-docs-1a2b": () => ok({ server: DOCS }) });
    mount();
    fireEvent.click(await byId("mcp-open-mcp-docs-1a2b"));
    fireEvent.click(await byId("mcp-dtool-0"));
    expect(await screen.findByText(/^(Enabled|Disabled) .* allowed$/)).toBeTruthy();
  });

  it("Register has Name, URL and Auth only: no token, no disclosure, no egress hint", async () => {
    setup();
    mount();
    fireEvent.click(await byId("mcp-add"));
    await byId("mcp-add-name");
    expect(document.getElementById("mcp-add-secret")).toBeNull();
    expect(document.querySelector(".dlg details")).toBeNull();
    expect(document.querySelector(".dlg")!.textContent).not.toContain("egress");
  });

  it("Register: validates the name and the https URL inline, then discovers for real and posts the server with an idempotency key", async () => {
    let disc: any = null;
    const calls = setup({
      "POST /api/v1/mcp/discover": (_u, init) => { disc = JSON.parse(String(init!.body)); return ok({ msg: "Found 2 tools.", tools: [{ name: "get_issue", write: false, allowed: true }, { name: "create_issue", write: true, allowed: false }] }); },
      "POST /api/v1/mcp/servers": () => ok({ msg: "Tracker added.", server: { ...DOCS, id: "mcp-tracker-ffff", name: "Tracker" } }),
    });
    mount();
    fireEvent.click(await byId("mcp-add"));
    fireEvent.change(await byId("mcp-add-url"), { target: { value: "http://nope" } });
    fireEvent.click(await byId("mcp-add-go"));
    expect(await screen.findByText("Name must be at least 3 characters.")).toBeTruthy();
    expect(screen.getByText("Use an https:// URL.")).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST" && c.path !== "/api/v1/can")).toHaveLength(0);
    fireEvent.change(await byId("mcp-add-name"), { target: { value: "Tracker" } });
    fireEvent.change(await byId("mcp-add-url"), { target: { value: "https://tracker.example.net/mcp" } });
    fireEvent.click(await byId("mcp-add-go"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/mcp/servers")).toBe(true));
    expect(disc).toMatchObject({ name: "Tracker", url: "https://tracker.example.net/mcp", authMode: "bearer" });
    const add = calls.find((c) => c.method === "POST" && c.path === "/api/v1/mcp/servers")!;
    expect(add.body.tools).toEqual([{ name: "get_issue", write: false, allowed: true }, { name: "create_issue", write: true, allowed: false }]);
    expect(add.headers["idempotency-key"]).toBeTruthy();
    expect(await screen.findByText(/Registered/)).toBeTruthy();
  });

  it("Register: a discovery failure shows the reason and posts nothing", async () => {
    const calls = setup({ "POST /api/v1/mcp/discover": () => ({ status: 502, body: { ok: false, msg: "Could not reach the server: connect ECONNREFUSED" } }) });
    mount();
    fireEvent.click(await byId("mcp-add"));
    fireEvent.change(await byId("mcp-add-name"), { target: { value: "Tracker" } });
    fireEvent.change(await byId("mcp-add-url"), { target: { value: "https://tracker.example.net/mcp" } });
    fireEvent.click(await byId("mcp-add-go"));
    expect(await screen.findByText(/ECONNREFUSED/)).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/v1/mcp/servers" && c.method === "POST")).toBe(false);
  });

  it("Remove: names the agents and projects that lose it, then DELETEs with the version", async () => {
    const calls = setup({ "DELETE /api/v1/mcp/servers/mcp-docs-1a2b": () => ok({ msg: "Docs wiki removed." }) });
    mount();
    await openDocs();
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
    await byId("mcp-open-mcp-docs-1a2b");
    goto("view=usage");
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
