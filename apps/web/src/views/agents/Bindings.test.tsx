import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../../api/can";
import { bindQueryClient } from "../../api/keys";
import { setCsrfToken } from "../../api/client";
import { OverlayProvider } from "../../ui/Overlay";
import { BindingsPanel } from "./Bindings";

const surfaces = (agent: string | null) => [
  { surface: "intake", label: "Intake interview", source: "station", agent: "intake-clerk", agentName: "Intake Clerk", configurable: false, note: "The agent of the Intake station." },
  { surface: "work_order", label: "Work-order session", source: "station", agent: null, agentName: null, configurable: false, note: "The agent of the current station." },
  { surface: "onboarding", label: "Onboarding session", source: "fixed", agent: "onboarding-agent", agentName: "Onboarding Agent", configurable: false, note: "The Onboarding Agent." },
  { surface: "console", label: "Console", source: agent ? "binding" : "none", agent, agentName: agent ? "Factory Manager" : null, configurable: true, note: agent ? "Bound." : "No agent is bound." },
];

function setup(allowed = true) {
  const puts: Array<{ path: string; body: unknown }> = [];
  let bound: string | null = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x");
    const method = init?.method ?? "GET";
    if (u.pathname === "/api/v1/can") {
      const checks = (JSON.parse(String(init!.body)) as { checks: unknown[] }).checks;
      return new Response(JSON.stringify({ results: checks.map(() => ({ allowed, reason: allowed ? "" : "You need agent.edit.", needs: "", rule: { id: "x" } })) }), { status: 200 });
    }
    if (method === "GET" && u.pathname === "/api/v1/agents/bindings") return new Response(JSON.stringify({ surfaces: surfaces(bound) }), { status: 200 });
    if (method === "GET" && u.pathname === "/api/v1/agents") return new Response(JSON.stringify([{ id: "factory-manager", name: "Factory Manager", status: "active" }, { id: "old", name: "Retired", status: "retired" }]), { status: 200 });
    if (method === "PUT" && u.pathname === "/api/v1/agents/bindings/console") {
      const body = JSON.parse(String(init!.body)) as { agent: string | null };
      puts.push({ path: u.pathname, body });
      bound = body.agent;
      return new Response(JSON.stringify({ ok: true, msg: "Saved." }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, msg: `no mock ${method} ${u.pathname}` }), { status: 404 });
  }));
  return puts;
}
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider><BindingsPanel /></OverlayProvider></QueryClientProvider>);
}
const consoleSelect = () => waitFor(() => {
  const e = document.getElementById("ag-bind-console") as HTMLSelectElement | null;
  if (!e || e.options.length < 2) throw new Error("not ready");
  return e;
});

beforeEach(() => { setCsrfToken("c"); canBatcher.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Where agents talk", () => {
  it("lists the four conversational surfaces and offers only active agents for the console", async () => {
    setup();
    const view = mount();
    await view.findByText("Intake interview");
    for (const label of ["Work-order session", "Onboarding session", "Console"]) expect(view.getByText(label)).toBeTruthy();
    expect(view.getByText("Intake Clerk")).toBeTruthy();
    const sel = await consoleSelect();
    expect([...sel.options].map((o) => o.text)).toEqual(["No agent (Gantry's fixed rules only)", "Factory Manager"]);
  });

  it("binds and unbinds the console with PUT", async () => {
    const puts = setup();
    mount();
    const sel = await consoleSelect();
    fireEvent.change(sel, { target: { value: "factory-manager" } });
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toEqual({ agent: "factory-manager" });
    await waitFor(() => expect((document.getElementById("ag-bind-console") as HTMLSelectElement).value).toBe("factory-manager"));
    fireEvent.change(document.getElementById("ag-bind-console")!, { target: { value: "" } });
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]!.body).toEqual({ agent: null });
  });

  it("disables the console binding without the right to edit agents", async () => {
    setup(false);
    mount();
    const sel = await consoleSelect();
    await waitFor(() => expect(sel.disabled).toBe(true));
  });
});
