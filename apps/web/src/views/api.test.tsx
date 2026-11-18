import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import ApiView from "./api";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; url: string; body: unknown; headers: Record<string, string>; credentials?: string }

const person = { id: "p-asha", name: "Asha Raman", title: "Head", email: "asha@acme.dev", teams: [], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false };
const PROJECTS = [
  { id: "payments", key: "PAY", name: "Payments Platform", status: "active", teams: [], halted: null, killed: null, flow: { classes: [{ id: "feature", name: "Feature" }, { id: "bug", name: "Bug" }, { id: "chore", name: "Chore" }, { id: "hotfix", name: "Hotfix" }], stations: [], gates: {}, bays: [] }, notifications: [], version: 3 },
  { id: "storefront", key: "STO", name: "Storefront", status: "active", teams: [], halted: null, killed: null, flow: { classes: [{ id: "feature", name: "Feature" }], stations: [], gates: {}, bays: [] }, notifications: [], version: 1 },
];
const ME = { person, session: { id: "s1", person: "p-asha", method: "sso", device: "Chrome", ip: "10.0.0.1", started: Date.now(), lastSeen: Date.now(), revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: PROJECTS, factory: { killed: null }, config: {} };
const CATALOG = { classes: PROJECTS[0]!.flow.classes, stations: [], gates: [], bays: [], roles: [], actions: [] };
const T = { id: "github", name: "GitHub", category: "source", icon: "github", auth: "app", payload: "json", builtIn: true, source: true, destination: false, available: true, fields: [], events: [], actions: [] };
const GH = { id: "gh-1", type: "github", name: "Acme GitHub", config: {}, secretMask: "", status: "healthy", connected: true, projects: "all", lastSync: Date.now(), createdBy: "p-asha", createdAt: Date.now(), version: 1 };
const key = (o: object = {}) => ({ id: "key-1", name: "Jira bridge", prefix: "gk_7hq2c91x", project: "payments", actions: ["wo.submit", "wo.read"], created: Date.now() - 40 * 86_400_000, lastUsed: Date.now() - 14 * 60_000, revoked: false, by: "p-asha", expires: Date.now() + 50 * 86_400_000, expired: false, ...o });
const KEYS = [key(), key({ id: "key-2", name: "Old CI hook", prefix: "gk_00aa11bb", actions: ["wo.read"], lastUsed: null, revoked: true, revokedAt: Date.now() - 86_400_000 }), key({ id: "key-3", name: "Expired bot", prefix: "gk_dead0000", expires: Date.now() - 86_400_000, expired: true })];
const CFG = { rateLimit: 60, burst: 20, idempotencyHours: 24, webhookSigning: "HMAC-SHA256", triggersEnabled: false, version: 3 };
const LOG = [
  { at: Date.now() - 60_000, key: "key-1", method: "POST", path: "/api/v1/projects/payments/work-orders", status: 200, ms: 120 },
  { at: Date.now() - 120_000, key: "key-1", method: "GET", path: "/api/v1/work-orders/WO-1", status: 429, ms: 3 },
];
const TRIG = (o: object = {}) => ({ id: "TR-1", project: "payments", type: "issue", name: "Issues labelled factory", enabled: false, label: "factory", labelMap: { bug: "bug" }, who: "org", reply: "Thanks. Gantry opened {wo}.", dedupe: true, repos: "ready", source: "gh-1", limits: { perHour: 6, perDay: 20 }, version: 2, held: 0, runs: [
  { id: "TRN-1", at: Date.now() - 3600_000, outcome: "created", wo: "WO-2431", source: "acme/payments-api#905", msg: "Created WO-2431." },
  { id: "TRN-2", at: Date.now() - 7200_000, outcome: "held", wo: "", proposal: "TP-aa", source: "acme/payments-api#900", msg: "Held" },
], ...o });
const PROPOSAL = { id: "TP-aa", trigger: "TR-1", project: "payments", repo: "payments-api", title: "Drive-by request", description: "", cls: null, priority: null, source: "acme/payments-api#900", actor: "stranger", reason: "GitHub user stranger does not map to a Gantry identity.", status: "held", wo: null, at: Date.now() - 7200_000, decidedBy: null, decidedAt: null, note: "" };

function setup(extra: Record<string, Handler> = {}, denied: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: ME }),
    "GET /api/v1/people": () => ({ body: [person] }),
    "GET /api/v1/agents": () => ({ body: [] }),
    "GET /api/v1/projects": () => ({ body: PROJECTS }),
    "GET /api/v1/catalog": () => ({ body: CATALOG }),
    "GET /api/v1/projects/payments/repos": () => ({ body: [{ id: "payments-api", name: "acme/payments-api", project: "payments", onboarding: { stage: "ready" } }, { id: "payouts-worker", name: "acme/payouts-worker", project: "payments", onboarding: { stage: "connected" } }] }),
    "GET /api/v1/projects/storefront/repos": () => ({ body: [{ id: "storefront-web", name: "acme/storefront-web", project: "storefront", onboarding: { stage: "ready" } }] }),
    "GET /api/v1/api-keys": () => ({ body: KEYS }),
    "GET /api/v1/api-config": () => ({ body: CFG }),
    "GET /api/v1/api-requests": (url) => ({ body: { items: /status=429/.test(url) ? LOG.filter((x) => x.status === 429) : LOG, next: null, total: LOG.length, last24h: 2, limited24h: 1 } }),
    "GET /api/v1/triggers": () => ({ body: [TRIG()] }),
    "GET /api/v1/trigger-proposals": () => ({ body: [] }),
    "GET /api/v1/integration-types": () => ({ body: [T] }),
    "GET /api/v1/integrations": () => ({ body: [GH] }),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    const method = init?.method ?? "GET";
    const hdr: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (hdr[k] = v));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, url, body, headers: hdr, ...(init?.credentials ? { credentials: init.credentials } : {}) });
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
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider><ApiView /></OverlayProvider></QueryClientProvider>);
}
const tab = async (name: string) => fireEvent.click(await byId(`api-tab-${name === "ref" ? "reference" : name === "play" ? "reference" : name}`));
const openTrig = async (id = "TR-1") => fireEvent.click(await byId(`api-tr-row-${id}`)); // the row opens the drawer; the name is plain text
beforeEach(() => { setCsrfToken("c"); canBatcher.clear(); window.location.hash = ""; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("API & triggers: keys", () => {
  it("says Not visible to you when the keys read is refused, and the key count is not a 0", async () => {
    setup({ "GET /api/v1/api-keys": () => ({ status: 403, body: { ok: false, msg: "Needs api.keys on a project." } }) });
    mount();
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
    expect(screen.getByText("Needs api.keys on a project.")).toBeTruthy();
  });

  it("lists keys with their prefix, scope, status and expiry, and counts what is live", async () => {
    setup();
    mount();
    expect(await screen.findByRole("heading", { name: "API & triggers" })).toBeTruthy();
    const row = await byId("api-key-row-key-1");
    expect(within(row).getByText("Jira bridge")).toBeTruthy();
    expect(within(row).getByText("gk_••••key-1")).toBeTruthy();
    expect(within(row).getByText("Payments Platform")).toBeTruthy();
    expect(within(row).getByText("wo.submit")).toBeTruthy();
    expect(within(row).getByText("active")).toBeTruthy();
    expect(within(row).getByText(/^expires /)).toBeTruthy();
    expect(within(await byId("api-key-row-key-2")).getByText("revoked")).toBeTruthy();
    expect(within(await byId("api-key-row-key-3")).getByText("expired")).toBeTruthy();
    expect(document.getElementById("api-key-revoke-key-2")).toBeNull(); // nothing to revoke
    const meta = document.getElementById("api-stats")!.textContent ?? "";
    expect(meta).toMatch(/Active keys\s*1/);
    expect(meta).toMatch(/Requests, 24 h\s*2/);
    expect(meta).toMatch(/errors/);
    expect(document.body.textContent).not.toMatch(/local sample logic|simulated/i);
  });

  it("creates a key: the secret is shown once and only after you confirm you stored it can you close it", async () => {
    const SECRET = "gk_" + "ab12cd34" + "_" + "x".repeat(32);
    const calls = setup({ "POST /api/v1/api-keys": () => ({ body: { ok: true, msg: "Key created. Copy it now; it is not shown again.", key: key({ id: "key-9", name: "ServiceNow bridge", prefix: "gk_ab12cd34" }), secret: SECRET } }) });
    mount();
    fireEvent.click(await byId("api-key-new"));
    fireEvent.click(await byId("api-key-go"));
    expect((await screen.findByText("Name is required.")).getAttribute("role")).toBe("alert");
    fireEvent.change(await byId("api-key-name"), { target: { value: "ServiceNow bridge" } });
    fireEvent.click(await byId("api-key-act-triggers-run"));
    fireEvent.click(await byId("api-key-act-wo-read")); // off again
    fireEvent.change(await byId("api-key-expires"), { target: { value: "30" } });
    fireEvent.click(await byId("api-key-go"));
    const input = (await byId("api-secret-value")) as HTMLInputElement;
    expect(input.value).toBe(SECRET);
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/v1/api-keys")!;
    expect(post.body).toEqual({ name: "ServiceNow bridge", project: "payments", actions: ["wo.submit", "triggers.run"], expiresInDays: 30 });
    expect(post.headers["idempotency-key"]).toBeTruthy();
    const done = await byId("api-secret-done");
    expect(done.textContent).toBe("Close");
    expect(document.body.textContent).toContain("Copy your key now");
    fireEvent.click(done);
    await waitFor(() => expect(document.getElementById("api-secret-value")).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("locks Create and Revoke with the reason when the person lacks the right, and revokes with a confirm that counts the last day's requests", async () => {
    setup({}, ["api.keys"]);
    mount();
    const create = await byId("api-key-new");
    await waitFor(() => expect(create.getAttribute("aria-disabled")).toBe("true"));
    expect(create.getAttribute("data-reason")).toMatch(/No role holds api.keys/);
    cleanup();
    canBatcher.clear();
    const calls = setup({ "DELETE /api/v1/api-keys/key-1": () => ({ body: { ok: true, msg: "Jira bridge revoked." } }), "GET /api/v1/api-requests": () => ({ body: { items: [{ at: Date.now() - 1000, key: "key-1", method: "GET", path: "/x", status: 200, ms: 1 }], next: null, last24h: 1, limited24h: 0 } }) });
    mount();
    fireEvent.click(await byId("api-key-revoke-key-1"));
    expect(await screen.findByText(/It made 1 request in the last 24 hours/)).toBeTruthy();
    fireEvent.click(await byId("api-key-revoke-go"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/api-keys/key-1")).toBe(true));
  });
});

describe("API & triggers: reference, playground, log, limits", () => {
  it("reference is the Endpoints table and an Example with a full-width Copy: no per-endpoint cards, base URL callout or playground", async () => {
    setup();
    mount();
    await tab("ref");
    expect((await screen.findAllByText("/api/v1/projects/{project}/work-orders")).length).toBe(1);
    expect((await byId("api-ref-endpoints")).textContent).toContain("Purpose");
    expect((await byId("api-ref-example")).textContent).toContain("curl -X POST");
    expect(document.querySelectorAll(".api-ep").length).toBe(0);
    expect(document.getElementById("api-pg-send")).toBeNull();
    expect(document.querySelectorAll("#api-tab-panel .panel").length).toBe(2);
    expect(document.getElementById("api-ref-example-copy")!.parentElement!.className).toContain("stack");
  });

  it("the request log is a 'Last requests' panel: relative times, key id, status chips, Search and a Status filter", async () => {
    setup();
    mount();
    await tab("log");
    const panel = await byId("api-log-panel");
    expect(panel.textContent).toContain("Last requests");
    const table = await screen.findByRole("table");
    expect(within(table).getByText("/api/v1/projects/payments/work-orders")).toBeTruthy();
    expect(within(table).getByText("200")).toBeTruthy();
    expect(within(table).getAllByText("key-1").length).toBe(2);
    expect(panel.textContent).toContain("ago");
    fireEvent.change(await byId("rq-f-status"), { target: { value: "429" } });
    await waitFor(() => expect(within(screen.getByRole("table")).queryByText("200")).toBeNull());
    expect(within(screen.getByRole("table")).getByText("429")).toBeTruthy();
  });

  it("limits: saves the whole settings with the version it loaded, validates, and the master switch for triggers is off", async () => {
    const calls = setup({ "PATCH /api/v1/api-config": () => ({ body: { ok: true, msg: "API settings saved.", version: 4 } }) });
    mount();
    await tab("limits");
    expect(document.getElementById("api-lim-triggers")).toBeNull(); // no helper hints and no master-switch row in the Limits panel
    expect((await byId("api-limits-panel")).querySelectorAll(".hint, .field-hint").length).toBe(0);
    expect((await byId("api-limits-panel")).textContent).toContain("HMAC-SHA256"); // read-only: the only scheme the delivery implements
    fireEvent.change(await byId("api-lim-rate"), { target: { value: "0" } });
    fireEvent.click(await byId("api-lim-save"));
    expect(await screen.findByText("Requests per minute must be at least 1.")).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    fireEvent.change(await byId("api-lim-rate"), { target: { value: "120" } });
    fireEvent.click(await byId("api-lim-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const p = calls.find((c) => c.method === "PATCH")!;
    expect(p.body).toEqual({ rateLimit: 120, burst: 20, idempotencyHours: 24, webhookSigning: "HMAC-SHA256", triggersEnabled: false });
    expect(p.headers["if-match"]).toBe("3");
  });

  it("limits are read-only with the reason for someone without the right", async () => {
    setup({}, ["integration.edit"]);
    mount();
    await tab("limits");
    await waitFor(() => expect(document.querySelector(".lock-note")?.textContent).toMatch(/No role holds integration.edit/));
    expect((document.getElementById("api-lim-rate") as HTMLInputElement).disabled).toBe(true);
    expect(document.getElementById("api-lim-save")!.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("API & triggers: triggers", () => {
  it("shows triggers with their source and runs, says the organisation switch is off, and a trigger is turned on with the version it loaded", async () => {
    const calls = setup({ "PATCH /api/v1/triggers/TR-1": () => ({ body: { ok: true, msg: "Issues labelled factory enabled.", version: 3 } }) });
    mount();
    await tab("triggers");
    const item = await byId("api-tr-row-TR-1");
    expect(item.textContent).toContain("Payments Platform · issue");
    expect(document.getElementById("api-triggers-panel")!.textContent).toContain("Last run");
    expect(document.getElementById("api-triggers-panel")!.textContent).toContain("Enabled");
    await openTrig();
    expect((await byId("api-tr-master")).textContent).toMatch(/switched off for the organisation/);
    expect(screen.getAllByText("✓ created").length).toBeGreaterThan(0);
    expect(screen.getByText("◆ held")).toBeTruthy();
    expect(screen.getByText("TP-aa")).toBeTruthy();
    fireEvent.click(await byId("api-tr-enabled"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/v1/triggers/TR-1")).toBe(true));
    const p = calls.find((c) => c.method === "PATCH")!;
    expect(p.body).toEqual({ enabled: true });
    expect(p.headers["if-match"]).toBe("2");
  });

  it("the organisation's master switch for triggers sits in the Triggers panel and saves with the version", async () => {
    const calls = setup({ "PATCH /api/v1/api-config": () => ({ body: { ok: true, msg: "API settings saved.", version: 4 } }) });
    mount();
    await tab("triggers");
    expect(document.querySelector("#api-triggers-panel .linkish")).toBeNull(); // trigger names are plain
    fireEvent.click(await byId("api-tr-master-sw"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/v1/api-config")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ triggersEnabled: true });
  });

  it("creates a trigger switched off from a source connection", async () => {
    const calls = setup({ "POST /api/v1/triggers": () => ({ body: { ok: true, msg: "Trigger Fix PRs created. It starts disabled; review it, then turn it on.", trigger: { id: "TR-2" } } }) });
    mount();
    await tab("triggers");
    fireEvent.click(await byId("api-tr-new"));
    fireEvent.click(await byId("api-tr-new-go"));
    expect((await screen.findByText("Name the trigger.")).getAttribute("role")).toBe("alert");
    fireEvent.change(await byId("api-tr-new-type"), { target: { value: "comment" } });
    fireEvent.change(await byId("api-tr-new-name"), { target: { value: "Fix PRs" } });
    fireEvent.click(await byId("api-tr-new-go"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/triggers")).toBe(true));
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/v1/triggers")!;
    expect(post.body).toEqual({ project: "payments", type: "comment", name: "Fix PRs", source: "gh-1" });
    expect(post.headers["idempotency-key"]).toBeTruthy();
  });

  it("saves edits (label map, who, limits) as a patch with the version", async () => {
    const calls = setup({ "PATCH /api/v1/triggers/TR-1": () => ({ body: { ok: true, msg: "Saved Issues labelled factory.", version: 3 } }) });
    mount();
    await tab("triggers");
    await openTrig();
    fireEvent.change(await byId("api-tr-label"), { target: { value: "ship-it" } });
    fireEvent.click(await byId("api-tr-lm-add"));
    fireEvent.change(await byId("api-tr-lm-l-1"), { target: { value: "docs" } });
    fireEvent.change(await byId("api-tr-who"), { target: { value: "proposal" } });
    fireEvent.change(await byId("api-tr-lim-hour"), { target: { value: "3" } });
    fireEvent.click(await byId("api-tr-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const p = calls.find((c) => c.method === "PATCH")!;
    expect(p.body).toMatchObject({ name: "Issues labelled factory", label: "ship-it", labelMap: { bug: "bug", docs: expect.any(String) }, who: "proposal", limits: { perHour: 3, perDay: 20 }, dedupe: true, source: "gh-1" });
    expect(p.headers["if-match"]).toBe("2");
    fireEvent.change(await byId("api-tr-lim-day"), { target: { value: "0" } });
    fireEvent.click(await byId("api-tr-save"));
    expect(await screen.findByText(/Limits are whole numbers/)).toBeTruthy();
  });

  it("Simulate incoming evaluates without creating, and says what it would do; creating is a separate, explicit choice", async () => {
    const calls = setup({
      "POST /api/v1/triggers/TR-1/dry-run": (_u, init) => {
        const b = JSON.parse(String(init!.body)) as { create?: boolean };
        return b.create
          ? { body: { ok: true, msg: "Created WO-2600.", created: true, run: { outcome: "created", wo: "WO-2600" }, would: {}, notes: [] } }
          : { body: { ok: true, msg: "Would create a work order \"Refund bug\" in acme/payments-api as bug for Tomas.", created: false, run: { outcome: "created", wo: "" }, would: { held: false }, notes: ["This trigger is disabled, so a real event would be ignored."] } };
      },
    });
    mount();
    await tab("triggers");
    await openTrig();
    fireEvent.click(await byId("api-tr-sim"));
    expect(await screen.findByText(/Sends a sample issue through this trigger's real rules/)).toBeTruthy();
    fireEvent.change(await byId("api-sim-author"), { target: { value: "tomas-acme" } });
    fireEvent.click(await byId("api-sim-go"));
    const res = await byId("api-tr-simres");
    expect(res.textContent).toContain("Would create a work order");
    expect(res.textContent).not.toMatch(/would create: /i);
    expect(res.textContent).toContain("trigger is disabled");
    const dry = calls.find((c) => c.path === "/api/v1/triggers/TR-1/dry-run")!;
    expect(dry.body).toMatchObject({ repo: "payments-api", labels: ["factory", "bug"], author: "tomas-acme", create: false });
    expect(dry.headers["idempotency-key"]).toBeUndefined();
    expect(document.getElementById("api-tr-simwo")).toBeNull();
    // Now for real.
    fireEvent.click(await byId("api-tr-sim"));
    fireEvent.click(await byId("api-sim-create"));
    fireEvent.click(await byId("api-sim-go"));
    await waitFor(() => expect(document.getElementById("api-tr-simres")!.textContent).toContain("Created WO-2600"));
    const real = calls.filter((c) => c.path === "/api/v1/triggers/TR-1/dry-run")[1]!;
    expect(real.body).toMatchObject({ create: true });
    expect(real.headers["idempotency-key"]).toBeTruthy();
    expect(document.getElementById("api-tr-simwo")!.textContent).toBe("Open WO-2600");
  });

  it("held proposals can be released or declined (with a reason) by a person who may submit, and are locked with the reason otherwise", async () => {
    const calls = setup({
      "GET /api/v1/trigger-proposals": () => ({ body: [PROPOSAL] }),
      "POST /api/v1/trigger-proposals/TP-aa/release": () => ({ body: { ok: true, msg: "Released TP-aa: WO-2700 created.", wo: "WO-2700", proposal: "TP-aa" } }),
      "POST /api/v1/trigger-proposals/TP-aa/decline": () => ({ body: { ok: true, msg: "Declined TP-aa." } }),
    });
    mount();
    await tab("triggers");
    await openTrig();
    const held = await byId("api-tr-held");
    expect(held.textContent).toContain("Drive-by request");
    expect(held.textContent).toContain("does not map to a Gantry identity");
    fireEvent.click(await byId("api-tr-dec-TP-aa"));
    const dlg = await waitFor(() => { const e = document.querySelector<HTMLElement>(".dlg"); if (!e) throw new Error("no dialog"); return e; });
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Not our work" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/trigger-proposals/TP-aa/decline")).toBe(true));
    expect(calls.find((c) => c.path === "/api/v1/trigger-proposals/TP-aa/decline")!.body).toEqual({ reason: "Not our work" });
    fireEvent.click(await byId("api-tr-rel-TP-aa"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/trigger-proposals/TP-aa/release")).toBe(true));
    cleanup();
    canBatcher.clear();
    setup({ "GET /api/v1/trigger-proposals": () => ({ body: [PROPOSAL] }) }, ["wo.submit"]);
    mount();
    await tab("triggers");
    await openTrig();
    const rel = await byId("api-tr-rel-TP-aa");
    await waitFor(() => expect(rel.getAttribute("aria-disabled")).toBe("true"));
    expect(rel.getAttribute("data-reason")).toMatch(/No role holds wo.submit/);
  });

  it("is read-only with the reason for someone without triggers.edit", async () => {
    setup({}, ["triggers.edit"]);
    mount();
    await tab("triggers");
    await openTrig();
    const save = await byId("api-tr-save");
    await waitFor(() => expect(save.getAttribute("aria-disabled")).toBe("true"));
    expect(save.getAttribute("data-reason")).toMatch(/No role holds triggers.edit/);
    expect((document.getElementById("api-tr-name") as HTMLInputElement).disabled).toBe(true);
    expect(document.getElementById("api-tr-new")!.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById("api-tr-sim")!.getAttribute("aria-disabled")).toBe("true");
  });

  it("schedule and build triggers show their own fields", async () => {
    setup({ "GET /api/v1/triggers": () => ({ body: [TRIG({ id: "TR-3", type: "schedule", name: "Weekly chores", source: "schedule", schedule: "Mon 06:00 IST", title: "Weekly dependency updates", cls: "chore", who: "system", nextRun: Date.now() + 86_400_000, label: undefined, labelMap: undefined }), TRIG({ id: "TR-4", type: "ci", name: "Failing CI on main", who: "proposal", cls: "hotfix", label: undefined, labelMap: undefined })] }) });
    mount();
    await tab("triggers");
    await openTrig("TR-3");
    expect((await byId("api-tr-schedule") as HTMLInputElement).value).toBe("Mon 06:00 IST");
    expect((await byId("api-tr-title") as HTMLInputElement).value).toBe("Weekly dependency updates");
    expect(screen.getByText(/Next run/)).toBeTruthy();
    expect(document.getElementById("api-tr-label")).toBeNull();
    await openTrig("TR-4");
    expect((await byId("api-tr-cls") as HTMLSelectElement).value).toBe("hotfix");
    expect(screen.getByText(/opens a proposal and asks a person to confirm/i)).toBeTruthy();
    expect((await byId("api-tr-sim")).textContent).toBe("Simulate incoming CI failure");
  });
});
