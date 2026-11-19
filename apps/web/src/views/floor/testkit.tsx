/** Test helpers for the floor, work-order and stop-dialog tests: the dev seed as API responses and a mocked fetch. Not shipped: only tests import it. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { DEFAULT_CATALOG, devSeed, type Project, type WorkOrder } from "@gantry/domain";
import { canBatcher } from "../../api/can";
import { setCsrfToken } from "../../api/client";
import { bindQueryClient } from "../../api/keys";
import { OverlayProvider } from "../../ui/Overlay";

export const NOW = Date.now();
const SEED = devSeed(NOW).state;
export const PAYMENTS = SEED.projects.find((p) => p.id === "payments") as Project;
export const WOS = SEED.workOrders.filter((w) => w.project === "payments") as WorkOrder[];
export const REPOS = SEED.repos.filter((r) => r.project === "payments");
export const AGENTS = SEED.agents;
export const ASHA = SEED.people.find((p) => p.id === "p-asha");

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}
export type Handler = (c: Call) => { status?: number; body: unknown } | undefined;

export const me = (over: Record<string, unknown> = {}) => ({
  person: ASHA,
  session: { id: "s1", person: "p-asha", method: "sso", started: 1, lastSeen: 1, revoked: false },
  csrf: "c",
  org: { id: "acme", name: "Acme", plant: "P", tz: "IST" },
  projects: [PAYMENTS],
  factory: { killed: null },
  config: {},
  ...over,
});

export const floorRead = (over: Record<string, unknown> = {}) => ({
  project: PAYMENTS,
  workOrders: WOS,
  flowVersion: 1,
  slots: { used: 2, total: 2, holders: [{ slot: 1, wo: "WO-2401" }, { slot: 2, wo: "WO-2402" }] },
  gates: [],
  queue: ["WO-2403"],
  stop: null,
  stops: [],
  at: null,
  ...over,
});

/** Installs a mocked fetch. Handlers are matched on "METHOD /path" first, so tests override only what they care about. `denied` are actions can() refuses. */
export function mockApi(extra: Record<string, Handler> = {}, o: { denied?: string[]; me?: Record<string, unknown>; override?: string[] } = {}) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: me(o.me) }),
    "GET /api/v1/catalog": () => ({ body: DEFAULT_CATALOG }),
    "GET /api/v1/people": () => ({ body: SEED.people }),
    "GET /api/v1/agents": () => ({ body: AGENTS }),
    "GET /api/v1/skills": () => ({ body: SEED.skills }),
    "GET /api/v1/mcp/servers": () => ({ body: [] }),
    "GET /api/v1/projects": () => ({ body: [PAYMENTS] }),
    "GET /api/v1/projects/payments": () => ({ body: { ...PAYMENTS, version: 1 } }),
    "GET /api/v1/projects/payments/repos": () => ({ body: REPOS }),
    "GET /api/v1/projects/payments/floor": () => ({ body: floorRead() }),
    "GET /api/v1/projects/payments/events": () => ({ body: [] }),
    "GET /api/v1/home": () => ({ body: { approvals: [], conversations: [], badges: {} } }),
    ...extra,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url, "http://x");
      const method = init?.method ?? "GET";
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      let body: Record<string, unknown> | null = null;
      try {
        body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      const call: Call = { method, path: u.pathname, query: u.searchParams, body, headers };
      calls.push(call);
      if (u.pathname === "/api/v1/can") {
        const checks = (body as { checks: Array<{ action: string }> }).checks;
        return new Response(JSON.stringify({ results: checks.map((c) => (o.override?.includes(c.action) ? { allowed: true, reason: "", needs: "", override: true, overrideReason: "required" } : o.denied?.includes(c.action) ? { allowed: false, reason: "No role holds it.", needs: "Factory Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "", needs: "" })) }));
      }
      const h = extra[`${method} ${u.pathname}`] ?? base[`${method} ${u.pathname}`];
      const r = h?.(call) ?? { status: 404, body: { ok: false, msg: `no mock ${method} ${u.pathname}` } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

export function mount(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(
    <QueryClientProvider client={qc}>
      <OverlayProvider>{node}</OverlayProvider>
    </QueryClientProvider>,
  );
}

export function resetApp(): void {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
}
