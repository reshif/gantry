/**
 * One Playwright harness for the web app. It needs no live stack: the built app is served by `vite preview` and every
 * /api and /auth request is fulfilled here from fixtures (or aborted). A persona is a `Me` plus a permission rule; a test
 * overrides single endpoints to rehearse failure paths.
 */
import { test as base, expect, type Page, type Route } from "@playwright/test";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { ROUTES, canSeeRoute, type RouteDef } from "../src/lib/routes";
import type { Me } from "../src/api/types";

export { expect };

export interface Persona {
  id: "admin" | "reader";
  me: Me;
  /** Whether POST /api/v1/can answers yes for this action. */
  allows: (action: string) => boolean;
}

const project = (id: string, name: string) => ({ id, name, key: id.slice(0, 3).toUpperCase(), status: "active", halted: null, killed: null });

function makeMe(id: string, name: string, roles: Array<{ role: string; scope: string }>): Me {
  return {
    person: { id, name, title: "Test persona", email: `${id}@example.test`, teams: ["platform"], roles, status: "active", oncall: false, github: id, away: null },
    session: { id: `s-${id}`, person: id, method: "sso", device: "e2e", ip: "127.0.0.1", started: 0, lastSeen: 0, revoked: false },
    csrf: "csrf-e2e",
    projects: [project("payments", "Payments Platform"), project("risk", "Risk Engine")],
    factory: { killed: null },
    config: { demoAccounts: false },
  } as unknown as Me;
}

export const PERSONAS: Record<Persona["id"], Persona> = {
  admin: { id: "admin", me: makeMe("p-admin", "Asha Raman", [{ role: "factory_admin", scope: "factory" }]), allows: () => true },
  // Read-only: sees what an auditor sees and is refused every action that is not a view.
  reader: { id: "reader", me: makeMe("p-reader", "Rae Reader", [{ role: "auditor", scope: "factory" }]), allows: (a) => a.endsWith(".view") },
};

export type Handler = (route: Route) => Promise<void> | void;
export interface MockOptions {
  persona?: Persona | null;
  /** Path (after /api/v1/, no query) or "METHOD path" -> handler. Wins over the defaults. */
  overrides?: Record<string, Handler>;
  /**
   * Computed answers for parameterised paths (`projects/p1/floor`). Return undefined to fall through to the defaults.
   * The fidelity compare tool (fidelity/compare.mjs) feeds the whole demo seed through this.
   */
  resolve?: (method: string, path: string, url: URL) => unknown;
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
export const fulfillJson = json;

/** Endpoints whose reply is an object, not a list. */
const approverRule = { roles: ["tech_lead"], people: [], required: 1, sod: true, conditions: [], escalateH: 24, fallback: null };
const OBJECTS: Record<string, unknown> = {
  home: { approvals: [], conversations: [], figures: {}, attention: [], badges: {}, factory: { killed: null } },
  // the real station, gate and class catalogue, so the factory visuals and the project wizard render for real
  catalog: DEFAULT_CATALOG,
  "project-presets": {
    approvers: { standard: { spec: approverRule }, light: { spec: approverRule }, strict: { spec: { ...approverRule, required: 2 } } },
    routes: { standard: [], light: [], strict: [] },
  },
};

/** Lists the app reads on its main routes. A list not named here answers empty: that is the empty state, rehearsed on purpose. */
const person = (id: string, name: string, title: string, role: string) => ({ id, name, title, email: `${id}@example.test`, teams: ["platform"], roles: [{ role, scope: "factory" }], status: "active", oncall: false, github: id, away: null });
const LISTS: Record<string, unknown[]> = {
  people: [person("p-admin", "Asha Raman", "Engineering Director", "factory_admin"), person("p-reader", "Rae Reader", "Auditor", "auditor"), person("p-lead", "Lee Okafor", "Tech Lead", "tech_lead")],
  teams: [{ id: "platform", name: "Platform", desc: "Shared services and the factory line", members: 3 }],
  templates: [
    { id: "standard", name: "Standard service", desc: "Every station, one approver per human gate.", stationsOff: [], gatesOff: [], slots: 3, classesSkip: {}, mcp: [], approverPreset: "standard", notify: "standard", builtIn: true },
    { id: "lean", name: "Lean library", desc: "Fewer stations for small changes.", stationsOff: ["secure"], gatesOff: [], slots: 2, classesSkip: {}, mcp: [], approverPreset: "light", notify: "light", builtIn: true },
  ],
};

/** Fulfil the whole API from fixtures. Returns the list of requests the app made (for assertions). */
export async function mockApi(page: Page, o: MockOptions = {}): Promise<string[]> {
  const persona = o.persona === undefined ? PERSONAS.admin : o.persona;
  const seen: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    // Nothing leaves the machine: fonts and any other third party are refused.
    if (!local) return route.abort();
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/auth/")) return route.continue();
    const method = route.request().method();
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    seen.push(`${method} ${path}`);
    const h = o.overrides?.[`${method} ${path}`] ?? o.overrides?.[path];
    if (h) return h(route);
    const computed = o.resolve?.(method, path, url);
    if (computed !== undefined) {
      const failed = computed as { __status?: number; body?: unknown } | null;
      if (failed && typeof failed === "object" && typeof failed.__status === "number") return json(route, failed.body ?? { ok: false, msg: "Not found" }, failed.__status);
      return json(route, computed);
    }
    if (path === "me") return persona ? json(route, persona.me) : json(route, { ok: false, msg: "Not signed in", config: { demoAccounts: false } }, 401);
    if (path === "can") {
      const checks = (route.request().postDataJSON() as { checks: Array<{ action: string }> }).checks;
      return json(route, { results: checks.map((c) => ({ allowed: !!persona?.allows(c.action), reason: persona?.allows(c.action) ? "" : "Your role cannot do this.", needs: "" })) });
    }
    if (path === "stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "retry: 600000\n\n" });
    if (url.pathname.startsWith("/auth/")) return route.fulfill({ status: 200, contentType: "text/html", body: "<title>login</title>" });
    if (method === "GET" && path in OBJECTS) return json(route, OBJECTS[path]);
    if (method === "GET" && path in LISTS) return json(route, LISTS[path]);
    return method === "GET" ? json(route, []) : json(route, { ok: true });
  });
  return seen;
}

/** Routes a persona can open, from the app's own route registry. */
export function routesFor(p: Persona): RouteDef[] {
  return ROUTES.filter((r) => canSeeRoute(r.id, p.me, { canAudit: p.allows("audit.view") }));
}

export const hashOf = (r: RouteDef): string => (r.project ? `/#/p/payments/${r.id}` : `/#${r.id}`);

/** Open a hash route and wait until the app has painted something stable. */
export async function open(page: Page, hash: string): Promise<void> {
  await page.goto(hash);
  await page.waitForSelector("#root > *");
  await page.waitForLoadState("networkidle");
  // let lazy views and the first queries settle
  await page.waitForTimeout(250);
}

export const test = base.extend<{ persona: Persona }>({
  persona: [PERSONAS.admin, { option: true }],
  page: async ({ page }, use) => {
    // a fixed clock keeps relative times and greetings identical between runs (screenshot baselines)
    await page.clock.install({ time: new Date("2026-01-15T10:00:00Z") });
    await use(page);
  },
});
