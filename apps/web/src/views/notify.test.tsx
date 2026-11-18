import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { updatePrefs } from "../lib/prefs";
import { OverlayProvider } from "../ui/Overlay";
import IntegrationsView from "./integrations";
import NotificationsView from "./notifications";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: unknown; headers: Record<string, string> }

const person = { id: "p-asha", name: "Asha Raman", title: "Head", email: "asha@acme.dev", teams: [], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false };
const ROUTE = { id: "NR-1", event: "gate.waiting", dest: [{ channel: "slack", target: "#pay-gates", integration: "int-slack" }], template: "gate", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: { title: true, repo: true, class: true, priority: true, approvers: true, link: true, actions: true } };
const KILL = { id: "NR-2", event: "kill", dest: [{ channel: "slack", target: "#pay-gates", integration: "int-slack" }], template: "kill", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: ROUTE.fields };
const PROJECTS = [{ id: "payments", key: "PAY", name: "Payments Platform", status: "active", teams: [], halted: null, killed: null, flow: { classes: [{ id: "feature", name: "Feature" }, { id: "bug", name: "Bug" }], stations: [], gates: {}, bays: [] }, notifications: [ROUTE, KILL], version: 3 }];
const ME = { person, session: { id: "s1", person: "p-asha", method: "sso", device: "Chrome", ip: "10.0.0.1", started: Date.now(), lastSeen: Date.now(), revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: PROJECTS, factory: { killed: null }, config: {} };
const f = (key: string, label: string, type: string, required = true, extra: object = {}) => ({ key, label, type, required, ...extra });
const TYPES = [
  { id: "github", name: "GitHub", category: "source", icon: "github", auth: "app", payload: "json", builtIn: true, source: true, destination: false, available: true, fields: [f("org", "Organisation", "text"), f("webhookSecret", "Webhook secret", "secret")], events: [], actions: [] },
  { id: "slack", name: "Slack", category: "chat", icon: "slack", auth: "oauth", payload: "blocks", builtIn: true, destination: true, available: true, targetLabel: "Channel or @person",
    fields: [f("workspace", "Workspace", "text"), f("botToken", "Bot token", "secret"), f("signingSecret", "Signing secret", "secret"), f("approve", "Allow approvals from Slack", "bool", false)], events: [], actions: ["post_card"],
    manifest: { version: "1.0.0", capabilities: ["notify", "interactive"], operations: ["test", "send"], delivery: { idempotencyKey: "event id + destination", retryable: "network errors", permanent: "other 4xx", rateLimit: "backoff" } } },
  { id: "teams", name: "Microsoft Teams", category: "chat", icon: "teams", auth: "oauth", payload: "adaptive", builtIn: true, destination: true, available: false, unavailableReason: "Microsoft Teams is listed but not yet available: Gantry cannot send to Teams in this version.", fields: [f("tenant", "Tenant", "text")], events: [], actions: [] },
  { id: "webhook", name: "Signed webhook", category: "webhook", icon: "webhook", auth: "hmac", payload: "json", builtIn: true, destination: true, available: true, targetLabel: "Endpoint", fields: [f("url", "Endpoint URL", "url"), f("secret", "Signing secret", "secret")], events: [], actions: ["post_json"] },
];
const INST = { id: "int-slack", type: "slack", name: "Acme Slack", config: { workspace: "acme", approve: false }, secretMask: "xoxb-••••••••aaaa", status: "healthy", connected: true, projects: "all", lastSync: Date.now() - 60000, createdBy: "p-asha", createdAt: Date.now() - 86400000, version: 4 };
const OFF = { ...INST, id: "int-off", name: "Staging Slack", connected: false, status: "offline", secretMask: "xoxb-••••••••bbbb", version: 2 };
const DELIVERIES = [
  { id: "DLV-9", at: Date.now() - 1000, project: "payments", event: "gate.waiting", channel: "slack", target: "#pay-gates", integration: "int-slack", status: "failed", state: "dead", attempts: 8, error: "Slack chat.postMessage failed: channel_not_found" },
  { id: "DLV-8", at: Date.now() - 5000, project: "payments", event: "submitted", channel: "slack", target: "#pay-intake", integration: "int-slack", status: "delivered", state: "sent", attempts: 1, error: "" },
];
const PREVIEW = {
  ok: true, event: "gate.waiting", template: "gate", actions: ["approve", "reject", "open"], rows: [["Work order", "WO-1042 · Add idempotency keys"], ["Repo", "payments-api"], ["Approvers", "Release Manager · 1 needed"]],
  sample: { event: "gate.waiting", template: "gate", tone: "gate", head: "G2 Spec approved is waiting on WO-1042", body: "This gate needs a person.", woId: "WO-1042", title: "Add idempotency keys", repo: "payments-api", cls: "feature", clsName: "Feature", prio: "P2", approvers: "Release Manager · 1 needed", gate: { id: "G2", label: "G2", name: "Spec approved" }, instance: "WO-1042:G2:1", link: "https://gantry.test/#record/WO-1042", project: { id: "payments", key: "PAY", name: "Payments Platform" }, at: Date.now() },
  email: { subject: "[PAY] G2 Spec approved is waiting on WO-1042", text: "", html: "" }, webhook: { workOrder: { id: "WO-1042" } },
};

function setup(extra: Record<string, Handler> = {}, denied: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: ME }),
    "GET /api/v1/people": () => ({ body: [person] }),
    "GET /api/v1/agents": () => ({ body: [] }),
    "GET /api/v1/projects": () => ({ body: PROJECTS }),
    "GET /api/v1/projects/payments/repos": () => ({ body: [{ id: "payments-api", name: "acme/payments-api", project: "payments", team: "t", notifyOverrides: [{ id: "RO-1", event: "gate.waiting", dest: [{ channel: "slack", target: "#api", integration: "int-slack" }], template: "gate", mode: "also" }], version: 5 }] }),
    "GET /api/v1/projects/payments/routes": () => ({ body: [{ ...ROUTE, version: 2 }, { ...KILL, version: 1 }] }),
    "GET /api/v1/integration-types": () => ({ body: TYPES }),
    "GET /api/v1/integrations": () => ({ body: [INST, OFF] }),
    "GET /api/v1/triggers": () => ({ body: [] }),
    "GET /api/v1/deliveries": (url) => ({ body: { items: /status=failed/.test(url) ? DELIVERIES.filter((d) => d.status === "failed") : DELIVERIES, next: null } }),
    "GET /api/v1/card-templates": () => ({ body: [{ id: "CT-1", name: "Tight gate card", kind: "gate", fields: ["title"], actions: ["open"], version: 1 }] }),
    "POST /api/v1/card-templates/preview": () => ({ body: PREVIEW }),
    "GET /api/v1/chat-links": () => ({ body: [] }),
    "GET /api/v1/catalog": () => ({ body: { classes: [{ id: "feature", name: "Feature" }, { id: "bug", name: "Bug" }], stations: [], gates: [], bays: [], roles: [], actions: [] } }),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    const method = init?.method ?? "GET";
    const hdr: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (hdr[k] = v));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, headers: hdr });
    if (path === "/api/v1/can") {
      const checks = (body as { checks: Array<{ action: string }> }).checks;
      return new Response(JSON.stringify({ results: checks.map((c) => (denied.includes(c.action) ? { allowed: false, reason: `No role holds ${c.action}.`, needs: "Needs Factory Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "ok", rule: { id: "MATRIX" } })) }), { status: 200 });
    }
    const h = base[`${method} ${path}`];
    const r = h ? h(url, init) : { status: 404, body: { ok: false, msg: `no mock ${method} ${path}` } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
  return calls;
}

const byId = (id: string) => waitFor(() => { const e = document.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; });
function mount(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider>{node}</OverlayProvider></QueryClientProvider>);
}
beforeEach(() => { setCsrfToken("c"); canBatcher.clear(); window.location.hash = ""; updatePrefs({ scopeAll: false }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Integrations", () => {
  it("says Not visible to you when the connections read is refused, and the header count is not a 0", async () => {
    setup({ "GET /api/v1/integrations": () => ({ status: 403, body: { ok: false, msg: "Needs Factory Admin to see integrations." } }) });
    mount(<IntegrationsView />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
    expect(screen.getByText("Needs Factory Admin to see integrations.")).toBeTruthy();
    expect(document.getElementById("int-table")).toBeNull();
  });

  it("lists connections with their health, scope and masked secret, and counts what needs attention", async () => {
    setup();
    mount(<IntegrationsView />);
    expect(await screen.findByRole("heading", { name: "Integrations" })).toBeTruthy();
    const table = await byId("int-table");
    expect(within(table).getByText("Acme Slack")).toBeTruthy();
    expect(within(table).getByText("Staging Slack")).toBeTruthy();
    expect(within(table).getAllByText("all").length).toBe(2);
    expect(within(table).getByText("Disabled")).toBeTruthy();
    expect(document.getElementById("int-attn")).toBeNull(); // no attention disclosure under the table (prototype)
    expect(document.body.textContent).not.toMatch(/simulated/i);
    fireEvent.click(await byId("int-open-int-slack"));
    expect(await screen.findByText("xoxb-••••••••aaaa")).toBeTruthy(); // a masked secret, never the value
    expect(screen.getByText("Test connection")).toBeTruthy();
  });

  it("sortable headers carry the prototype's sort arrow, and the connection drawer has only Test connection and Disconnect in the foot, and is not in the URL", async () => {
    setup();
    mount(<IntegrationsView />);
    const table = await byId("int-table");
    expect(table.querySelectorAll("thead .th-arrow").length).toBe(5);
    expect(Array.from(table.querySelectorAll("thead .th-arrow")).filter((a) => a.textContent === "↕").length).toBe(4);
    fireEvent.click(await byId("int-open-int-slack"));
    await byId("int-d-test");
    expect(document.getElementById("int-d-more")).toBeNull();
    expect(document.querySelector("details")).toBeNull();
    const foot = document.querySelector(".drawer-f")!.textContent!;
    expect(foot).toBe("Test connectionDisconnect…");
    expect(document.getElementById("int-d-usage")).toBeNull();
    expect(document.getElementById("int-d-edit")).toBeNull();
    expect(window.location.search).not.toContain("open=");
  });

  it("lists types the version cannot connect as not yet available, with the reason, and locks Add for people without the right", async () => {
    setup({}, ["integration.add"]);
    mount(<IntegrationsView />);
    await byId("int-table");
    window.history.replaceState(null, "", "?view=catalogue");
    window.dispatchEvent(new Event("gantry:urlstate"));
    const add = await byId("int-cat-add-teams");
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(add.getAttribute("data-reason")).toMatch(/not yet available/i);
    const slack = await byId("int-cat-add-slack");
    await waitFor(() => expect(slack.getAttribute("data-reason")).toMatch(/No role holds integration.add/));
  });

  it("adds a connection in the prototype form (Type, Name, token), names every invalid field inline, and connects it switched on", async () => {
    const calls = setup({
      "POST /api/v1/integrations": () => ({ body: { ok: true, msg: "Pay Slack added.", integration: { ...INST, id: "int-new", name: "Pay Slack", connected: true, version: 1 } } }),
    });
    mount(<IntegrationsView />);
    fireEvent.click(await screen.findByText("Add integration"));
    const typeSel = (await byId("int-add-type")) as HTMLSelectElement;
    expect(Array.from(typeSel.options).map((o) => o.value)).toEqual(["github", "gitlab", "slack", "teams", "jira", "linear", "paging", "email", "webhook", "statuspage"]);
    expect(document.getElementById("int-add-browse")).toBeNull();
    expect(screen.getByText("Token or webhook secret")).toBeTruthy();
    fireEvent.click(await byId("int-add-go"));
    expect(await screen.findByText("Name is required.")).toBeTruthy();
    expect(screen.getByText("Token or webhook secret is required.")).toBeTruthy();
    fireEvent.change(await byId("int-add-name"), { target: { value: "ab" } });
    fireEvent.change(await byId("int-add-secret"), { target: { value: "short" } });
    fireEvent.click(await byId("int-add-go"));
    expect(await screen.findByText("Name needs at least 3 characters.")).toBeTruthy();
    expect(screen.getByText("Token or webhook secret needs at least 8 characters.")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/integrations")).toBe(false);
    fireEvent.change(await byId("int-add-type"), { target: { value: "slack" } });
    fireEvent.change(await byId("int-add-name"), { target: { value: "Pay Slack" } });
    fireEvent.change(await byId("int-add-secret"), { target: { value: "xoxb-12345678" } });
    fireEvent.click(await byId("int-add-go"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/integrations")).toBe(true));
    const create = calls.find((c) => c.method === "POST" && c.path === "/api/v1/integrations")!;
    expect(create.body).toMatchObject({ type: "slack", name: "Pay Slack", projects: "all", enable: true });
    expect(await screen.findByText("Connected Pay Slack")).toBeTruthy();
  });

  it("Test connection in the drawer foot posts the real test and says the result", async () => {
    const calls = setup({ "POST /api/v1/integrations/int-slack/test": () => ({ body: { ok: true, msg: "Slack answered in 41 ms.", test: { ok: true, ms: 41, lines: [] } } }) });
    mount(<IntegrationsView />);
    fireEvent.click(await byId("int-open-int-slack"));
    fireEvent.click(await byId("int-d-test"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/integrations/int-slack/test")).toBe(true));
    expect(await screen.findByText(/Acme Slack is reachable \(41 ms\)\./)).toBeTruthy();
  });

  it("a failing connection's drawer says why from its deliveries, a degraded one says slow, and Test connection reports the failure", async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ id: `DLV-f${i}`, at: Date.now() - (i + 1) * 1000, project: "payments", event: "gate.waiting", channel: "slack", target: "#pay-gates", integration: "int-slack", status: "failed", state: "dead", attempts: 3, error: "HTTP 503 from the target" }));
    const calls = setup({
      "GET /api/v1/integrations": () => ({ body: [{ ...INST, status: "failing" }, { ...OFF, id: "int-slow", name: "Slow Slack", connected: true, status: "degraded" }] }),
      "GET /api/v1/deliveries": () => ({ body: five }),
      "POST /api/v1/integrations/int-slack/test": () => ({ body: { ok: false, msg: "HTTP 503", test: { ok: false, ms: 0, error: "HTTP 503" } } }),
    });
    mount(<IntegrationsView />);
    fireEvent.click(await byId("int-open-int-slack"));
    expect((await byId("int-d-why")).textContent).toBe("Last 5 deliveries failed: HTTP 503 from the target.");
    fireEvent.click(await byId("int-d-test"));
    expect(await screen.findByText("Acme Slack: HTTP 503. Still failing.")).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/v1/integrations/int-slack/test")).toBe(true);
    fireEvent.click(document.querySelector<HTMLElement>(".drawer-h [aria-label=Close]")!);
    await waitFor(() => expect(document.getElementById("int-d-why")).toBeNull());
    fireEvent.click(await byId("int-open-int-slow"));
    expect((await byId("int-d-why")).textContent).toMatch(/^Slow responses/);
  });

  it("Disconnect asks the prototype's question with its sub line and nothing else", async () => {
    setup({ "GET /api/v1/integrations": () => ({ body: [{ ...OFF, id: "int-x", name: "Spare Hook", type: "webhook" }] }) });
    mount(<IntegrationsView />);
    fireEvent.click(await byId("int-open-int-x"));
    fireEvent.click(await byId("int-d-remove"));
    await byId("int-rm-go");
    const dlg = document.querySelector(".dlg")!;
    expect(dlg.textContent).toContain("Disconnect Spare Hook?");
    expect(dlg.textContent).toContain("Projects using it stop receiving events. Secrets are deleted.");
    expect(dlg.textContent).not.toContain("cannot be undone");
    expect(dlg.textContent).not.toContain("Depends on it");
  });

  it("removing is blocked while a route sends to the connection, and says so", async () => {
    setup();
    mount(<IntegrationsView />);
    fireEvent.click(await byId("int-open-int-slack"));
    fireEvent.click(await byId("int-d-remove"));
    const blocked = await byId("int-rm-blocked");
    expect(blocked.textContent).toMatch(/2 routes send to it/);
    expect((await byId("int-rm-go")).getAttribute("aria-disabled")).toBe("true");
  });

  it("the custom builder offers no source-control category and explains what is missing", async () => {
    setup({ "POST /api/v1/integration-types": () => ({ body: { ok: true, msg: "Audit lake added to the catalogue.", type: { id: "audit-lake", name: "Audit lake" } } }) });
    mount(<IntegrationsView />);
    await byId("int-table");
    window.history.replaceState(null, "", "?view=custom");
    window.dispatchEvent(new Event("gantry:urlstate"));
    const cat = (await byId("int-b-cat")) as HTMLSelectElement;
    expect(Array.from(cat.options).map((o) => o.value)).not.toContain("source");
    expect((await byId("int-b-err")).textContent).toMatch(/name the integration/i);
    fireEvent.change(await byId("int-b-name"), { target: { value: "Audit lake" } });
    await waitFor(() => expect(document.getElementById("int-b-err")!.textContent).toBe("Ready to add."));
    fireEvent.click(await byId("int-b-save"));
    expect(await screen.findByText("Audit lake added to the catalogue.")).toBeTruthy();
  });
});

/** Deep links the screen keeps for what the prototype does not draw: the route editor, card templates and repo overrides. */
const goto = (q: string) => { window.history.replaceState(null, "", `/?${q}`); window.dispatchEvent(new Event("gantry:urlstate")); };
const openRoutes = async () => { await byId("nt-tab-channels"); goto("tab=routes"); await byId("nt-table"); };

describe("Notifications", () => {
  it("offers only delivered, failed and retrying in the status filter, as the prototype does", async () => {
    setup();
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-tab-deliveries"));
    const sel = (await byId("nt-dl-status")) as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["all", "delivered", "failed", "retrying"]);
  });

  it("says Not visible to you when the delivery log is refused, instead of no deliveries", async () => {
    setup({ "GET /api/v1/deliveries": () => ({ status: 403, body: { ok: false, msg: "Needs notify.view on this project." } }) });
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-tab-deliveries"));
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
    expect(screen.queryByText("No deliveries match these filters.")).toBeNull();
  });

  it("lists the project's routes with their destinations and locks the kill route's switch with the reason", async () => {
    setup();
    mount(<NotificationsView />);
    await openRoutes();
    expect(await screen.findByRole("heading", { name: "Notifications" })).toBeTruthy();
    const row = await byId("nt-row-NR-1");
    expect(within(row).getByText("#pay-gates")).toBeTruthy();
    expect(within(row).getByText("Gate request")).toBeTruthy();
    const kill = (await byId("nt-en-NR-2")) as HTMLInputElement;
    expect(kill.getAttribute("aria-disabled")).toBe("true");
    expect(kill.getAttribute("data-reason")).toMatch(/cannot be switched off/i);
    expect(document.body.textContent).not.toMatch(/simulated/i);
  });

  it("switches a route off with its own version as If-Match, and edits and deletes with the version too", async () => {
    const calls = setup({
      "PATCH /api/v1/projects/payments/routes/NR-1": () => ({ body: { ok: true, msg: "Route NR-1 saved.", id: "NR-1", version: 3 } }),
      "DELETE /api/v1/projects/payments/routes/NR-1": () => ({ body: { ok: true, msg: "Route removed." } }),
    });
    mount(<NotificationsView />);
    await openRoutes();
    fireEvent.click(await byId("nt-en-NR-1"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    let c = calls.find((x) => x.method === "PATCH")!;
    expect(c.body).toEqual({ enabled: false });
    expect(c.headers["if-match"]).toBe("2");
    // Edit the target in the editor, save.
    fireEvent.change(await byId("nt-dest-t-0"), { target: { value: "#pay-approvals" } });
    fireEvent.click(await byId("nt-save"));
    await waitFor(() => expect(calls.filter((x) => x.method === "PATCH").length).toBe(2));
    c = calls.filter((x) => x.method === "PATCH")[1]!;
    expect(c.body).toMatchObject({ event: "gate.waiting", dest: [{ channel: "slack", target: "#pay-approvals", integration: "int-slack" }], template: "gate" });
    expect(c.headers["if-match"]).toBe("2");
    fireEvent.click(await byId("nt-del"));
    fireEvent.click(await byId("nt-del-go"));
    await waitFor(() => expect(calls.some((x) => x.method === "DELETE")).toBe(true));
    expect(calls.find((x) => x.method === "DELETE")!.headers["if-match"]).toBe("2");
  });

  it("a stale version is refused by the server and shown, not swallowed", async () => {
    setup({ "PATCH /api/v1/projects/payments/routes/NR-1": () => ({ status: 409, body: { ok: false, msg: "This changed since you loaded it. Reload and try again." } }) });
    mount(<NotificationsView />);
    await openRoutes();
    fireEvent.change(await byId("nt-dest-t-0"), { target: { value: "#other" } });
    fireEvent.click(await byId("nt-save"));
    expect((await screen.findAllByText(/changed since you loaded it/i)).length).toBeGreaterThan(0);
  });

  it("is read-only without the right: switches and buttons are disabled with the reason", async () => {
    setup({}, ["notify.edit"]);
    mount(<NotificationsView />);
    await openRoutes();
    const en = await byId("nt-en-NR-1");
    await waitFor(() => expect(en.getAttribute("data-reason")).toMatch(/No role holds notify.edit/));
    expect((await byId("nt-add")).getAttribute("aria-disabled")).toBe("true");
    expect((await byId("nt-save")).getAttribute("aria-disabled")).toBe("true");
  });

  it("draws the preview from the server's rendering and shows the approve note when the connection does not allow chat approval", async () => {
    setup();
    mount(<NotificationsView />);
    await openRoutes();
    expect(await screen.findByText("G2 Spec approved is waiting on WO-1042")).toBeTruthy();
    expect(screen.getByText("Release Manager · 1 needed")).toBeTruthy();
    expect(await screen.findByText(/Approve from card is off for Acme Slack/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/delivery is simulated/i);
  });

  it("queues a test send to one destination and says where to see the outcome", async () => {
    const calls = setup({ "POST /api/v1/projects/payments/routes/test": () => ({ body: { ok: true, msg: "Test to #pay-gates queued on Acme Slack. The delivery log shows the outcome.", delivery: { id: "DLV-10" } } }) });
    mount(<NotificationsView />);
    await openRoutes();
    fireEvent.click(await byId("nt-test-0"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/projects/payments/routes/test")).toBe(true));
    expect(calls.find((c) => c.path === "/api/v1/projects/payments/routes/test")!.body).toEqual({ dest: { channel: "slack", target: "#pay-gates", integration: "int-slack" }, event: "gate.waiting" });
    expect(await screen.findByText(/delivery log shows the outcome/)).toBeTruthy();
  });

  it("the delivery log shows failures with their reason and retries one", async () => {
    const calls = setup({ "POST /api/v1/deliveries/DLV-9/retry": () => ({ body: { ok: true, msg: "Queued again. The delivery log shows the outcome." } }) });
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-tab-deliveries"));
    const row = await byId("nt-dl-DLV-9");
    expect(within(row).getByText("Failed")).toBeTruthy();
    expect(document.getElementById("nt-retry-DLV-8")).toBeNull(); // a delivered one is not retried
    fireEvent.click(await byId("nt-retry-DLV-9"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/deliveries/DLV-9/retry" && c.method === "POST")).toBe(true));
  });

  it("routes, card templates and repo overrides are tabs reached by clicking", async () => {
    setup();
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-tab-routes"));
    await byId("nt-table");
    fireEvent.click(await byId("nt-tab-templates"));
    await byId("nt-ct-open-gate");
    fireEvent.click(await byId("nt-tab-overrides"));
    expect((await screen.findAllByText("acme/payments-api")).length).toBeGreaterThan(0);
    expect(window.location.search).toContain("tab=overrides");
  });

  it("repo overrides list what the repo adds and remove one with the repo's version", async () => {
    const calls = setup({ "PATCH /api/v1/repos/payments-api/config": () => ({ body: { ok: true, msg: "Saved." } }) });
    mount(<NotificationsView />);
    await byId("nt-tab-channels"); goto("tab=overrides");
    expect((await screen.findAllByText("acme/payments-api")).length).toBeGreaterThan(0);
    fireEvent.click(await byId("nt-ov-rm-payments-api-0"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/repos/payments-api/config")).toBe(true));
    const c = calls.find((x) => x.path === "/api/v1/repos/payments-api/config")!;
    expect(c.body).toEqual({ notifyOverrides: [] });
    expect(c.headers["if-match"]).toBe("5");
  });

  it("card templates: save a custom card, and deleting one that a route uses is refused with the reason", async () => {
    const calls = setup({ "POST /api/v1/card-templates": () => ({ body: { ok: true, msg: "Tight gate card saved.", template: { id: "CT-1" } } }) });
    mount(<NotificationsView />);
    await byId("nt-tab-channels"); goto("tab=templates");
    expect(await screen.findByText("Tight gate card")).toBeTruthy();
    fireEvent.click(await byId("nt-ct-f-repo"));
    fireEvent.click(await byId("nt-ct-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/card-templates")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/v1/card-templates")!.body).toMatchObject({ id: "CT-1", name: "Tight gate card", kind: "gate", project: "payments", actions: ["open"], fields: ["title", "repo"] });
  });

  it("duplicating a built-in card keeps its kind and buttons, and the copy is what the editor shows next", async () => {
    const calls = setup({ "POST /api/v1/card-templates": () => ({ body: { ok: true, msg: "Saved.", template: { id: "CT-2", name: "Gate request (copy)", kind: "gate", fields: ["title", "repo", "class", "priority", "approvers", "link", "actions"], actions: ["approve", "reject", "open"] } } }) });
    mount(<NotificationsView />);
    await byId("nt-tab-channels"); goto("tab=templates");
    fireEvent.click(await byId("nt-ct-dup-gate"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/card-templates")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/v1/card-templates")!.body).toMatchObject({ name: "Gate request (copy)", kind: "gate", actions: ["approve", "reject", "open"] });
    await waitFor(() => expect((document.getElementById("nt-ct-kind") as HTMLSelectElement).value).toBe("gate"));
    expect((document.getElementById("nt-ct-name") as HTMLInputElement).value).toBe("Gate request (copy)");
  });
});

describe("Notifications: the Control Room tabs", () => {
  it("opens on the Matrix tab ('Who hears about what', event by channel switches) and has Deliveries and Channels tabs", async () => {
    setup();
    mount(<NotificationsView />);
    expect(await byId("nt-tab-matrix")).toBeTruthy();
    expect(document.getElementById("nt-tab-deliveries")).toBeTruthy();
    expect(document.getElementById("nt-tab-channels")).toBeTruthy();
    expect((await screen.findAllByText("Who hears about what")).length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain("Applies to Payments Platform");
    // gate.waiting has an enabled Slack route in the fixture, so its Slack switch is on
    const sw = (await byId("nt-mx-gate.waiting-slack")) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    const inapp = (await byId("nt-mx-gate.waiting-inapp")) as HTMLInputElement;
    expect(inapp.getAttribute("aria-disabled")).toBeNull();
    expect(inapp.checked).toBe(true);
    expect(document.querySelector(".swipe")!.textContent).toBe("Swipe sideways for more →");
    expect(document.getElementById("nt-more")).toBeNull();
  });

  it("the matrix lists the prototype's nine events with In-app, Slack, Email and Pager, and MCP definition changed is locked (no backend event)", async () => {
    setup();
    mount(<NotificationsView />);
    await byId("nt-matrix");
    const rows = document.querySelectorAll("#nt-matrix tbody tr");
    expect(Array.from(rows).map((r) => r.querySelector("td")!.textContent)).toEqual(["Work order submitted", "Question for a person", "Gate waiting", "Gate decided", "Work order stuck", "Work order released", "Emergency stop", "Trust proposal", "MCP definition changed"]);
    expect(Array.from(document.querySelectorAll("#nt-matrix thead th")).map((t) => t.textContent)).toEqual(["Event", "In-app", "Slack", "Email", "Pager"]);
    expect((await byId("nt-mx-mcp-slack")).getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById("nt-more-routes")).toBeNull(); // the route editor is not under the matrix
  });

  it("a matrix switch saves the route through the API with its version and toasts what changed", async () => {
    const calls = setup({ "PATCH /api/v1/projects/payments/routes/NR-1": () => ({ body: { ok: true, msg: "Route NR-1 saved.", id: "NR-1", version: 3 } }) });
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-mx-gate.waiting-slack"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const c = calls.find((x) => x.method === "PATCH")!;
    expect(c.body).toEqual({ enabled: false });
    expect(c.headers["if-match"]).toBe("2");
    expect(await screen.findByText(/Disabled .* via Slack/)).toBeTruthy();
  });

  it("the Matrix tab is in the URL, and the Channels tab lists open connections with Send test", async () => {
    const calls = setup({ "POST /api/v1/projects/payments/routes/test": () => ({ body: { ok: true, msg: "queued", delivery: { id: "DLV-10" } } }) });
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-tab-channels"));
    await waitFor(() => expect(window.location.search).toContain("tab=channels"));
    fireEvent.click(await byId("nt-ch-test-int-slack"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/projects/payments/routes/test")).toBe(true));
    expect(await screen.findByText(/Sent a test message to/)).toBeTruthy();
  });
});
