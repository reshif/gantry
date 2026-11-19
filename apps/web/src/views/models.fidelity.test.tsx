import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import ModelsView from "./models";

const m = (id: string, name: string, enabled: boolean, inPrice: number, outPrice: number) => ({ id, name, enabled, context: 500000, inPrice, outPrice });
const VENDORS = [
  { id: "anthropic", name: "Anthropic", connected: true, health: "healthy", latency: 820, mtd: 4182.4, budget: 9000, product: "Claude API", region: "us-east", residency: "US by default.", models: [m("claude-opus-5-5", "Claude Opus 5.5", true, 5, 25), m("claude-sonnet-5-5", "Claude Sonnet 5.5", true, 3, 15)] },
  { id: "local", name: "Local models", connected: false, health: "offline", latency: 0, mtd: 0, budget: 0, product: "vLLM endpoint", region: "on-prem", custom: true, models: [m("coder", "coder-34b", false, 0, 0)] },
];
const ROUTING = { defaultModel: "claude-opus-5-5", overrides: {}, fallback: ["claude-opus-5-5", "claude-sonnet-5-5"], rules: [{ id: "RR-1", tag: "regulated", use: "anthropic", region: "eu", alt: "", note: "Keep EU data in the EU." }], version: 1 };
const PROJECTS = [{ id: "payments", name: "Payments Platform", key: "PAY", status: "active", regulated: false, budget: { monthly: 5000, mtd: 4500, alertAt: 0.8 } }];
const ME = { person: { id: "p", name: "A", roles: [{ role: "factory_admin", scope: "factory" }] }, session: { id: "s" }, csrf: "c", org: { id: "o", name: "O", plant: "P", tz: "IST" }, projects: PROJECTS, factory: { killed: null }, config: {} };

function setup() {
  const routes: Record<string, unknown> = {
    "/api/v1/me": ME, "/api/v1/vendors": VENDORS, "/api/v1/routing": ROUTING, "/api/v1/projects": PROJECTS, "/api/v1/agents": [], "/api/v1/catalog": DEFAULT_CATALOG,
    "/api/v1/prices": { current: null, versions: [] }, "/api/v1/budgets": [], "/api/v1/routing/versions": [], "/api/v1/people": [],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x");
    if (u.pathname === "/api/v1/can") {
      const checks = (JSON.parse(String(init?.body)) as { checks: unknown[] }).checks;
      return new Response(JSON.stringify({ results: checks.map(() => ({ allowed: true, reason: "", needs: "" })) }));
    }
    return new Response(JSON.stringify(routes[u.pathname] ?? []), { status: 200 });
  }));
}
function mount(hash = "") {
  window.location.hash = hash;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider><ModelsView /></OverlayProvider></QueryClientProvider>);
}
const byId = (id: string) => waitFor(() => { const e = document.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; });

beforeEach(() => { setCsrfToken("c"); canBatcher.clear(); setup(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

describe("Models screen (Blueprint layout)", () => {
  it("shows the header scope, four tiles with cents and the prototype's default sub, and the three tabs", async () => {
    mount("#models");
    await waitFor(() => expect(document.getElementById("md-stats")?.textContent).toContain("$4,182.40"));
    const tiles = document.getElementById("md-stats")!.textContent!;
    expect(tiles).toContain("Models3");
    expect(tiles).toContain("unless overridden");
    expect(document.querySelector(".stat.info")!.textContent).toContain("Models");
    expect(document.querySelector(".ph .eyebrow")!.textContent).toMatch(/all lines/i);
    expect([...document.querySelectorAll("[role=tab]")].map((t) => t.textContent)).toEqual(["Vendors2", "Routing", "Prices and budgets"]);
    expect(document.querySelector(".md-incident")).toBeNull();
  });

  it("vendor cards: health chip (offline for a disconnected vendor), spend with cents, models enabled, last check, and a link to the vendor page whose table shows the context", async () => {
    mount("#models");
    const card = await byId("vendor-anthropic");
    expect(card.querySelector(".vendor-head .chip")!.textContent).toBe("healthy");
    expect([...card.querySelectorAll("dl.kv dt")].map((t) => t.textContent)).toEqual(["Spend this month", "Models", "Last check"]);
    expect(card.textContent).toContain("$4,182.40 / $9,000");
    expect(card.textContent).toContain("2 of 2 enabled");
    expect((await byId("vendor-local")).querySelector(".vendor-head .chip")!.textContent).toBe("offline");
    expect(document.getElementById("vp-table")).toBeNull();
    cleanup();
    mount("#models/vendors/anthropic");
    expect((await byId("vp-table")).textContent).toContain("500k");
  });

  it("keeps the tab in the URL: ?tab=routing opens Routing in the prototype's layout, a click writes ?tab=prices", async () => {
    mount("#models?tab=routing");
    await byId("rt-panel");
    expect(document.getElementById("md-tab-routing")!.getAttribute("aria-selected")).toBe("true");
    expect([...document.querySelectorAll("#rt-panel .panel-title")].slice(0, 3).map((t) => t.textContent)).toEqual(["Default and per-station", "Fallback chain", "Routing rules"]);
    expect(document.querySelector("#rt-panel dl.kv dt")!.textContent).toBe("Default model");
    expect(document.querySelectorAll("#rt-panel ol.mono li")).toHaveLength(2);
    expect([...document.querySelectorAll("#rr-table thead th")].map((t) => t.textContent)).toEqual(["Repo tag", "Use vendor", "Region", "Why"]);
    const st = document.querySelector("#rt-panel select[aria-label$=' model']:not(#rt-default)") as HTMLSelectElement;
    expect(st.options[0]!.textContent).toBe("Use default");
    fireEvent.click(document.getElementById("md-tab-prices")!);
    await waitFor(() => expect(window.location.hash).toBe("#models?tab=prices"));
    await byId("md-prices");
  });

  it("prices tab: Model prices (search, count, state chip, footer) then Project budgets linking to project config", async () => {
    mount("#models?tab=prices");
    await byId("md-prices");
    expect([...document.querySelectorAll("#md-prices thead th")].map((t) => t.textContent!.replace(/[↕↑↓ ]/g, ""))).toEqual(["Model", "Context", "$in/M", "$out/M", "State"]);
    expect(document.getElementById("md-price-search")!.getAttribute("aria-label")).toBe("Search models");
    expect(document.body.textContent).toContain("3 models");
    expect(document.querySelector("#md-prices .tfoot")!.textContent).toContain("1–3 of 3");
    const titles = [...document.querySelectorAll(".md-stack .panel-title")].map((t) => t.textContent);
    expect(titles.filter((t) => t === "Model prices" || t === "Project budgets, this month")).toEqual(["Model prices", "Project budgets, this month"]);
    const link = [...document.querySelectorAll(".md-stack a")].find((a) => a.textContent === "Payments Platform")!;
    expect(link.getAttribute("href")).toBe("#/p/payments/project-config");
    expect(document.body.textContent).toContain("$4,500 / $5,000");
    expect(document.querySelector(".md-stack .meter.warn")).not.toBeNull();
  });

  it("matches the prototype's header and vendor cards: Add vendor in the header, static 'all connected', no Manage rows, no dashed Local card, any model switch is usable", async () => {
    mount("#models");
    await byId("vendor-anthropic");
    expect(document.getElementById("md-add-vendor")).not.toBeNull();
    expect(document.getElementById("md-stats")!.textContent).toContain("1 connected");
    expect(document.body.textContent).not.toContain("not connected");
    expect(document.querySelector(".md-manage")).toBeNull();
    expect((await byId("vendor-local")).className).not.toContain("is-off");
    cleanup();
    mount("#models/vendors/anthropic");
    const sw = await byId("mt-claude-opus-5-5");
    expect(sw.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("routing tab: no Change the order, no Add rule or Remove, no per-class table; raw vendor ids in rules; Default model reachable by its label", async () => {
    mount("#models?tab=routing");
    await byId("rt-panel");
    expect(document.querySelector("#rt-panel details.md-manage")).toBeNull();
    expect(document.getElementById("rr-add-open")).toBeNull();
    expect(document.querySelector("[id^=rr-del-]")).toBeNull();
    expect(document.getElementById("rt-classes")).toBeNull();
    expect(document.getElementById("rr-table")!.textContent).toContain("anthropic");
    expect((document.querySelector("select[aria-label='Default model']") as HTMLSelectElement).id).toBe("rt-default");
  });

  it("prices tab: Model prices, Price versions, Vendor budgets and Project budgets (all projects, archived too); Publish prices; local models have blank prices", async () => {
    mount("#models?tab=prices");
    await byId("md-prices");
    expect([...document.querySelectorAll(".md-stack .panel-title")].map((t) => t.textContent)).toEqual(["Model prices", "Price versions", "Vendor budgets", "Project budgets, this month"]);
    expect(document.getElementById("md-publish-prices")).not.toBeNull();
    const local = [...document.querySelectorAll("#md-prices tbody tr")].find((r) => r.textContent!.includes("coder-34b"))!;
    expect([...local.querySelectorAll("td .num")].map((n) => n.textContent)).toEqual(["", ""]);
  });
});
