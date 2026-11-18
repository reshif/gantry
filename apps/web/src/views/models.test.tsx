import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("routing policy", () => {
  beforeEach(() => { window.location.hash = "#models?tab=routing"; });
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

  it("Routing carries the prototype's panels only: default and per-station, fallback chain (read-only), routing rules, then the kept routing versions", async () => {
    setup();
    mount();
    await byId("rt-default");
    expect(document.getElementById("rt-cross")).toBeNull();
    expect(document.getElementById("rt-proj")).toBeNull();
    expect(document.body.textContent).not.toContain("Where would this request go");
    expect(document.body.textContent).not.toContain("Per-project policy");
    const titles = [...document.querySelectorAll(".panel h2, .panel h3, .panel-head")].map((t) => t.textContent ?? "").join("|");
    for (const t of ["Default and per-station", "Fallback chain", "Routing rules", "Routing versions"]) expect(titles).toContain(t);
  });
});

describe("vendors summary", () => {
  beforeEach(() => { window.location.hash = "#models"; });
  it("counts models on only among connected vendors, and shows a dash where a vendor is not connected", async () => {
    setup({});
    mount();
    const tile = await waitFor(() => { const e = [...document.querySelectorAll("#md-stats .stat-tile")].find((x) => x.textContent?.includes("Models")); if (!e) throw new Error("no tile"); return e; });
    const allModels = VENDORS.reduce((n, v) => n + v.models.length, 0);
    await waitFor(() => expect(tile.textContent).toContain(`${allModels}`));
    const off = (await byId("vendor-local")).querySelector(".tb-vendor dd")!;
    expect(off.textContent).toBe("0 ms");
  });
});

describe("routing versions", () => {
  beforeEach(() => { window.location.hash = "#models?tab=routing"; });
  it("lists the published versions with who and why", async () => {
    setup({ "GET /api/v1/routing/versions": () => ({ body: [{ version: 4, publishedAt: new Date().toISOString(), publishedBy: "asha", note: "Default model changed" }, { version: 3, publishedAt: new Date().toISOString(), publishedBy: "system", note: "" }] }) });
    mount();
    const t = await byId("rv-table");
    await waitFor(() => expect(t.textContent).toContain("Default model changed"));
    expect(t.querySelector("tbody tr")?.textContent).toContain("v4");
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
