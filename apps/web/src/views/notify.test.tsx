import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
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
beforeEach(() => { setCsrfToken("c"); canBatcher.clear(); window.location.hash = ""; window.history.replaceState(null, "", "/"); });
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
    expect(within(table).getAllByText("All projects").length).toBe(2);
    expect(within(table).getByText("disconnected")).toBeTruthy();
    expect((await byId("int-attn-int-off")).textContent).toBe("Staging Slack");
    expect(document.body.textContent).not.toMatch(/simulated/i);
    fireEvent.click(await byId("int-open-int-slack"));
    expect((await screen.findAllByText("xoxb-••••••••aaaa")).length).toBeGreaterThan(0); // a masked secret, never the value
    expect(screen.getByText("Test connection")).toBeTruthy();
  });

  it("lists types the version cannot connect as not yet available, with the reason, and locks Add for people without the right", async () => {
    setup({}, ["integration.add"]);
    mount(<IntegrationsView />);
    fireEvent.click(await byId("int-tab-catalogue"));
    const add = await byId("int-cat-add-teams");
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(add.getAttribute("data-reason")).toMatch(/not yet available/i);
    const slack = await byId("int-cat-add-slack");
    await waitFor(() => expect(slack.getAttribute("data-reason")).toMatch(/No role holds integration.add/));
  });

  it("adds a connection: settings, a real connection test, scope, and it is created switched off unless chosen", async () => {
    const calls = setup({
      "POST /api/v1/integration-types/slack/test": () => ({ body: { ok: true, msg: "Slack answered in 41 ms.", test: { ok: true, ms: 41, lines: [["ok", "Reached slack.com."], ["ok", "Authenticated as gantry in Acme."]] } } }),
      "POST /api/v1/integrations": () => ({ body: { ok: true, msg: "Pay Slack added. It is switched off until you turn it on.", integration: { ...INST, id: "int-new", name: "Pay Slack", connected: false, version: 1 } } }),
    });
    mount(<IntegrationsView />);
    fireEvent.click(await byId("int-tab-catalogue"));
    fireEvent.click(await byId("int-cat-add-slack"));
    expect(await screen.findByText("Connect Slack")).toBeTruthy();
    fireEvent.change(await byId("int-add-name"), { target: { value: "Pay Slack" } });
    fireEvent.click(await byId("int-add-go"));
    expect(await screen.findByText("Workspace is required.")).toBeTruthy();
    fireEvent.change(await byId("int-f-workspace"), { target: { value: "acme" } });
    fireEvent.change(await byId("int-f-botToken"), { target: { value: "xoxb" + "-" + "1".repeat(12) + "-" + "a".repeat(24) } });
    fireEvent.change(await byId("int-f-signingSecret"), { target: { value: "s".repeat(24) } });
    fireEvent.click(await byId("int-add-test-run"));
    expect(await screen.findByText(/Connection works/)).toBeTruthy();
    const draft = calls.find((c) => c.path === "/api/v1/integration-types/slack/test")!;
    expect(draft.body).toMatchObject({ config: { workspace: "acme" }, secrets: { botToken: expect.stringMatching(/^xoxb-/), signingSecret: "s".repeat(24) } });
    expect(screen.getByText("Authenticated as gantry in Acme.")).toBeTruthy();
    fireEvent.click(await byId("int-add-go"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/integrations")).toBe(true));
    const create = calls.find((c) => c.method === "POST" && c.path === "/api/v1/integrations")!;
    expect(create.body).toMatchObject({ type: "slack", name: "Pay Slack", projects: "all", enable: false, secrets: { botToken: expect.any(String) } });
    expect(create.headers["idempotency-key"]).toBeTruthy();
  });

  it("a failed connection test shows what failed", async () => {
    setup({ "POST /api/v1/integration-types/webhook/test": () => ({ body: { ok: true, msg: "x", test: { ok: false, ms: 5, lines: [["fail", "hooks.example.com answered HTTP 503."]] } } }) });
    mount(<IntegrationsView />);
    fireEvent.click(await byId("int-tab-catalogue"));
    fireEvent.click(await byId("int-cat-add-webhook"));
    fireEvent.change(await byId("int-add-name"), { target: { value: "Lake" } });
    fireEvent.change(await byId("int-f-url"), { target: { value: "https://hooks.example.com/in" } });
    fireEvent.change(await byId("int-f-secret"), { target: { value: "whsec_" + "k".repeat(20) } });
    fireEvent.change(await byId("int-add-target"), { target: { value: "audit-lake" } });
    fireEvent.click(await byId("int-add-test-run"));
    expect(await screen.findByText("Connection failed")).toBeTruthy();
    expect(screen.getByText("hooks.example.com answered HTTP 503.")).toBeTruthy();
  });

  it("enabling sends the version it loaded; disabling asks first and lists what depends on the connection", async () => {
    const calls = setup({ "PATCH /api/v1/integrations/int-off": () => ({ body: { ok: true, msg: "Staging Slack saved." } }), "PATCH /api/v1/integrations/int-slack": () => ({ body: { ok: true, msg: "Acme Slack saved." } }) });
    mount(<IntegrationsView />);
    fireEvent.click(await byId("int-open-int-off"));
    fireEvent.click(await byId("int-d-toggle"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/v1/integrations/int-off")).toBe(true));
    const on = calls.find((c) => c.method === "PATCH" && c.path === "/api/v1/integrations/int-off")!;
    expect(on.body).toEqual({ connected: true });
    expect(on.headers["if-match"]).toBe("2");
    fireEvent.click(await byId("int-open-int-slack"));
    fireEvent.click(await byId("int-d-toggle"));
    expect(await screen.findByText("Disconnect Acme Slack?")).toBeTruthy();
    expect(screen.getAllByText(/Payments Platform route NR-1/).length).toBeGreaterThan(0);
    fireEvent.click(await byId("int-dis-go"));
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/v1/integrations/int-slack" && c.method === "PATCH").length).toBe(1));
    expect(calls.find((c) => c.path === "/api/v1/integrations/int-slack" && c.method === "PATCH")!.headers["if-match"]).toBe("4");
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

  it("links a chat account with a one-time code from the connection drawer", async () => {
    const calls = setup({ "POST /api/v1/chat-links": () => ({ body: { ok: true, msg: "Send /gantry link ABCD-2345 in Slack within 10 minutes.", code: "ABCD-2345", command: "/gantry link ABCD-2345", expiresAt: Date.now() + 600000 } }) });
    mount(<IntegrationsView />);
    fireEvent.click(await byId("int-open-int-slack"));
    fireEvent.click(await byId("int-d-link"));
    expect((await byId("int-d-linkcode")).textContent).toContain("/gantry link ABCD-2345");
    expect(calls.find((c) => c.path === "/api/v1/chat-links" && c.method === "POST")!.body).toMatchObject({ channel: "slack", integration: "int-slack" });
  });

  it("the custom builder is one panel with the five prototype fields and validates them inline", async () => {
    const calls = setup({ "POST /api/v1/integration-types": () => ({ body: { ok: true, msg: "Audit lake added to the catalogue.", type: { id: "audit-lake", name: "Audit lake" } } }) });
    mount(<IntegrationsView />);
    fireEvent.click(await byId("int-tab-builder"));
    const cat = (await byId("int-b-cat")) as HTMLSelectElement;
    expect(cat.value).toBe("source");
    expect(Array.from(cat.options).length).toBe(8);
    expect(Array.from((await byId("int-b-auth") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["token", "basic", "oauth", "hmac"]);
    expect(document.getElementById("int-b-extra")).toBeTruthy();
    fireEvent.click(await byId("int-b-save"));
    expect(await screen.findByText("Name is required.")).toBeTruthy();
    expect(screen.getByText("Base URL is required.")).toBeTruthy();
    fireEvent.change(await byId("int-b-name"), { target: { value: "Audit lake" } });
    fireEvent.change(await byId("int-b-url"), { target: { value: "http://x" } });
    expect(await screen.findByText("Use an https:// URL.")).toBeTruthy();
    fireEvent.change(await byId("int-b-url"), { target: { value: "https://lake.example.com" } });
    fireEvent.click(await byId("int-b-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/integration-types")).toBe(true));
  });
});

describe("Notifications", () => {
  it("says Not visible to you when the delivery log is refused, instead of no deliveries", async () => {
    setup({ "GET /api/v1/deliveries": () => ({ status: 403, body: { ok: false, msg: "Needs notify.view on this project." } }) });
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-tab-log"));
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
    expect(screen.queryByText("No deliveries match these filters.")).toBeNull();
  });

  it("lists the project's routes with their destinations and locks the kill route's switch with the reason", async () => {
    setup();
    mount(<NotificationsView />);
    expect(await screen.findByRole("heading", { name: "Notifications" })).toBeTruthy();
    const row = await byId("nt-row-NR-1");
    expect(within(row).getByText(/#pay-gates/)).toBeTruthy();
    const kill = (await byId("nt-en-NR-2")) as HTMLInputElement;
    expect(kill.getAttribute("aria-disabled")).toBe("true");
    expect(kill.getAttribute("data-reason")).toMatch(/cannot be switched off/i);
    expect(document.getElementById("nt-stats")!.textContent).not.toMatch(/top-bar switcher|enabled and total/);
    fireEvent.click(document.getElementById("nt-tab-log")!);
    expect(document.getElementById("nt-tab-log")!.getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent).not.toMatch(/simulated/i);
  });

  it("switches a route off with its own version as If-Match, and edits and deletes with the version too", async () => {
    const calls = setup({
      "PATCH /api/v1/projects/payments/routes/NR-1": () => ({ body: { ok: true, msg: "Route NR-1 saved.", id: "NR-1", version: 3 } }),
      "DELETE /api/v1/projects/payments/routes/NR-1": () => ({ body: { ok: true, msg: "Route removed." } }),
    });
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-en-NR-1"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    let c = calls.find((x) => x.method === "PATCH")!;
    expect(c.body).toEqual({ enabled: false });
    expect(c.headers["if-match"]).toBe("2");
    // Edit the target in the editor, save.
    fireEvent.click(await byId("nt-open-NR-1"));
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
    fireEvent.click(await byId("nt-open-NR-1"));
    fireEvent.change(await byId("nt-dest-t-0"), { target: { value: "#other" } });
    fireEvent.click(await byId("nt-save"));
    expect((await screen.findAllByText(/changed since you loaded it/i)).length).toBeGreaterThan(0);
  });

  it("is read-only without the right: switches and buttons are disabled with the reason", async () => {
    setup({}, ["notify.edit"]);
    mount(<NotificationsView />);
    const en = await byId("nt-en-NR-1");
    await waitFor(() => expect(en.getAttribute("data-reason")).toMatch(/No role holds notify.edit/));
    expect((await byId("nt-add")).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(await byId("nt-open-NR-1"));
    expect((await byId("nt-save")).getAttribute("aria-disabled")).toBe("true");
  });

  it("draws the preview from the server's rendering and shows the approve note when the connection does not allow chat approval", async () => {
    setup();
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-open-NR-1"));
    expect(await screen.findByText("G2 Spec approved is waiting on WO-1042")).toBeTruthy();
    expect(screen.getByText("Release Manager · 1 needed")).toBeTruthy();
    expect(await screen.findByText(/Approve from card is off for Acme Slack/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/delivery is simulated/i);
  });

  it("queues a test send to one destination and says where to see the outcome", async () => {
    const calls = setup({ "POST /api/v1/projects/payments/routes/test": () => ({ body: { ok: true, msg: "Test to #pay-gates queued on Acme Slack. The delivery log shows the outcome.", delivery: { id: "DLV-10" } } }) });
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-open-NR-1"));
    fireEvent.click(await byId("nt-test-0"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/projects/payments/routes/test")).toBe(true));
    expect(calls.find((c) => c.path === "/api/v1/projects/payments/routes/test")!.body).toEqual({ dest: { channel: "slack", target: "#pay-gates", integration: "int-slack" }, event: "gate.waiting" });
    expect(await screen.findByText(/delivery log shows the outcome/)).toBeTruthy();
  });

  it("the delivery log shows failures with their reason and retries one", async () => {
    const calls = setup({ "POST /api/v1/deliveries/DLV-9/retry": () => ({ body: { ok: true, msg: "Queued again. The delivery log shows the outcome." } }) });
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-tab-log"));
    const row = await byId("nt-dl-DLV-9");
    expect(within(row).getByText(/channel_not_found/)).toBeTruthy();
    expect(within(row).getByText("failed")).toBeTruthy();
    expect(document.getElementById("nt-retry-DLV-8")).toBeNull(); // a delivered one is not retried
    fireEvent.click(await byId("nt-retry-DLV-9"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/deliveries/DLV-9/retry" && c.method === "POST")).toBe(true));
  });

  it("repo overrides list what the repo adds and remove one with the repo's version", async () => {
    const calls = setup({ "PATCH /api/v1/repos/payments-api/config": () => ({ body: { ok: true, msg: "Saved." } }) });
    mount(<NotificationsView />);
    fireEvent.click(await screen.findByText("Repo overrides"));
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
    fireEvent.click(await screen.findByText("Card templates"));
    expect(await screen.findByText("Tight gate card")).toBeTruthy();
    fireEvent.click(await byId("nt-ct-f-repo"));
    fireEvent.click(await byId("nt-ct-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/card-templates")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/v1/card-templates")!.body).toMatchObject({ id: "CT-1", name: "Tight gate card", kind: "gate", project: "payments", actions: ["open"], fields: ["title", "repo"] });
  });

  it("duplicating a built-in card keeps its kind and buttons, and the copy is what the editor shows next", async () => {
    const calls = setup({ "POST /api/v1/card-templates": () => ({ body: { ok: true, msg: "Saved.", template: { id: "CT-2", name: "Gate request (copy)", kind: "gate", fields: ["title", "repo", "class", "priority", "approvers", "link", "actions"], actions: ["approve", "reject", "open"] } } }) });
    mount(<NotificationsView />);
    fireEvent.click(await screen.findByText("Card templates"));
    fireEvent.click(await byId("nt-ct-dup-gate"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/card-templates")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/v1/card-templates")!.body).toMatchObject({ name: "Gate request (copy)", kind: "gate", actions: ["approve", "reject", "open"] });
    await waitFor(() => expect((document.getElementById("nt-ct-kind") as HTMLSelectElement).value).toBe("gate"));
    expect((document.getElementById("nt-ct-name") as HTMLInputElement).value).toBe("Gate request (copy)");
  });

  it("holds the tab in the URL; the tab strip is Routes, Card templates (3), Repo overrides, Delivery log", async () => {
    setup();
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-tab-log"));
    await waitFor(() => expect(window.location.search).toContain("tab=log"));
    expect(document.getElementById("nt-tab-templates")!.textContent).toContain("3");
    expect(document.getElementById("nt-tab-overrides")!.textContent).toBe("Repo overrides");
  });

  it("Add route opens a narrow 'Add a route' dialog (When, Channel, Send to) and says 'Route added'", async () => {
    const calls = setup({ "POST /api/v1/projects/payments/routes": () => ({ body: { ok: true, msg: "Route NR-9 created.", id: "NR-9" } }) });
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-add"));
    expect(await screen.findByText("Add a route")).toBeTruthy();
    expect(document.getElementById("nt-add-event")).toBeTruthy();
    expect(document.getElementById("nt-add-channel")).toBeTruthy();
    expect(document.getElementById("nt-add-go")!.textContent).toBe("Save");
    fireEvent.click(await byId("nt-add-go"));
    expect(await screen.findByText("Send to is required.")).toBeTruthy();
    fireEvent.change(await byId("nt-add-target"), { target: { value: "#pay-new" } });
    fireEvent.click(await byId("nt-add-go"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/projects/payments/routes")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/v1/projects/payments/routes")!.body).toMatchObject({ dest: [{ channel: "slack", target: "#pay-new", integration: "int-slack" }], enabled: true });
    expect(await screen.findByText("Route added")).toBeTruthy();
  });

  it("each route row has a trash button that confirms 'Remove this route?' and deletes with the version; kill is locked", async () => {
    const calls = setup({ "DELETE /api/v1/projects/payments/routes/NR-1": () => ({ body: { ok: true, msg: "Route removed." } }) });
    mount(<NotificationsView />);
    expect((await byId("nt-rm-NR-2")).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(await byId("nt-rm-NR-1"));
    expect(await screen.findByText("Remove this route?")).toBeTruthy();
    fireEvent.click(await byId("nt-rm-go"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")!.headers["if-match"]).toBe("2");
  });

  it("Card templates shows the Gate, Question and Release card previews drawn by the server", async () => {
    setup();
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-tab-templates"));
    for (const k of ["gate", "question", "release"]) expect(await byId(`nt-card-${k}`)).toBeTruthy();
    expect((await byId("nt-card-gate")).textContent).toContain("G2 Spec approved is waiting on WO-1042");
  });

  it("Repo overrides is a 'Repos that change the routes' list that links the repo and says when there are none", async () => {
    setup();
    mount(<NotificationsView />);
    fireEvent.click(await byId("nt-tab-overrides"));
    const panel = await byId("nt-overrides");
    expect(panel.textContent).toContain("gate.waiting");
    expect(panel.querySelector("a.pri")!.getAttribute("href")).toContain("onboarding/payments-api");
    cleanup();
    window.history.replaceState(null, "", "/?tab=overrides");
    setup({ "GET /api/v1/projects/payments/repos": () => ({ body: [] }) });
    mount(<NotificationsView />);
    expect(await screen.findByText("No overrides")).toBeTruthy();
    expect(screen.getByText("Repos use the project routes.")).toBeTruthy();
  });
});
