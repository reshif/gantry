import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { updatePrefs } from "../lib/prefs";
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
/** Deep links the screen keeps for what the prototype does not draw: the rule editor and the sections behind Quick start. */
const goto = (q: string) => { window.history.replaceState(null, "", `/?${q}`); window.dispatchEvent(new Event("gantry:urlstate")); };
const openTr = async (id: string) => { await byId(`api-tr-open-${id}`); goto(`tab=triggers&edit=${id}`); await byId("api-tr-sim"); };
/** Quick start, then one of the sections linked under the curl (ref, play, log, limits). */
const docs = async (sec: string) => { await tab("docs"); goto(`tab=docs&sec=${sec}`); };
const text = () => document.body.textContent ?? "";
const tab = async (name: string) => fireEvent.click(await byId(`api-tab-${name}`));
beforeEach(() => { setCsrfToken("c"); canBatcher.clear(); window.location.hash = ""; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("API & triggers: quick start", () => {
  it("shows the prototype card (one curl, no copy bar, no disclosures) and no links to the reference, playground, log or limits", async () => {
    setup();
    mount();
    await tab("docs");
    const pre = await byId("api-quickstart");
    expect(pre.textContent).toContain('-H "Idempotency-Key: $(uuidgen)"');
    expect(document.getElementById("api-quickstart-copy")).toBeNull();
    expect(document.querySelector("details")).toBeNull();
    expect(document.querySelector(".card a")).toBeNull();
    goto("tab=docs&sec=ref");
    expect(await screen.findByText("/api/v1/work-orders/{id}/messages")).toBeTruthy();
  });

  it("the reference, playground, request log and limits are reached by clicking the switch on Quick start", async () => {
    setup();
    mount();
    await tab("docs");
    await byId("api-quickstart");
    fireEvent.click(screen.getByLabelText("Endpoint reference"));
    expect(await screen.findByText("/api/v1/work-orders/{id}/messages")).toBeTruthy();
    fireEvent.click(await byId("api-sec-back"));
    fireEvent.click(await screen.findByLabelText("Playground"));
    await waitFor(() => expect(window.location.search).toContain("sec=play"));
    fireEvent.click(await byId("api-sec-back"));
    fireEvent.click(await screen.findByLabelText("Request log"));
    await waitFor(() => expect(text()).toContain("/api/v1/work-orders/WO-1"));
    fireEvent.click(await byId("api-sec-back"));
    fireEvent.click(await screen.findByLabelText("Limits"));
    await waitFor(() => expect(window.location.search).toContain("sec=limits"));
  });

  it("clicking a trigger opens its drawer, and Edit rules there opens the rule editor with Simulate", async () => {
    setup();
    mount();
    await tab("triggers");
    fireEvent.click(await byId("api-tr-open-TR-1"));
    fireEvent.click(await byId("api-tr-edit"));
    await byId("api-tr-sim");
    expect(window.location.search).toContain("edit=TR-1");
  });

  it("the trigger drawer is the prototype's (no disclosure); it has one foot button, Edit rules", async () => {
    setup();
    mount();
    await tab("triggers");
    fireEvent.click(await byId("api-tr-open-TR-1"));
    await byId("api-tr-open-TR-1");
    expect(document.querySelector("details")).toBeNull();
    expect(document.querySelector(".drawer-f")!.textContent).toBe("Edit rules");
    expect(document.getElementById("api-tr-more")).toBeNull();
    expect(window.location.search).not.toContain("open=");
  });
});

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
    expect(await screen.findByRole("heading", { name: "API and triggers" })).toBeTruthy();
    const row = await byId("api-key-row-key-1");
    expect(within(row).getByText("Jira bridge")).toBeTruthy();
    expect(within(row).getByText("gk_7hq2c91x…")).toBeTruthy();
    expect(within(row).getByText("PAY")).toBeTruthy();
    expect(within(row).getByText("wo.submit")).toBeTruthy();
    expect(within(row).getByText("Revoke")).toBeTruthy();
    expect(within(await byId("api-key-row-key-2")).getByText("Revoked")).toBeTruthy();
    expect(within(await byId("api-key-row-key-3")).getByText("Expired")).toBeTruthy();
    expect(document.getElementById("api-key-revoke-key-2")).toBeNull(); // nothing to revoke
    expect(document.getElementById("api-stats")).toBeNull();
    expect(document.body.textContent).toContain("3 of 3");
    expect(document.getElementById("api-key-new")!.textContent).toBe("Create key"); // in the page head, not the filter bar
    expect(document.body.textContent).not.toMatch(/local sample logic|simulated/i);
  });

  it("narrows keys to the project chosen in the top bar, and keeps the total as the denominator (prototype: 1 of 3)", async () => {
    setup({ "GET /api/v1/api-keys": () => ({ body: [...KEYS, key({ id: "key-9", name: "Storefront bot", project: "storefront" })] }) });
    updatePrefs({ project: "storefront", scopeAll: false });
    mount();
    await byId("api-key-row-key-9");
    expect(document.getElementById("api-key-row-key-1")).toBeNull();
    expect(document.body.textContent).toContain("1 of 4");
    updatePrefs({ project: null, scopeAll: true });
  });

  it("creates a key: the secret is shown once and only after you confirm you stored it can you close it", async () => {
    const SECRET = "gk_" + "ab12cd34" + "_" + "x".repeat(32);
    const calls = setup({ "POST /api/v1/api-keys": () => ({ body: { ok: true, msg: "Key created. Copy it now; it is not shown again.", key: key({ id: "key-9", name: "ServiceNow bridge", prefix: "gk_ab12cd34" }), secret: SECRET } }) });
    mount();
    fireEvent.click(await byId("api-key-new"));
    fireEvent.click(await byId("api-key-go"));
    expect((await screen.findByText("Name is required.")).getAttribute("role")).toBe("alert");
    fireEvent.change(await byId("api-key-name"), { target: { value: "ServiceNow bridge" } });
    expect(document.getElementById("api-key-expires")).toBeNull();
    expect(document.querySelector(".dlg details")).toBeNull();
    fireEvent.click(await byId("api-key-go"));
    const input = (await byId("api-secret-value")) as HTMLInputElement;
    expect(input.value).toBe(SECRET);
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/v1/api-keys")!;
    expect(post.body).toEqual({ name: "ServiceNow bridge", project: "payments", actions: ["wo.submit", "wo.read"], expiresInDays: 90 });
    expect(post.headers["idempotency-key"]).toBeTruthy();
    expect(document.querySelector(".dlg h2, [role=dialog] h2")!.textContent).toContain("Copy your key now");
    fireEvent.click(await byId("api-secret-done"));
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
    expect(await screen.findByText("Revoked Jira bridge")).toBeTruthy(); // the prototype's warn toast, not the server's empty message
  });

  it("keeps sort and direction in the URL when the tab changes", async () => {
    setup();
    goto("sort=name&dir=asc");
    mount();
    await tab("triggers");
    await waitFor(() => expect(window.location.search).toContain("tab=triggers"));
    expect(window.location.search).toContain("sort=name");
    expect(window.location.search).toContain("dir=asc");
  });
});

describe("API & triggers: reference, playground, log, limits", () => {
  it("documents the real public API with copyable curl requests, and the real webhook signature", async () => {
    setup();
    mount();
    await docs("ref");
    expect(await screen.findByText("/api/v1/projects/{project}/work-orders")).toBeTruthy();
    expect(screen.getByText("/api/v1/work-orders/{id}/messages")).toBeTruthy();
    expect(screen.getByText("/api/v1/triggers/{id}/fire")).toBeTruthy();
    const curl = (await byId("api-ref-copy-0")).closest(".api-code")!.querySelector("pre")!.textContent!;
    expect(curl).toContain("-H \"Authorization: Bearer $GANTRY_KEY\"");
    expect(curl).toContain("Idempotency-Key");
    expect(screen.getByText("60/min")).toBeTruthy();
    expect((await byId("api-ref-hook")).closest(".api-code")!.querySelector("pre")!.textContent).toContain("/hooks/trigger/<connection id>");
    expect((await byId("api-ref-sig")).closest(".api-code")!.querySelector("pre")!.textContent).toContain("X-Gantry-Signature");
  });

  it("the playground sends a real request with the pasted key as an external client would, and shows the response", async () => {
    const calls = setup({ "POST /api/v1/projects/payments/work-orders": () => ({ body: { ok: true, msg: "WO-2500 submitted to Payments Platform as Feature.", id: "WO-2500" } }) });
    mount();
    await docs("play");
    const send = await byId("api-pg-send");
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(send.getAttribute("data-reason")).toMatch(/Paste a key/);
    const secret = "gk_" + "ab12cd34" + "_" + "y".repeat(32);
    fireEvent.change(await byId("api-pg-secret"), { target: { value: secret } });
    await waitFor(() => expect(document.getElementById("api-pg-send")!.getAttribute("aria-disabled")).toBeNull());
    expect((await byId("api-pg-idem-gen")).tagName).toBe("BUTTON");
    fireEvent.click(await byId("api-pg-idem-gen"));
    fireEvent.click(await byId("api-pg-send"));
    expect((await byId("api-pg-response")).textContent).toContain("WO-2500");
    const c = calls.find((x) => x.method === "POST" && x.path === "/api/v1/projects/payments/work-orders")!;
    expect(c.headers.authorization).toBe(`Bearer ${secret}`);
    expect(c.credentials).toBe("omit"); // no cookie: a wrong key can never sign the person out
    expect(c.headers["idempotency-key"]).toMatch(/^pg-/);
    expect(c.body).toMatchObject({ repo: "payments-api", priority: "P2", title: "Retry failed payout webhooks with backoff" });
    expect(document.getElementById("api-pg-open")?.textContent).toBe("Open WO-2500");
    expect(document.querySelector(".api-pre")!.textContent).not.toContain(secret); // the preview shows the prefix only
  });

  it("a refused request shows its status and message without leaving the screen", async () => {
    setup({ "POST /api/v1/projects/payments/work-orders": () => ({ status: 401, body: { ok: false, msg: "The API key is not valid." } }) });
    mount();
    await docs("play");
    fireEvent.change(await byId("api-pg-secret"), { target: { value: "gk_" + "00000000_" + "z".repeat(30) } });
    fireEvent.click(await byId("api-pg-send"));
    expect(await screen.findByText("The API key is not valid.", { selector: ".api-resline span" })).toBeTruthy();
    expect(document.querySelector(".api-resline .outcome")!.textContent).toBe("✕ 401");
    expect(document.getElementById("api-pg-open")).toBeNull();
  });

  it("the request log lists requests and filters by status through the API", async () => {
    const calls = setup();
    mount();
    await docs("log");
    const table = await screen.findByRole("table");
    expect(within(table).getByText("/api/v1/projects/payments/work-orders")).toBeTruthy();
    expect(within(table).getByText("✓ 200")).toBeTruthy();
    expect(within(table).getAllByText("Jira bridge").length).toBe(2);
    fireEvent.change(await byId("api-log-status"), { target: { value: "429" } });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/api-requests" && /status=429/.test(c.url))).toBe(true));
    await waitFor(() => expect(within(screen.getByRole("table")).queryByText("✓ 200")).toBeNull());
    expect(within(screen.getByRole("table")).getByText("◆ 429")).toBeTruthy();
  });

  it("limits: saves the whole settings with the version it loaded, validates, and the master switch for triggers is off", async () => {
    const calls = setup({ "PATCH /api/v1/api-config": () => ({ body: { ok: true, msg: "API settings saved.", version: 4 } }) });
    mount();
    await docs("limits");
    expect((await byId("api-lim-triggers") as HTMLInputElement).checked).toBe(false);
    expect((await byId("api-lim-sign")).querySelectorAll("option").length).toBe(1); // only the scheme the delivery implements
    fireEvent.change(await byId("api-lim-rate"), { target: { value: "0" } });
    fireEvent.click(await byId("api-lim-save"));
    expect(await screen.findByText(/Use whole numbers/)).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    fireEvent.change(await byId("api-lim-rate"), { target: { value: "120" } });
    fireEvent.click(await byId("api-lim-triggers"));
    fireEvent.click(await byId("api-lim-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const p = calls.find((c) => c.method === "PATCH")!;
    expect(p.body).toEqual({ rateLimit: 120, burst: 20, idempotencyHours: 24, webhookSigning: "HMAC-SHA256", triggersEnabled: true });
    expect(p.headers["if-match"]).toBe("3");
  });

  it("limits are read-only with the reason for someone without the right", async () => {
    setup({}, ["integration.edit"]);
    mount();
    await docs("limits");
    await waitFor(() => expect(document.body.textContent).toMatch(/No role holds integration.edit/));
    expect((document.getElementById("api-lim-rate") as HTMLInputElement).disabled).toBe(true);
    expect(document.getElementById("api-lim-save")!.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("API & triggers: triggers", () => {
  it("shows triggers with their source and runs, says the organisation switch is off, and a trigger is turned on with the version it loaded", async () => {
    const calls = setup({ "PATCH /api/v1/triggers/TR-1": () => ({ body: { ok: true, msg: "Issues labelled factory enabled.", version: 3 } }) });
    mount();
    await tab("triggers");
    const item = await byId("api-tr-open-TR-1");
    expect(item.textContent).toContain("Issues labelled factory");
    await openTr("TR-1");
    for (const w of ["Acme GitHub", "Issue with label", "Payments Platform"]) expect(document.body.textContent).toContain(w);
    expect(document.querySelector(".dlg")!.textContent).toContain("TR-1");
    expect((await byId("api-tr-master")).textContent).toMatch(/switched off for the organisation/);
    expect(screen.getByText("✓ created")).toBeTruthy();
    expect(screen.getByText("◆ held")).toBeTruthy();
    expect(screen.getByText("TP-aa")).toBeTruthy();
    fireEvent.click(await byId("api-tr-en-TR-1"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/v1/triggers/TR-1")).toBe(true));
    const p = calls.find((c) => c.method === "PATCH")!;
    expect(p.body).toEqual({ enabled: true });
    expect(p.headers["if-match"]).toBe("2");
  });

  it("creates a trigger switched off from a source connection", async () => {
    const calls = setup({ "POST /api/v1/triggers": () => ({ body: { ok: true, msg: "Trigger Fix PRs created. It starts disabled; review it, then turn it on.", trigger: { id: "TR-2" } } }) });
    mount();
    await tab("triggers");
    fireEvent.click(await byId("api-tr-new"));
    fireEvent.click(await byId("api-tr-new-go"));
    expect((await screen.findByText("Name is required.")).getAttribute("role")).toBe("alert");
    fireEvent.change(await byId("api-tr-new-type"), { target: { value: "pr-comment" } });
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
    await openTr("TR-1");
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
    await openTr("TR-1");
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
    await openTr("TR-1");
    const held = await byId("api-tr-held");
    expect(held.textContent).toContain("Drive-by request");
    expect(held.textContent).toContain("does not map to a Gantry identity");
    fireEvent.click(await byId("api-tr-dec-TP-aa"));
    const dlg = await waitFor(() => { const e = Array.from(document.querySelectorAll<HTMLElement>(".dlg")).pop(); if (!e) throw new Error("no dialog"); return e; });
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
    await openTr("TR-1");
    const rel = await byId("api-tr-rel-TP-aa");
    await waitFor(() => expect(rel.getAttribute("aria-disabled")).toBe("true"));
    expect(rel.getAttribute("data-reason")).toMatch(/No role holds wo.submit/);
  });

  it("is read-only with the reason for someone without triggers.edit", async () => {
    setup({}, ["triggers.edit"]);
    mount();
    await tab("triggers");
    await openTr("TR-1");
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
    await openTr("TR-3");
    expect((await byId("api-tr-schedule") as HTMLInputElement).value).toBe("Mon 06:00 IST");
    expect((await byId("api-tr-title") as HTMLInputElement).value).toBe("Weekly dependency updates");
    expect(screen.getByText(/Next run/)).toBeTruthy();
    expect(document.getElementById("api-tr-label")).toBeNull();
    fireEvent.click(within(document.querySelector<HTMLElement>(".dlg")!).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.getElementById("api-tr-schedule")).toBeNull());
    await byId("api-tr-open-TR-4");
    goto("tab=triggers&edit=TR-4");
    await waitFor(() => expect((document.getElementById("api-tr-cls") as HTMLSelectElement | null)?.value).toBe("hotfix"));
    expect((await byId("api-tr-cls") as HTMLSelectElement).value).toBe("hotfix");
    expect(screen.getByText(/opens a proposal and asks a person to confirm/i)).toBeTruthy();
    expect((await byId("api-tr-sim")).textContent).toBe("Simulate incoming CI failure");
  });
});
