import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG, VENDOR_TEMPLATES } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import ModelsView from "./models";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: any; headers: Record<string, string>; query: URLSearchParams }

const person = (id: string, name: string) => ({ id, name, title: "Engineer", email: `${id}@acme.dev`, teams: ["payments"], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "", away: null, version: 2 });
const PEOPLE = [person("p-asha", "Asha Raman")];
const project = (id: string, name: string, regulated = false) => ({ id, name, key: id.toUpperCase(), status: "active", teams: [], owner: "p-asha", template: "t", regulated, desc: "", approvers: {}, notifications: [], mcp: [], budget: { monthly: 1000, mtd: 0, alertAt: 0.8 }, created: 0, halted: null, killed: null, overlay: "", version: 1 });
const PAYMENTS = project("payments", "Payments Platform");
const RISK = project("risk", "Risk and Compliance", true);
const model = (id: string, name: string, vendor: string, o: object = {}) => ({ id, name, enabled: true, context: 500000, inPrice: 3, outPrice: 15, vendor, canonical: id, ...o });
const VENDORS = [
  { id: "anthropic", name: "Anthropic", product: "Claude API", connected: true, health: "healthy", latency: 820, mtd: 4182.4, budget: 9000, keyMask: "sk-ant-••••••••3f9a", region: "us-east / eu (API)", endpoint: "", residency: "Processed in the US by default.", retention: "standard", version: 3,
    models: [model("claude-opus-5-5", "Claude Opus 5.5", "anthropic", { inPrice: 5, outPrice: 25 }), model("claude-sonnet-5-5", "Claude Sonnet 5.5", "anthropic"), model("claude-haiku-5-5", "Claude Haiku 5.5", "anthropic", { enabled: false })] },
  { id: "bedrock", name: "Amazon Bedrock", product: "Bedrock runtime", connected: true, health: "degraded", latency: 1460, mtd: 2800, budget: 3000, keyMask: "AKIA••••••••QX2M", region: "eu-central-1", endpoint: "", residency: "Requests stay in eu-central-1.", retention: "zero", version: 2,
    models: [model("bedrock-claude-sonnet-5-5", "Claude Sonnet 5.5 (Bedrock)", "bedrock", { canonical: "claude-sonnet-5-5" })] },
  { id: "local", name: "Local models", product: "vLLM endpoint", connected: false, health: "offline", latency: 0, mtd: 0, budget: 0, keyMask: "", region: "on-prem", endpoint: "http://gpu-pool.internal:8000/v1", residency: "Never leaves the network.", retention: "standard", version: 1,
    models: [model("local-coder", "coder-34b", "local", { enabled: false, inPrice: 0, outPrice: 0 })] },
  { id: "mistral-eu", name: "Mistral EU", product: "Custom vendor · OpenAI-compatible", connected: true, health: "healthy", latency: 0, mtd: 0, budget: 0, keyMask: "sk-••••••••ab12", region: "eu-west-1", endpoint: "https://llm.example.com/v1", residency: "", retention: "zero", custom: true, qualified: { build: { suite: "S", run: "R", at: "x" } }, version: 5, models: [] },
];
const TEMPLATES = VENDOR_TEMPLATES;
const ROUTING = { defaultModel: "claude-opus-5-5", overrides: { intake: "claude-haiku-5-5" }, fallback: ["claude-opus-5-5", "claude-sonnet-5-5"], rules: [{ id: "RR-1", tag: "regulated", use: "bedrock", region: "eu-central-1", alt: "local", note: "Regulated repos stay in the EU." }], version: 4 };
const AGENTS = [{ id: "ag-build", name: "Build agent", station: "build", model: "claude-sonnet-5-5", fallbacks: ["claude-opus-5-5"], initials: "B" }];
const REPOS = [{ id: "payments-api", name: "acme/payments-api", project: "payments", tags: ["pci"] }, { id: "risk-engine", name: "acme/risk-engine", project: "risk", tags: [] }];
const NOW = Date.now();
const PRICES = { current: 2, versions: [
  { version: 2, effectiveFrom: new Date(NOW - 86400000).toISOString(), publishedAt: new Date(NOW - 86400000).toISOString(), publishedBy: "p-asha", note: "Price cut", prices: { "claude-opus-5-5": { in: 5, out: 25 } } },
  { version: 1, effectiveFrom: new Date(NOW - 9 * 86400000).toISOString(), publishedAt: new Date(NOW - 9 * 86400000).toISOString(), publishedBy: "system", note: "Seeded", prices: {} },
] };
const BUDGETS = [{ project: "payments", monthly: 1000, alertAt: 0.8, perWorkOrder: 0, spent: 120.5, version: 1 }, { project: "risk", monthly: 500, alertAt: 0.8, perWorkOrder: 20, spent: 3, version: 1 }];
const ME = { person: PEOPLE[0], session: { id: "s1", person: "p-asha", method: "sso", device: "Chrome", ip: "1", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: [PAYMENTS, RISK], factory: { killed: null }, config: {} };

function setup(extra: Record<string, Handler> = {}, denied: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: ME }),
    "GET /api/v1/people": () => ({ body: PEOPLE }),
    "GET /api/v1/projects": () => ({ body: [PAYMENTS, RISK] }),
    "GET /api/v1/agents": () => ({ body: AGENTS }),
    "GET /api/v1/catalog": () => ({ body: DEFAULT_CATALOG }),
    "GET /api/v1/vendors": () => ({ body: VENDORS }),
    "GET /api/v1/vendor-templates": () => ({ body: TEMPLATES }),
    "GET /api/v1/routing": () => ({ body: ROUTING }),
    "GET /api/v1/prices": () => ({ body: PRICES }),
    "GET /api/v1/budgets": () => ({ body: BUDGETS }),
    "GET /api/v1/projects/payments/repos": () => ({ body: [REPOS[0]] }),
    "GET /api/v1/projects/risk/repos": () => ({ body: [REPOS[1]] }),
    "GET /api/v1/routing/resolve": (url) => {
      const q = new URL(url, "http://x").searchParams;
      return q.get("repo") === "risk-engine"
        ? { body: { model: "bedrock-claude-sonnet-5-5", vendor: "bedrock", wanted: "claude-opus-5-5", layer: "default", steps: ["Factory default: claude-opus-5-5", "RR-1: repos tagged regulated use Amazon Bedrock only."], blocked: null, crossModel: false, sameModelFallback: true, rule: { id: "RR-1", tag: "regulated" } } }
        : { body: { model: "claude-opus-5-5", vendor: "anthropic", wanted: "claude-opus-5-5", layer: "default", steps: ["Factory default: claude-opus-5-5"], blocked: null, crossModel: false, sameModelFallback: false, rule: null } };
    },
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
  return render(<QueryClientProvider client={qc}><OverlayProvider><ModelsView /></OverlayProvider></QueryClientProvider>);
}
const ok = (extra: object = {}) => ({ body: { ok: true, msg: "Done.", ...extra } });
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.path !== "/api/v1/can");
const type = (el: HTMLElement, v: string) => fireEvent.change(el, { target: { value: v } });

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "#models/vendors";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Models screen (legacy models.js on the real API)", () => {
  it("opens on the model catalog: one table of every model with tier, price, used at and a switch", async () => {
    setup();
    window.location.hash = "#models";
    mount();
    const t = await byId("mc-table");
    expect(t.textContent).toContain("Claude Haiku");
    expect(t.querySelector("#mc-claude-haiku-5-5")).toBeTruthy();
    expect(document.getElementById("vendor-anthropic")).toBeNull();
  });
  it("shows the vendor hub: health from real calls, key mask, residency, models and the title block", async () => {
    setup();
    window.location.hash = "#models/vendors";
    mount();
    const a = await byId("vendor-anthropic");
    expect(within(a).getByText("Anthropic")).toBeTruthy();
    expect(a.textContent).toContain("sk-ant-••••••••3f9a");
    expect(a.textContent).toContain("$4,182 / $9,000");
    expect(a.querySelector(".md-def")?.textContent).toBe("factory default");
    expect(within(a).getByText("Used by")).toBeTruthy();
    expect(a.querySelector("#mt-claude-haiku-5-5")).toBeTruthy();
    expect((a.querySelector("#mt-claude-haiku-5-5") as HTMLInputElement).checked).toBe(false);
    const b = await byId("vendor-bedrock");
    expect(b.querySelector(".vendor-head .status")?.textContent).toContain("Degraded");
    expect(b.textContent).toContain("Data retention: zero");
    const l = await byId("vendor-local");
    expect(l.classList.contains("is-off")).toBe(true);
    expect(l.textContent).toContain("Not connected");
    expect(l.querySelector("#vendor-connect-local")?.textContent).toContain("Connect Local models");
    expect(document.querySelector(".md-incident")?.textContent).toContain("Amazon Bedrock is degraded (p50 1460 ms)");
    expect(document.querySelector(".ph .sub")!.textContent).toBe("Which models agents may use, what they cost and where they are used.");
    expect(document.getElementById("md-discover")).toBeNull();
    expect(document.getElementById("md-back")).toBeTruthy();
    expect(document.getElementById("vendor-test-anthropic")).toBeNull();
  });

  it("toggles a model through the real command, and locks the factory default and a primary model with the reason", async () => {
    const calls = setup({ "PATCH /api/v1/models/claude-haiku-5-5": () => ok({ msg: "Claude Haiku 5.5 enabled." }) });
    mount();
    fireEvent.click(await byId("mt-claude-haiku-5-5"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "PATCH", path: "/api/v1/models/claude-haiku-5-5", body: { enabled: true } });
    expect((await byId("mt-claude-opus-5-5")).getAttribute("data-reason")).toMatch(/factory default/);
    expect((await byId("mt-claude-sonnet-5-5")).getAttribute("data-reason")).toMatch(/Primary model of Build agent/);
    expect((await byId("md-rm-claude-opus-5-5")).getAttribute("data-reason")).toMatch(/factory default/);
    expect((await byId("md-rm-claude-sonnet-5-5")).getAttribute("data-reason")).toMatch(/fallback order/);
    expect((await byId("mt-local-coder")).getAttribute("data-reason")).toMatch(/Connect Local models first/);
    expect(writes(calls)).toHaveLength(1);
  });

  it("connects a vendor: the key goes to the server, never into the screen afterwards; validation before the call", async () => {
    const calls = setup({ "PATCH /api/v1/vendors/local": () => ok({ msg: "Local models connected." }) });
    mount();
    fireEvent.click(await byId("vendor-connect-local"));
    const ep = await byId("vc-endpoint");
    expect((ep as HTMLInputElement).value).toBe("http://gpu-pool.internal:8000/v1");
    type(ep, "ftp://nope");
    fireEvent.click(await byId("vc-submit"));
    await waitFor(() => expect(document.querySelector(".form-err")?.textContent).toMatch(/http:\/\/ or https:\/\//));
    expect(writes(calls)).toHaveLength(0);
    type(ep, "http://gpu-pool.internal:8000/v1");
    type(await byId("vc-key"), "tok-" + "9".repeat(12));
    type(await byId("vc-budget"), "250");
    type(await byId("vc-retention"), "zero");
    fireEvent.click(await byId("vc-submit"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const w = writes(calls)[0]!;
    expect(w).toMatchObject({ method: "PATCH", path: "/api/v1/vendors/local", body: { action: "vendor.connect", patch: { key: "tok-" + "9".repeat(12), connected: true, budget: 250, retention: "zero", endpoint: "http://gpu-pool.internal:8000/v1" } } });
    expect(document.body.innerHTML).not.toContain("tok-" + "9".repeat(12));
  });

  it("refuses a short hosted key before calling, and shows the server's refusal", async () => {
    const calls = setup({ "PATCH /api/v1/vendors/anthropic": () => ({ status: 409, body: { ok: false, msg: "This changed since you loaded it. Reload and try again." } }) });
    mount();
    fireEvent.click(await byId("vendor-connect-anthropic"));
    type(await byId("vc-key"), "short");
    fireEvent.click(await byId("vc-submit"));
    await waitFor(() => expect(document.querySelector(".form-err")?.textContent).toMatch(/at least 8 characters/));
    expect(writes(calls)).toHaveLength(0);
    type(await byId("vc-key"), "k".repeat(20));
    fireEvent.click(await byId("vc-submit"));
    await waitFor(() => expect(document.querySelector(".form-err")?.textContent).toMatch(/changed since you loaded/));
    expect(writes(calls)[0]!.headers).toBeTruthy();
  });

  it("disconnect is locked while the factory default is on the vendor", async () => {
    const calls = setup({ "PATCH /api/v1/vendors/bedrock": () => ok({ msg: "Amazon Bedrock disconnected." }) });
    mount();
    fireEvent.click(await byId("vendor-disc-anthropic"));
    expect((await byId("vd-submit")).getAttribute("data-reason")).toMatch(/factory default model is on Anthropic/);
    fireEvent.click(await byId("vd-submit"));
    expect(writes(calls)).toHaveLength(0);
    cleanup();
    mount();
    fireEvent.click(await byId("vendor-disc-bedrock"));
    fireEvent.click(await byId("vd-submit"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "PATCH", path: "/api/v1/vendors/bedrock", body: { patch: { connected: false }, action: "vendor.disconnect" } });
  });

  it("adds a custom vendor and a model with prices and a same-model link, each with an idempotency key", async () => {
    const calls = setup({
      "POST /api/v1/vendors": () => ok({ msg: "Acme gateway added.", vendor: { id: "acme-gateway", name: "Acme gateway" } }),
      "POST /api/v1/models": () => ok({ msg: "Mistral Large added to Mistral EU." }),
    });
    mount();
    fireEvent.click(await byId("md-add-vendor"));
    fireEvent.click(await byId("va-manual"));
    fireEvent.click(await byId("va-ok"));
    await waitFor(() => expect(document.querySelector(".form-err")?.textContent).toBe("Name the vendor."));
    type(await byId("va-name"), "Acme gateway");
    type(await byId("va-endpoint"), "http://insecure.example.com");
    fireEvent.click(await byId("va-ok"));
    await waitFor(() => expect(document.querySelector(".form-err")?.textContent).toMatch(/https:\/\//));
    type(await byId("va-endpoint"), "https://llm.acme.dev/v1");
    type(await byId("va-key"), "k".repeat(16));
    type(await byId("va-region"), "eu-west-1");
    type(await byId("va-retention"), "zero");
    fireEvent.click(await byId("va-ok"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "POST", path: "/api/v1/vendors", body: { name: "Acme gateway", endpoint: "https://llm.acme.dev/v1", key: "k".repeat(16), region: "eu-west-1", retention: "zero" } });
    expect(writes(calls)[0]!.headers["idempotency-key"]).toBeTruthy();

    cleanup();
    mount();
    fireEvent.click(await byId("vendor-addmodel-mistral-eu"));
    type(await byId("ma-name"), "Mistral Large");
    type(await byId("ma-id"), "mistral-large");
    type(await byId("ma-in"), "2");
    type(await byId("ma-out"), "6");
    type(await byId("ma-tier"), "frontier");
    type(await byId("ma-same"), "claude-sonnet-5-5");
    fireEvent.click(await byId("ma-ok"));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]).toMatchObject({ method: "POST", path: "/api/v1/models", body: { vendor: "mistral-eu", def: { id: "mistral-large", name: "Mistral Large", inPrice: "2", outPrice: "6", tier: "frontier", canonical: "claude-sonnet-5-5" } } });
    expect(writes(calls)[1]!.headers["idempotency-key"]).toBeTruthy();
  });

  it("removes a model through the dialog", async () => {
    const calls = setup({ "DELETE /api/v1/models/local-coder": () => ok({ msg: "coder-34b removed." }) });
    mount();
    fireEvent.click(await byId("md-rm-local-coder"));
    fireEvent.click(await byId("md-rm-ok"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "DELETE", path: "/api/v1/models/local-coder" });
  });

  it("shows station qualification for a custom vendor and records it", async () => {
    const calls = setup({ "POST /api/v1/vendors/mistral-eu/qualify": () => ok({ msg: "Mistral EU is qualified for Verify." }) });
    mount();
    const q = await byId("vendor-qual-mistral-eu");
    expect(q.textContent).toContain("S5 Build: qualified");
    expect(q.textContent).toMatch(/Verify: not qualified/);
    type(await byId("vendor-qual-station-mistral-eu"), "verify");
    fireEvent.click(await byId("vendor-qual-go-mistral-eu"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "POST", path: "/api/v1/vendors/mistral-eu/qualify", body: { station: "verify" } });
    expect(writes(calls)[0]!.headers["if-match"]).toBe("5");
    expect(document.getElementById("vendor-qual-anthropic")).toBeNull();
  });
});

describe("routing policy", () => {
  beforeEach(() => { window.location.hash = "#models/routing"; });
  it("changes the default model with If-Match from the loaded version", async () => {
    const calls = setup({ "PUT /api/v1/routing": () => ok({ version: 5 }) });
    mount();
    type(await byId("rt-default"), "claude-sonnet-5-5");
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const w = writes(calls)[0]!;
    expect(w).toMatchObject({ method: "PUT", path: "/api/v1/routing", body: { routing: { defaultModel: "claude-sonnet-5-5", overrides: { intake: "claude-haiku-5-5" }, fallback: ROUTING.fallback }, label: "Default model → claude-sonnet-5-5" } });
    expect(w.body.routing.version).toBeUndefined();
    expect(w.headers["if-match"]).toBe("4");
  });

  it("sets a station override and a class override, and clears one", async () => {
    const calls = setup({ "PUT /api/v1/routing": () => ok({ version: 5 }) });
    mount();
    type(await byId("rt-st-build"), "claude-sonnet-5-5");
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body.routing.overrides).toEqual({ intake: "claude-haiku-5-5", build: "claude-sonnet-5-5" });
    type(await byId("rt-cl-hotfix"), "claude-opus-5-5");
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]!.body.routing.classOverrides).toEqual({ hotfix: "claude-opus-5-5" });
    type(await byId("rt-st-intake"), "");
    await waitFor(() => expect(writes(calls)).toHaveLength(3));
    expect(writes(calls)[2]!.body.routing.overrides).toEqual({});
  });

  it("reorders and edits the fallback order; the last fallback cannot be removed; unavailable ones are marked", async () => {
    const calls = setup({ "PUT /api/v1/routing": () => ok({ version: 5 }) });
    mount();
    expect((await byId("rt-fb-up-0")).getAttribute("data-reason")).toBe("Already first.");
    expect((await byId("rt-fb-down-1")).getAttribute("data-reason")).toBe("Already last.");
    fireEvent.click(await byId("rt-fb-down-0"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body.routing.fallback).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    type(await byId("rt-fb-add"), "bedrock-claude-sonnet-5-5");
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]!.body.routing.fallback).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "bedrock-claude-sonnet-5-5"]);
    fireEvent.click(await byId("rt-fb-rm-1"));
    await waitFor(() => expect(writes(calls)).toHaveLength(3));
    expect(writes(calls)[2]!.body.routing.fallback).toEqual(["claude-opus-5-5"]);
  });

  it("the cross-model switch is off by default and saves the factory switch", async () => {
    const calls = setup({ "PUT /api/v1/routing": () => ok({ version: 5 }) });
    mount();
    const sw = (await byId("rt-cross")) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body.routing.crossModelFallback).toBe(true);
  });

  it("adds and removes a residency rule; refuses a duplicate tag and the same vendor twice before calling", async () => {
    const calls = setup({ "PUT /api/v1/routing": () => ok({ version: 5 }) });
    mount();
    fireEvent.click(await byId("rr-del-RR-1"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body.routing.rules).toEqual([]);
    // The duplicate check uses the loaded rules (RR-1 is regulated).
    fireEvent.submit(await byId("rr-form"));
    await new Promise((r) => setTimeout(r, 30));
    expect(writes(calls)).toHaveLength(1);
    type(await byId("rr-tag"), "pci");
    type(await byId("rr-use"), "bedrock");
    type(await byId("rr-alt"), "bedrock");
    fireEvent.submit(await byId("rr-form"));
    await new Promise((r) => setTimeout(r, 30));
    expect(writes(calls)).toHaveLength(1);
    type(await byId("rr-alt"), "local");
    type(await byId("rr-region"), "eu-central-1");
    type(await byId("rr-note"), "Card data stays in the EU");
    fireEvent.submit(await byId("rr-form"));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]!.body.routing.rules.at(-1)).toEqual({ id: "RR-2", tag: "pci", use: "bedrock", region: "eu-central-1", alt: "local", note: "Card data stays in the EU" });
  });

  it("saves a per-project policy: allowed vendors, regions, retention and the cross-model opt-in (locked until the factory switch is on)", async () => {
    const calls = setup({ "PUT /api/v1/routing": () => ok({ version: 5 }) });
    mount();
    type(await byId("rt-proj"), "risk");
    fireEvent.click(await byId("rt-proj-v-bedrock"));
    type(await byId("rt-proj-regions"), "eu-central-1, on-prem");
    fireEvent.click(await byId("rt-proj-r-zero"));
    expect((await byId("rt-proj-cross")).getAttribute("data-reason")).toMatch(/switched off for the factory/);
    fireEvent.click(await byId("rt-proj-save"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body.routing.projects).toEqual({ risk: { allowedVendors: ["bedrock"], allowedRegions: ["eu-central-1", "on-prem"], allowedRetention: ["zero"] } });
  });

  it("previews the route from the API's resolver and follows the repo and station", async () => {
    const calls = setup();
    mount();
    await waitFor(() => expect(document.querySelector(".md-result")?.textContent).toContain("bedrock-claude-sonnet-5-5"));
    expect(calls.filter((c) => c.path === "/api/v1/routing/resolve").at(-1)!.query.get("repo")).toBe("risk-engine");
    expect(document.querySelector(".md-steps")?.textContent).toContain("RR-1");
    type(await byId("rt-prev-repo"), "payments-api");
    await waitFor(() => expect(document.querySelector(".md-result")?.textContent).toContain("claude-opus-5-5"));
    type(await byId("rt-prev-station"), "review");
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/v1/routing/resolve").at(-1)!.query.get("station")).toBe("review"));
  });

  it("shows a blocked route", async () => {
    setup({ "GET /api/v1/routing/resolve": () => ({ body: { model: null, vendor: null, wanted: "claude-opus-5-5", layer: "default", steps: ["RR-1: no allowed vendor serves claude-opus-5-5."], blocked: "x", crossModel: false, sameModelFallback: false, rule: null } }) });
    mount();
    await waitFor(() => expect(document.querySelector(".md-result.is-block")?.textContent).toContain("Blocked: no allowed model"));
  });
});

describe("vendors summary", () => {
  beforeEach(() => { window.location.hash = "#models/vendors"; });
  it("counts every listed model (as the prototype's 4/6) and shows a dash where a vendor is not connected", async () => {
    setup({});
    mount();
    const tile = await waitFor(() => { const e = [...document.querySelectorAll("#md-stats .stat")].find((x) => x.textContent?.includes("Enabled")); if (!e) throw new Error("no tile"); return e; });
    const connectedModels = VENDORS.reduce((n, v) => n + v.models.length, 0);
    await waitFor(() => expect(tile.textContent).toContain(`/${connectedModels}`));
    const off = (await byId("vendor-local")).querySelector(".tb-vendor dd")!;
    expect(off.textContent).toBe("–");
  });
});

describe("routing versions", () => {
  beforeEach(() => { window.location.hash = "#models/routing"; });
  it("lists the published versions with who and why", async () => {
    setup({ "GET /api/v1/routing/versions": () => ({ body: [{ version: 4, publishedAt: new Date().toISOString(), publishedBy: "asha", note: "Default model changed" }, { version: 3, publishedAt: new Date().toISOString(), publishedBy: "system", note: "" }] }) });
    mount();
    const t = await byId("rv-table");
    await waitFor(() => expect(t.textContent).toContain("Default model changed"));
    expect(t.querySelector("tbody tr")?.textContent).toContain("v4");
  });
});

describe("prices and budgets", () => {
  beforeEach(() => { window.location.hash = "#models/prices"; });
  it("lists price versions with their effective dates and publishes a price from a date, with an idempotency key", async () => {
    const calls = setup({ "POST /api/v1/prices": () => ok({ msg: "Price version 3 is in force.", version: 3 }) });
    mount();
    const t = await byId("pv-table");
    await waitFor(() => expect(t.textContent).toContain("Price cut"));
    expect(t.querySelector("tbody tr")?.textContent).toContain("in force");
    type(await byId("pv-in-claude-sonnet-5-5"), "");
    fireEvent.submit(await byId("pv-form"));
    await new Promise((r) => setTimeout(r, 30));
    expect(writes(calls)).toHaveLength(0);
    type(await byId("pv-in-claude-sonnet-5-5"), "3.5");
    type(await byId("pv-out-claude-sonnet-5-5"), "16");
    type(await byId("pv-note"), "Rate card");
    fireEvent.submit(await byId("pv-form"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "POST", path: "/api/v1/prices", body: { prices: { "claude-sonnet-5-5": { in: 3.5, out: 16 } }, note: "Rate card" } });
    expect(writes(calls)[0]!.body.effectiveFrom).toBeUndefined();
    expect(writes(calls)[0]!.headers["idempotency-key"]).toBeTruthy();
  });

  it("publishes several changed models as one version and leaves the unchanged ones out", async () => {
    const calls = setup({ "POST /api/v1/prices": () => ok({ msg: "Price version 3 is in force.", version: 3 }) });
    mount();
    await byId("pv-edit");
    const ids = [...document.querySelectorAll<HTMLInputElement>("#pv-edit input[id^='pv-in-']")].map((i) => i.id.replace("pv-in-", ""));
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids.slice(0, 2)) { type(await byId(`pv-in-${id}`), "7"); type(await byId(`pv-out-${id}`), "9"); }
    fireEvent.submit(await byId("pv-form"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(Object.keys(writes(calls)[0]!.body.prices).sort()).toEqual(ids.slice(0, 2).sort());
  });

  it("shows each vendor's spend against its budget, read-only", async () => {
    setup({});
    mount();
    const t = await byId("vb-table");
    expect(t.querySelectorAll("tbody tr").length).toBeGreaterThan(0);
    expect(t.querySelector("input")).toBeNull();
  });

  it("schedules a price for a future date", async () => {
    const calls = setup({ "POST /api/v1/prices": () => ok({ msg: "scheduled", version: 3 }) });
    mount();
    type(await byId("pv-in-claude-sonnet-5-5"), "4");
    type(await byId("pv-out-claude-sonnet-5-5"), "20");
    const later = new Date(Date.now() + 5 * 86400000);
    later.setMinutes(later.getMinutes() - later.getTimezoneOffset());
    type(await byId("pv-eff"), later.toISOString().slice(0, 16));
    fireEvent.submit(await byId("pv-form"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(Date.parse(writes(calls)[0]!.body.effectiveFrom)).toBeGreaterThan(Date.now() + 4 * 86400000);
  });

  it("sets the per-work-order cap of a project", async () => {
    const calls = setup({ "PUT /api/v1/budgets/payments": () => ok({ msg: "Each work order in Payments Platform may spend up to $15." }) });
    mount();
    const input = await byId("bd-wo-payments");
    type(input, "15");
    fireEvent.click(await byId("bd-save-payments"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "PUT", path: "/api/v1/budgets/payments", body: { perWorkOrder: 15 } });
    expect((await byId("bd-wo-risk") as HTMLInputElement).value).toBe("20");
  });
});

describe("permissions", () => {
  it("without model.edit every control shows why it is locked and nothing is sent", async () => {
    const calls = setup({}, ["model.edit", "project.config"]);
    mount();
    const locked = async (ids: string[]) => {
      for (const id of ids) {
        const el = await byId(id);
        await waitFor(() => expect(el.getAttribute("data-reason")).toMatch(/Needs Factory Admin\. No role holds/));
        fireEvent.click(el);
      }
    };
    await locked(["md-add-vendor", "vendor-connect-anthropic", "vendor-addmodel-anthropic", "vendor-disc-anthropic", "vendor-qual-go-mistral-eu"]);
    expect((await byId("mt-claude-haiku-5-5")).getAttribute("data-reason")).toMatch(/No role holds model.edit/);
    window.location.hash = "#models/routing";
    await locked(["rr-del-RR-1", "rr-add", "rt-proj-save"]);
    expect((await byId("rt-default") as HTMLSelectElement).disabled).toBe(true);
    expect((await byId("rt-st-build") as HTMLSelectElement).disabled).toBe(true);
    expect((await byId("rt-fb-rm-0")).getAttribute("data-reason")).toMatch(/No role holds model.edit/);
    window.location.hash = "#models/prices";
    await locked(["pv-add", "bd-save-payments"]);
    window.location.hash = "#models/routing";
    await waitFor(() => expect(document.body.textContent).toContain("Read-only for you: routing."));
    expect(writes(calls)).toHaveLength(0);
  });
});

describe("vendor templates and model discovery", () => {
  it("picks Bedrock, shows only its fields, connects, then lists the discovered models with switches", async () => {
    const calls = setup({
      "POST /api/v1/vendors/from-template": () => ok({ msg: "AWS Bedrock connected.", vendor: { id: "aws-bedrock", name: "AWS Bedrock", template: "bedrock" }, discovery: { found: 2, models: [{ id: "bedrock-sonnet", name: "Claude Sonnet 4.5", enabled: false, priced: true }, { id: "bedrock-x", name: "Mystery", enabled: false, priced: false }], warnings: ["Inference profiles were not listed: denied"] } }),
      "PATCH /api/v1/models/bedrock-sonnet": () => ok({ msg: "on" }),
    });
    mount();
    fireEvent.click(await byId("md-add-vendor"));
    for (const id of ["anthropic", "bedrock", "openai", "azure-openai", "gemini", "vertex", "openai-compatible"]) await byId(`vt-pick-${id}`);
    fireEvent.click(await byId("vt-pick-bedrock"));
    await byId("vt-f-region");
    expect(document.getElementById("vt-f-apiKey")).toBeNull();
    fireEvent.click(await byId("vt-submit"));
    await waitFor(() => expect(document.querySelector(".form-err")?.textContent).toBe("Access key id is required."));
    expect(writes(calls)).toHaveLength(0);
    type(await byId("vt-f-region"), "eu-west-1");
    type(await byId("vt-f-accessKeyId"), "AKIAABCDEFGHIJKLMNOP");
    type(await byId("vt-f-secretAccessKey"), "s".repeat(40));
    fireEvent.click(await byId("vt-submit"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "POST", path: "/api/v1/vendors/from-template", body: { template: "bedrock", fields: { region: "eu-west-1", accessKeyId: "AKIAABCDEFGHIJKLMNOP" }, retention: "standard" } });
    expect(writes(calls)[0]!.headers["idempotency-key"]).toBeTruthy();
    await byId("vt-found");
    expect(document.body.textContent).toContain("Inference profiles were not listed");
    expect(document.body.textContent).toContain("Claude Sonnet 4.5");
    expect(document.body.textContent).toContain("needs a price");
    expect((await byId("vt-m-bedrock-x")).getAttribute("data-reason")).toBeTruthy();
  });

  it("shows the server's reason when the credentials are refused and keeps the form", async () => {
    setup({ "POST /api/v1/vendors/from-template": () => ({ status: 422, body: { ok: false, msg: "Anthropic rejected the credentials (HTTP 401). Check the key and its permissions." } }) });
    mount();
    fireEvent.click(await byId("md-add-vendor"));
    fireEvent.click(await byId("vt-pick-anthropic"));
    type(await byId("vt-f-apiKey"), "sk-ant-" + "x".repeat(20));
    fireEvent.click(await byId("vt-submit"));
    await waitFor(() => expect(document.querySelector(".form-err")?.textContent).toMatch(/rejected the credentials/));
    expect(document.getElementById("vt-f-apiKey")).not.toBeNull();
  });

  it("Refresh models on a vendor posts discover and toasts the result", async () => {
    const calls = setup({ "POST /api/v1/vendors/anthropic/discover": () => ok({ msg: "Anthropic: found 3 models, 1 new." }) });
    mount();
    fireEvent.click(await byId("vendor-refresh-anthropic"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "POST", path: "/api/v1/vendors/anthropic/discover" });
  });
});

describe("Models screen: a read the person may not make", () => {
  it("says Not visible to you, not an empty list, when the primary read is refused", async () => {
    setup({ "GET /api/v1/vendors": () => ({ status: 403, body: { ok: false, msg: "Your roles do not include model.view." } }) });
    mount();
    await waitFor(() => expect(document.getElementById("models-hidden")?.textContent).toContain("Not visible to you"));
    expect(document.getElementById("models-hidden")?.textContent).toContain("model.view");
  });
});

describe("models catalog in the prototype layout", () => {
  beforeEach(() => { window.location.hash = "#models"; });
  it("has the four tiles, Discover models and the prototype's columns", async () => {
    setup();
    mount();
    await byId("mc-table");
    expect([...document.querySelectorAll("#md-stats .label")].map((x) => x.textContent)).toEqual(["Enabled", "Needs a price", "Spend, 30 days", "Fallbacks fired"]);
    expect([...document.querySelectorAll("#mc-table thead th")].map((h) => h.textContent!.replace(/[\u2191\u2193\u2195]/g, "").trim())).toEqual(["Model", "Tier", "Context", "In / out per Mtok", "Used at", "Enabled"]);
    expect(document.getElementById("md-discover")).toBeTruthy();
  });
  it("offers Set price for a model without one, rejects a price of zero and publishes a positive one", async () => {
    const vendors = VENDORS.map((v) => v.id === "anthropic" ? { ...v, models: v.models.map((m) => m.id === "claude-haiku-5-5" ? { ...m, needsPrice: true, enabled: false } : m) } : v);
    const calls = setup({ "GET /api/v1/vendors": () => ({ body: vendors }), "POST /api/v1/prices": () => ok({ msg: "Price published." }) });
    mount();
    fireEvent.click(await byId("mc-price-claude-haiku-5-5"));
    fireEvent.change(await byId("sp-in"), { target: { value: "0" } });
    fireEvent.change(await byId("sp-out"), { target: { value: "4" } });
    fireEvent.click(await byId("sp-save"));
    await waitFor(() => expect(document.body.textContent).toContain("Prices must be above zero."));
    expect(writes(calls)).toHaveLength(0);
    fireEvent.change(await byId("sp-in"), { target: { value: "0.8" } });
    fireEvent.click(await byId("sp-save"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "POST", path: "/api/v1/prices", body: { prices: { "claude-haiku-5-5": { in: 0.8, out: 4 } } } });
  });
});

describe("models screen has no tab strip (prototype)", () => {
  it("the catalog has no tab strip but keeps Vendors, Routing, Prices and Add vendor one click away; Spend by model replaces Spend by vendor", async () => {
    setup();
    window.location.hash = "#models";
    mount();
    await byId("mc-table");
    expect(document.getElementById("md-tab-models")).toBeNull();
    expect(document.getElementById("mc-vendors")).toBeNull();
    fireEvent.click(await byId("md-add-vendor"));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    cleanup();
    for (const [btn, sub] of [["md-go-vendors", "vendors"], ["md-go-routing", "routing"], ["md-go-prices", "prices"]] as const) {
      window.location.hash = "#models";
      mount();
      fireEvent.click(await byId(btn));
      expect(window.location.hash).toBe(`#models/${sub}`);
      cleanup();
    }
    window.location.hash = "#models";
    mount();
    await byId("mc-table");
    expect(document.body.textContent).toContain("Spend by model");
    expect(document.body.textContent).not.toContain("Spend by vendor");
    cleanup();
    window.location.hash = "#models/vendors";
    mount();
    await byId("md-add-vendor");
  });
});
