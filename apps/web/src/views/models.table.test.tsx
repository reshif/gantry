import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG, VENDOR_TEMPLATES } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import ModelsView from "./models";

const m = (id: string, name: string, vendor: string, o: object = {}) => ({ id, name, enabled: true, context: 200000, inPrice: 3, outPrice: 15, vendor, ...o });
const VENDORS = [
  { id: "anthropic", name: "Anthropic", product: "Anthropic", connected: true, health: "healthy", latency: 820, mtd: 34.83, budget: 0, region: "us", endpoint: "", residency: "Processed in the US.", models: [m("opus", "Claude Opus", "anthropic", { tier: "flagship" }), m("haiku", "Claude Haiku", "anthropic", { tier: "fast", enabled: false })] },
  { id: "openai", name: "OpenAI", product: "OpenAI API", connected: true, health: "healthy", latency: 400, mtd: 10, budget: 100, region: "us", endpoint: "", residency: "US.", template: "openai", models: [m("gpt-x", "GPT X", "openai", { tier: "flagship" }), m("gpt-new", "GPT New", "openai", { inPrice: 0, outPrice: 0, needsPrice: true, enabled: false })] },
  { id: "local", name: "Local models", product: "vLLM endpoint", connected: true, health: "healthy", latency: 0, mtd: 0, budget: 0, region: "on-prem", endpoint: "http://gpu:8000/v1", residency: "Stays on the network.", custom: true, models: [m("coder", "coder-34b", "local", { inPrice: 0, outPrice: 0 })] },
];
const ROUTING = { defaultModel: "opus", overrides: { intake: "haiku" }, fallback: ["opus"], rules: [], version: 1 };
const AGENTS = [{ id: "ag-build", name: "Build agent", station: "build", model: "gpt-x", fallbacks: [], initials: "B" }];
const ME = { person: { id: "p", name: "A", roles: [{ role: "factory_admin", scope: "factory" }] }, session: { id: "s" }, csrf: "c", org: { id: "o", name: "O", plant: "P", tz: "IST" }, projects: [], factory: { killed: null }, config: {} };

interface Call { method: string; path: string; body: any }
function setup(): Call[] {
  const calls: Call[] = [];
  const routes: Record<string, unknown> = {
    "/api/v1/me": ME, "/api/v1/vendors": VENDORS, "/api/v1/routing": ROUTING, "/api/v1/projects": [], "/api/v1/agents": AGENTS, "/api/v1/catalog": DEFAULT_CATALOG,
    "/api/v1/prices": { current: null, versions: [] }, "/api/v1/budgets": [], "/api/v1/routing/versions": [], "/api/v1/people": [], "/api/v1/vendor-templates": VENDOR_TEMPLATES,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x");
    const method = init?.method ?? "GET";
    if (u.pathname === "/api/v1/can") {
      const checks = (JSON.parse(String(init?.body)) as { checks: unknown[] }).checks;
      return new Response(JSON.stringify({ results: checks.map(() => ({ allowed: true, reason: "", needs: "" })) }));
    }
    if (method !== "GET") { calls.push({ method, path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined }); return new Response(JSON.stringify({ ok: true, msg: "Done." })); }
    return new Response(JSON.stringify(routes[u.pathname] ?? []), { status: 200 });
  }));
  return calls;
}
function mount(hash = "#models") {
  window.location.hash = hash;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider><ModelsView /></OverlayProvider></QueryClientProvider>);
}
const byId = (id: string) => waitFor(() => { const e = document.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; });

beforeEach(() => { setCsrfToken("c"); canBatcher.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

describe("Models: vendor summary cards", () => {
  it("shows the name once and 'No budget set' instead of a $0 budget and an empty bar", async () => {
    setup();
    mount();
    const card = await byId("vendor-anthropic");
    expect(card.textContent!.match(/Anthropic/g)).toHaveLength(1);
    expect(card.textContent).toContain("$34.83");
    expect(card.textContent).toContain("No budget set");
    expect(card.textContent).not.toContain("/ $0");
    expect(card.querySelector("[role=meter]")).toBeNull();
    expect(card.textContent).toContain("1 of 2 enabled");
    expect(card.textContent).toContain("Last check");
    const withBudget = await byId("vendor-openai");
    expect(withBudget.textContent).toContain("$10 of $100");
    expect(withBudget.querySelector("[role=meter]")).not.toBeNull();
    expect(withBudget.textContent).toContain("OpenAI API");
  });

  it("clicking a vendor card filters the table through the URL; clicking again clears it", async () => {
    setup();
    mount();
    fireEvent.click(await byId("vendor-pick-openai"));
    await waitFor(() => expect(window.location.hash).toContain("vendor=openai"));
    await waitFor(() => expect(document.getElementById("md-table-anthropic")).toBeNull());
    expect(document.getElementById("md-table-openai")).not.toBeNull();
    expect(document.getElementById("vendor-pick-openai")!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(document.getElementById("vendor-pick-openai")!);
    await waitFor(() => expect(window.location.hash).not.toContain("vendor="));
    await byId("md-table-anthropic");
  });

  it("the Add vendor card opens the template picker", async () => {
    setup();
    mount();
    fireEvent.click(await byId("md-add-vendor-card"));
    await byId(`vt-pick-${VENDOR_TEMPLATES[0]!.id}`);
  });
});

describe("Models: one table across vendors", () => {
  it("groups by vendor, with a collapsible group per vendor and the used-by column", async () => {
    setup();
    mount();
    await byId("md-table-anthropic");
    for (const id of ["anthropic", "openai", "local"]) expect(document.getElementById(`md-group-${id}`)).not.toBeNull();
    const opus = document.getElementById("md-table-anthropic")!.textContent!;
    expect(opus).toContain("Factory default");
    expect(opus).toContain("Fallback chain");
    expect(document.getElementById("md-table-openai")!.textContent).toContain("Build agent");
    fireEvent.click(document.getElementById("md-group-anthropic")!);
    await waitFor(() => expect(document.getElementById("md-table-anthropic")).toBeNull());
    expect(window.location.hash).toContain("closed=anthropic");
  });

  it("an unpriced model says 'Needs a price' with Set price, never $0; an on-prem model has no per-token cost", async () => {
    setup();
    mount();
    const t = await byId("md-table-openai");
    const row = within(t).getByText("GPT New").closest("tr")!;
    expect(row.textContent).toContain("Needs a price");
    expect(row.textContent).not.toContain("$0");
    expect(within(row as HTMLElement).getByRole("button", { name: "Set price for GPT New" })).toBeTruthy();
    expect(document.getElementById("md-table-local")!.textContent).toContain("No per-token cost");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Set price for GPT New" }));
    await byId("pv-in-gpt-new");
  });

  it("search and filters live in the URL and narrow the table", async () => {
    setup();
    mount("#models?mq=haiku");
    await byId("md-table-anthropic");
    expect(document.getElementById("md-table-openai")).toBeNull();
    expect(document.getElementById("md-table-anthropic")!.textContent).toContain("Claude Haiku");
    expect(document.getElementById("md-table-anthropic")!.textContent).not.toContain("Claude Opus");
    cleanup();
    mount("#models?price=needs");
    await byId("md-table-openai");
    expect(document.getElementById("md-table-local")).toBeNull();
    expect(document.getElementById("md-table-anthropic")).toBeNull();
    cleanup();
    mount("#models?state=on&tier=flagship");
    await byId("md-table-anthropic");
    expect(document.getElementById("md-table-anthropic")!.textContent).not.toContain("Claude Haiku");
    fireEvent.change(document.getElementById("md-f-vendor")!, { target: { value: "openai" } });
    await waitFor(() => expect(window.location.hash).toContain("vendor=openai"));
  });

  it("No grouping gives one table with a vendor column; the choice is in the URL", async () => {
    setup();
    mount();
    await byId("md-table-anthropic");
    fireEvent.change(document.getElementById("md-f-group")!, { target: { value: "none" } });
    await waitFor(() => expect(window.location.hash).toContain("group=0"));
    const t = await byId("md-models-table");
    expect([...t.querySelectorAll("thead th")].map((x) => x.textContent!.replace(/[↕▲▼ ]/g, ""))).toContain("Vendor");
    expect(t.querySelectorAll("tbody tr")).toHaveLength(5);
  });

  it("the Enabled switch has an accessible name and sends the same command as before", async () => {
    const calls = setup();
    mount();
    const sw = await screen.findByRole("switch", { name: "Enabled: Claude Haiku" });
    expect(sw.getAttribute("id")).toBe("mt-haiku");
    fireEvent.click(sw);
    await waitFor(() => expect(calls.find((c) => c.method !== "GET")).toBeTruthy());
    const w = calls.find((c) => c.method !== "GET")!;
    expect(w.path).toMatch(/models\/haiku/);
    expect(JSON.stringify(w.body)).toContain("true");
  });
});
