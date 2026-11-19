import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG, type ApproverRule } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken, setStepUpHandler, type StepUpOutcome } from "../api/client";
import { reloadPrefs, updatePrefs } from "../lib/prefs";
import { OverlayProvider } from "../ui/Overlay";
import { ops } from "../api/ops";
import ProjectConfigView from "./project-config";
import { flowFrom } from "./projects/templates-kit";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: unknown; headers: Record<string, string> }

const CAT = { ...DEFAULT_CATALOG };
const TEMPLATES = [
  { id: "tpl-backend", name: "Backend service", desc: "API or worker.", stationsOff: [], gatesOff: [], slots: 2, classesSkip: {}, mcp: [], approverPreset: "standard", notify: "standard", builtIn: true, version: 1 },
  { id: "tpl-mine", name: "My template", desc: "Mine", stationsOff: ["design"], gatesOff: [], slots: 1, classesSkip: {}, mcp: [], approverPreset: "light", notify: "light", builtIn: false, version: 4 },
];
const rule = (o: Partial<ApproverRule> = {}): ApproverRule => ({ roles: ["line_lead"], people: [], required: 1, sod: true, conditions: [], escalateH: 24, fallback: null, ...o });
const approvers = (): Record<string, ApproverRule> => Object.fromEntries(CAT.gates.map((g) => [g.id, rule()]));
const metrics = (o: object = {}) => ({ wip: 3, bays: 1, gates: 2, oldest: 3_600_000, late: 0, eff: 0.5, effN: 6, cov: { total: 20, auto: 5, share: 0.25 }, bad: 0, haltedRepos: 0, byPosition: { build: { n: 3, blocked: 0 } }, byClass: { feature: 2 }, byGate: { G5: 2 }, slotsUsed: 1, onboarding: 0, health: { id: "ok", label: "Healthy", icon: "st-done" }, ...o });
const project = (id: string, name: string, extra: object = {}) => ({
  id, name, key: id.slice(0, 3).toUpperCase(), status: "active", teams: ["payments"], owner: "p-asha", template: "tpl-backend", regulated: false, desc: `${name} desc`, flow: flowFrom(CAT, TEMPLATES[0] as never),
  approvers: approvers(), notifications: [], mcp: [], budget: { monthly: 1000, mtd: 250, alertAt: 0.8 }, created: Date.now() - 86_400_000, halted: null, killed: null, overlay: "", version: 7, metrics: metrics(), ...extra,
});
const PAYMENTS = project("payments", "Payments Platform");
const RISK = project("risk", "Risk and Compliance", { metrics: metrics({ health: { id: "attention", label: "Needs attention", icon: "alert", detail: "1 blocked or failing" }, bad: 1 }), regulated: true, template: "tpl-mine" });
const OLD = project("legacy-checkout", "Legacy Checkout", { status: "archived", metrics: metrics({ health: { id: "archived", label: "Archived", icon: "st-park" } }) });
const person = (id: string, name: string, roles: Array<{ role: string; scope: string }>, extra: object = {}) => ({ id, name, title: "Engineer", email: `${id}@acme.dev`, teams: ["payments"], roles, status: "active", oncall: false, github: "", away: null, version: 2, ...extra });
const PEOPLE = [person("p-asha", "Asha Raman", [{ role: "factory_admin", scope: "factory" }]), person("p-meera", "Meera Iyer", [{ role: "line_lead", scope: "payments" }]), person("p-tomas", "Tomas Eriksen", [{ role: "engineer", scope: "payments" }])];
const ME = { person: PEOPLE[0], session: { id: "s1", person: "p-asha", method: "sso", device: "Chrome", ip: "1", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: [PAYMENTS, RISK], factory: { killed: null }, config: {} };
const PRESETS = {
  approvers: { standard: { G5: rule({ roles: ["reviewer", "line_lead"], required: 1 }) }, light: { G5: rule({ roles: ["reviewer"] }) }, strict: { G5: rule({ roles: ["reviewer", "line_lead"], required: 2 }) } },
  routes: {
    standard: [{ id: "NR-1", event: "gate.waiting", dest: [{ channel: "slack", target: "#gates" }], template: "gate", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: {} }, { id: "NR-2", event: "kill", dest: [{ channel: "slack", target: "#inc" }], template: "kill", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: {} }],
    light: [{ id: "NR-1", event: "gate.waiting", dest: [{ channel: "slack", target: "#gates" }], template: "gate", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: {} }], strict: [],
  },
};

function setup(extra: Record<string, Handler> = {}, denied: string[] = [], stepUp: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: ME }),
    "GET /api/v1/projects": () => ({ body: [PAYMENTS, RISK, OLD] }),
    "GET /api/v1/templates": () => ({ body: TEMPLATES }),
    "GET /api/v1/saved-views": () => ({ body: [{ id: "v-1", name: "Mine", screen: "portfolio", project: null, s: { group: "team", sort: "name", dir: 1, health: "all", team: "all", tpl: "all", archived: false }, version: 3 }] }),
    "GET /api/v1/catalog": () => ({ body: CAT }),
    "GET /api/v1/teams": () => ({ body: [{ id: "payments", name: "Payments", desc: "" }, { id: "growth", name: "Growth", desc: "" }] }),
    "GET /api/v1/people": () => ({ body: PEOPLE }),
    "GET /api/v1/project-presets": () => ({ body: PRESETS }),
    "GET /api/v1/projects/payments/repos": () => ({ body: [] }),
    "GET /api/v1/stops/impact": () => ({ body: { workOrders: 3, running: 1, slots: 1, prs: 0 } }),
    ...extra,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0]!;
      const method = init?.method ?? "GET";
      const hdr: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (hdr[k] = v));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body, headers: hdr });
      if (path === "/api/v1/can") {
        const checks = (body as { checks: Array<{ action: string }> }).checks;
        return new Response(JSON.stringify({ results: checks.map((c) => (stepUp.includes(c.action) ? { allowed: false, reason: "Fresh sign-in required", needs: "step_up", rule: { id: "STEP-UP" } } : denied.includes(c.action) ? { allowed: false, reason: `No role holds ${c.action}.`, needs: "Needs Project Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "", needs: "" })) }));
      }
      const h = base[`${method} ${path}`];
      const r = h ? h(url, init) : { status: 404, body: { ok: false, msg: `no mock ${method} ${path}` } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

const byId = (id: string) => waitFor(() => { const e = document.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; });
function mount(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider>{node}</OverlayProvider></QueryClientProvider>);
}
const ok = (extra: object = {}) => ({ body: { ok: true, msg: "Done.", ...extra } });

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
  window.history.replaceState(null, "", "/");
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  reloadPrefs();
  updatePrefs({ project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});


describe("round 5 web (S-43, S-49)", () => {
  async function budgetTab(budget: object) {
    const proj = { ...PAYMENTS, budget: { ...PAYMENTS.budget, ...budget } };
    setup({ "GET /api/v1/projects": () => ({ body: [proj, RISK] }) });
    window.history.replaceState(null, "", "/?tab=budget");
    mount(<ProjectConfigView />);
    return (await byId("pcf-bud-monthly")) as HTMLInputElement;
  }
  const stat = () => Array.from(document.querySelectorAll(".stat")).map((e) => e.textContent).join(" | ");

  it("S-43: a monthly budget of 0 reads as No cap, with the field empty (owner decision: 0 means no cap)", async () => {
    const input = await budgetTab({ monthly: 0, capped: true });
    expect(stat()).toMatch(/No cap/);
    expect(stat()).not.toMatch(/\$0 cap|nothing metered/);
    expect(input.value).toBe("");
  });

  it("S-43: no cap reads as No cap, with the field empty (not 0)", async () => {
    const input = await budgetTab({ monthly: 0, capped: false });
    expect(stat()).toMatch(/No cap/);
    expect(stat()).not.toMatch(/of \$0/);
    expect(input.value).toBe("");
  });

  it("S-43: emptying the field saves no cap (null); typing 0 also saves no cap (null), never 0", async () => {
    const calls = setup({ "GET /api/v1/projects": () => ({ body: [PAYMENTS, RISK] }), "PATCH /api/v1/projects/payments/config": () => ok({ version: 8 }) });
    window.history.replaceState(null, "", "/?tab=budget");
    mount(<ProjectConfigView />);
    const input = (await byId("pcf-bud-monthly")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(await byId("pcf-bud-save"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({ path: "budget.monthly", value: null }));
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(await byId("pcf-bud-save"));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PATCH").every((c) => (c.body as { value: unknown }).value === null)).toBe(true);
  });

  it("S-49: a card refused for an expired sign-in comes back pending; the sign-in prompt is offered once, the same confirm repeats and the card ends done", async () => {
    const prompt = vi.fn(async (): Promise<StepUpOutcome> => ({ ok: true }));
    setStepUpHandler(prompt);
    const answers = [
      { status: 403, body: { ok: false, recorded: false, status: "pending", httpStatus: 403, msg: "Sign in again to confirm this change.", needs: "step_up", rule: { id: "STEP-UP" }, retry: true } },
      { status: 200, body: { ok: true, recorded: true, status: "done", httpStatus: 200, msg: "Done.", result: {} } },
    ];
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => { sent.push(String(init?.body)); const a = answers[Math.min(sent.length - 1, 1)]!; return new Response(JSON.stringify(a.body), { status: a.status }); }));
    const out = await ops.confirmProposal("MSG-1", "PROP-1", { reason: "duplicate refunds seen" });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(out.outcome, "after signing in the card runs").toBe("done");
  });

  it("S-49: cancelling the sign-in leaves the card pending and retryable, not failed", async () => {
    setStepUpHandler(vi.fn(async (): Promise<StepUpOutcome> => ({ ok: false })));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, recorded: false, status: "pending", httpStatus: 403, msg: "Sign in again to confirm this change.", needs: "step_up", retry: true }), { status: 403 })));
    const out = await ops.confirmProposal("MSG-1", "PROP-1", { reason: "duplicate refunds seen" });
    expect(out).toMatchObject({ outcome: "pending", retry: true });
  });
});
