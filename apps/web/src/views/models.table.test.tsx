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

describe("Models > Vendors: only the vendor cards", () => {
  it("shows the name once and 'No budget set' instead of a $0 budget and an empty bar", async () => {
    setup();
    mount();
    const card = await byId("vendor-anthropic");
    expect(card.textContent!.match(/Anthropic/g)).toHaveLength(2); // the title and the screen-reader link text
    expect(card.textContent).toContain("$34.83");
    expect(card.textContent).toContain("No budget set");
    expect(card.textContent).not.toContain("/ $0");
    expect(card.querySelector("[role=meter]")).toBeNull();
    expect(card.textContent).toContain("1 of 2 enabled");
    expect(card.textContent).toContain("Last check");
    expect(card.textContent).toContain("Processed in the US.");
    const withBudget = await byId("vendor-openai");
    expect(withBudget.textContent).toContain("$10 / $100");
    expect(withBudget.querySelector("[role=meter]")).not.toBeNull();
    expect(withBudget.textContent).toContain("OpenAI API");
  });

  it("each card links to its vendor page; there is no models table and no vendor filter under the cards", async () => {
    setup();
    mount();
    await byId("vendor-openai");
    const link = screen.getByRole("link", { name: /Open OpenAI/ });
    expect(link.getAttribute("href")).toBe("#models/vendors/openai");
    expect(link.textContent).toContain("2 models");
    expect(document.querySelectorAll("table")).toHaveLength(0);
    expect(document.getElementById("md-models")).toBeNull();
    expect(document.getElementById("md-model-search")).toBeNull();
  });

  it("Add vendor is one header button plus the card, nowhere else", async () => {
    setup();
    mount();
    await byId("vendor-openai");
    expect(screen.getAllByRole("button", { name: /Add vendor/ })).toHaveLength(2);
    expect(document.getElementById("md-add-vendor")).not.toBeNull();
    fireEvent.click(document.getElementById("md-add-vendor-card")!);
    await byId(`vt-pick-${VENDOR_TEMPLATES[0]!.id}`);
  });
});

describe("Models: a vendor's page", () => {
  it("is a route with a breadcrumb back to Vendors, the vendor's facts and only that vendor's models", async () => {
    setup();
    mount("#models/vendors/openai");
    const t = await byId("vp-table");
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("Models/Vendors/OpenAI");
    expect(within(crumbs).getByRole("link", { name: "Vendors" }).getAttribute("href")).toBe("#models");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("OpenAI");
    expect(document.getElementById("vp-stats")!.textContent).toContain("$10");
    expect(document.getElementById("vp-stats")!.textContent).toContain("of $100 budget");
    expect(document.getElementById("vp-stats")!.textContent).toContain("US.");
    expect(t.textContent).toContain("GPT X");
    expect(t.textContent).toContain("GPT New");
    expect(t.textContent).not.toContain("Claude Opus");
    expect(t.textContent).not.toContain("coder-34b");
    expect(document.getElementById("md-stats")).toBeNull();
  });

  it("without a budget says so and links to Prices and budgets", async () => {
    setup();
    mount("#models/vendors/anthropic");
    await byId("vp-table");
    expect(document.getElementById("vp-stats")!.textContent).toContain("No budget set");
    expect(document.getElementById("vp-budget-link")!.getAttribute("href")).toBe("#models?tab=prices");
  });

  it("an unknown vendor says so and links back", async () => {
    setup();
    mount("#models/vendors/nope");
    expect((await byId("vp-back")).getAttribute("href")).toBe("#models");
    expect(document.body.textContent).toContain("There is no vendor called");
  });

  it("groups used-by and shows the used-by column", async () => {
    setup();
    mount("#models/vendors/anthropic");
    const opus = (await byId("vp-table")).textContent!;
    expect(opus).toContain("Factory default");
    expect(opus).toContain("Fallback chain");
    cleanup();
    mount("#models/vendors/openai");
    expect((await byId("vp-table")).textContent).toContain("Build agent");
  });

  it("an unpriced model says 'Needs a price' with Set price, never $0; an on-prem model says self-hosted", async () => {
    setup();
    mount("#models/vendors/openai");
    const t = await byId("vp-table");
    const row = within(t).getByText("GPT New").closest("tr")!;
    expect(row.textContent).toContain("Needs a price");
    expect(row.textContent).not.toContain("$0");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Set price for GPT New" }));
    await byId("pv-in-gpt-new");
    cleanup();
    mount("#models/vendors/local");
    expect((await byId("vp-table")).textContent).toContain("Self-hosted, no per-token price");
  });

  it("hides the Tier column when no model has a tier", async () => {
    setup();
    mount("#models/vendors/local");
    const t = await byId("vp-table");
    expect([...t.querySelectorAll("thead th")].map((x) => x.textContent!.replace(/[↕▲▼ ]/g, ""))).not.toContain("Tier");
    expect(document.getElementById("vp-f-tier")).toBeNull();
    cleanup();
    mount("#models/vendors/anthropic");
    const t2 = await byId("vp-table");
    expect([...t2.querySelectorAll("thead th")].map((x) => x.textContent!.replace(/[↕▲▼ ]/g, ""))).toContain("Tier");
    expect(document.getElementById("vp-f-tier")).not.toBeNull();
  });

  it("search and filters live in the URL and narrow this vendor's table", async () => {
    setup();
    mount("#models/vendors/anthropic?mq=haiku");
    const t = await byId("vp-table");
    expect(t.textContent).toContain("Claude Haiku");
    expect(t.textContent).not.toContain("Claude Opus");
    cleanup();
    mount("#models/vendors/openai?price=needs");
    const t2 = await byId("vp-table");
    expect(t2.textContent).toContain("GPT New");
    expect(t2.textContent).not.toContain("GPT X");
    cleanup();
    mount("#models/vendors/anthropic?state=on&tier=flagship");
    const t3 = await byId("vp-table");
    expect(t3.textContent).not.toContain("Claude Haiku");
    fireEvent.change(document.getElementById("vp-f-state")!, { target: { value: "off" } });
    await waitFor(() => expect(window.location.hash).toContain("state=off"));
    expect(window.location.hash.startsWith("#models/vendors/anthropic")).toBe(true);
    expect(window.location.search).toBe("");
  });

  it("the Enabled switch has an accessible name and sends the same command as before", async () => {
    const calls = setup();
    mount("#models/vendors/anthropic");
    const sw = await screen.findByRole("switch", { name: "Enabled: Claude Haiku" });
    expect(sw.getAttribute("id")).toBe("mt-haiku");
    fireEvent.click(sw);
    await waitFor(() => expect(calls.find((c) => c.method !== "GET")).toBeTruthy());
    const w = calls.find((c) => c.method !== "GET")!;
    expect(w.path).toMatch(/models\/haiku/);
    expect(JSON.stringify(w.body)).toContain("true");
  });

  it("Prices and budgets keeps the cross-vendor model list and Publish prices, and its vendor budgets link to the vendor pages", async () => {
    setup();
    mount("#models?tab=prices");
    await byId("md-prices");
    expect(document.getElementById("md-publish-prices")).not.toBeNull();
    expect(screen.getByRole("link", { name: "OpenAI" }).getAttribute("href")).toBe("#models/vendors/openai");
  });
});
