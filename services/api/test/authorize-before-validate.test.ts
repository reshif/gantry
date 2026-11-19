import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signIn } from "../src/core/auth/signin.js";
import { gateActions, gateFor, WRITE_GATES, type WriteGate } from "../src/core/write-gate.js";
import { registerRoutes } from "../src/routes/index.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

/**
 * Authorisation comes before validation (QA review of the live app): a signed-in person who holds no role posting an empty body to any
 * write route must be refused 403, not told with a 422 which fields the route expects. The routes are read from the live route table, so a
 * new write route is covered without editing this file.
 */

/** Write routes a person with no role may legitimately use (their own saved views and chat links): a bad body is a 422 for them. */
const OWN_DATA = new Set<string>(["POST /api/v1/saved-views", "PATCH /api/v1/saved-views/:id", "DELETE /api/v1/saved-views/:id", "POST /api/v1/chat-links"]);

/** Routes whose right exists only for API keys (spec 8.10): no person holds it, so even a Factory Admin is refused; that is the gate answering correctly. */
const KEY_ONLY = new Set<string>(["POST /api/v1/triggers/:id/fire"]);

const d = TEST_URL ? describe : describe.skip;

d("a person with no role is refused before the body is read", () => {
  let t: TestApp;
  const routes: Array<{ method: string; url: string }> = [];
  /** Every write route of every prefix (hooks and /internal too), for the declaration checks. */
  const every: Array<{ method: string; url: string }> = [];
  beforeAll(async () => {
    t = await startApp({
      build: {
        routes: async (app) => {
          app.addHook("onRoute", (r) => {
            for (const m of ([] as string[]).concat(r.method as string | string[])) {
              if (!["POST", "PUT", "PATCH", "DELETE"].includes(m)) continue;
              every.push({ method: m, url: r.url });
              if (r.url.startsWith("/api/v1/")) routes.push({ method: m, url: r.url });
            }
          });
          await registerRoutes(app);
        },
      },
    });
  });
  afterAll(() => t.close());

  it("scans a plausible number of write routes (the hook is live)", () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it("an empty body is a 403 on every write route, never a 422 that lists the expected fields", async () => {
    const r = await signIn(t.app.gantry, { sub: "kc-norole-w", email: "norole-w@acme.dev", emailVerified: true, name: "No Role" }, { ip: "203.0.113.10", userAgent: "vitest", requestId: "r", method: "sso" });
    if (!r.ok) throw new Error("sign-in");
    const s = await t.session(r.personId);
    const leaks: string[] = [];
    for (const { method, url } of routes) {
      if (OWN_DATA.has(`${method} ${url}`)) continue;
      const path = url.replace(/:[A-Za-z]+/g, "x");
      const res = await t.app.inject({ method: method as "POST", url: path, headers: { ...s.headers, "content-type": "application/json" }, payload: "{}" });
      if (res.statusCode === 422) leaks.push(`${method} ${url} -> 422 ${String(res.json().msg ?? "").slice(0, 80)}`);
      else if (res.statusCode !== 403 && res.statusCode !== 404 && res.statusCode !== 401 && res.statusCode !== 410) leaks.push(`${method} ${url} -> ${res.statusCode}`);
    }
    expect(leaks, leaks.join("\n")).toEqual([]);
  });

  it("a caller who may write still gets the validation message for a bad body", async () => {
    const s = await t.session("p-asha");
    const res = await t.app.inject({ method: "POST", url: "/api/v1/projects", headers: { ...s.headers, "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(422);
    expect(res.json().msg).toMatch(/Invalid request/);
  });

  it("every write route declares how it is decided, and the table names no route that does not exist", () => {
    const missing = every.filter((r) => !gateFor(r.method, r.url)).map((r) => `${r.method} ${r.url}`);
    expect(missing, `Declare these in core/write-gate.ts:\n${missing.join("\n")}`).toEqual([]);
    const live = new Set(every.map((r) => `${r.method} ${r.url}`));
    const stale = Object.keys(WRITE_GATES).filter((k) => !live.has(k));
    expect(stale, `Stale write-gate entries:\n${stale.join("\n")}`).toEqual([]);
    expect(Object.keys(WRITE_GATES).length).toBeGreaterThan(150);
  });

  it("a person who holds a write right for a different route gets 403, not a 422 that lists the fields, on an empty body", async () => {
    // Two people, each holding exactly one write right: template.edit (project-free) and people.manage (factory). The matrix is replaced for the test.
    await t.db.admin.query(
      `insert into role_matrix_versions (org_id, version, matrix, published_at, published_by)
       select org_id, version + 1, matrix || jsonb_build_object('auditor', '{"template.edit": true}'::jsonb, 'engineer', '{"people.manage": true}'::jsonb), now(), 'test' from role_matrix_versions order by version desc limit 1`,
    );
    const who: Array<{ right: string; role: string; sub: string }> = [{ right: "template.edit", role: "auditor", sub: "a" }, { right: "people.manage", role: "engineer", sub: "b" }];
    const sessions: Record<string, Awaited<ReturnType<TestApp["session"]>>> = {};
    for (const w of who) {
      const r = await signIn(t.app.gantry, { sub: `kc-one-${w.sub}`, email: `one-${w.sub}@acme.dev`, emailVerified: true, name: `One ${w.sub}` }, { ip: "203.0.113.11", userAgent: "vitest", requestId: "r", method: "sso" });
      if (!r.ok) throw new Error("sign-in");
      await t.db.admin.query(`insert into role_assignments (org_id, id, person_id, role_id, scope_type, granted_by) values ($1,$2,$3,$4,'factory','test')`, [t.orgId, `ra-one-${w.sub}`, r.personId, w.role]);
      sessions[w.right] = await t.session(r.personId);
    }
    const st = { catalog: { gates: [] } } as never;
    const wrong: string[] = [];
    let checked = 0;
    for (const { method, url } of routes) {
      const gate: WriteGate | null = gateFor(method, url);
      if (!gate || !("any" in gate)) continue;
      const needs = gateActions(gate, st);
      const probe = who.find((w) => !needs.includes(w.right));
      if (!probe) throw new Error(`${method} ${url} needs both probe rights; add a probe`);
      const path = url.replace(/:[A-Za-z]+/g, "x");
      const res = await t.app.inject({ method: method as "POST", url: path, headers: { ...sessions[probe.right]!.headers, "content-type": "application/json" }, payload: "{}" });
      checked += 1;
      if (res.statusCode !== 403) wrong.push(`${method} ${url} (holds ${probe.right}) -> ${res.statusCode} ${String(res.json().msg ?? "").slice(0, 80)}`);
    }
    expect(checked).toBeGreaterThan(100);
    expect(wrong, wrong.join("\n")).toEqual([]);
  }, 120_000);

  it("the declared right still opens the route: a Factory Admin is never turned away by the gate", async () => {
    const s = await t.session("p-asha");
    const gated: string[] = [];
    for (const { method, url } of routes) {
      const gate = gateFor(method, url);
      if (!gate || !("any" in gate)) continue;
      if (KEY_ONLY.has(`${method} ${url}`)) continue;
      const res = await t.app.inject({ method: method as "POST", url: url.replace(/:[A-Za-z]+/g, "x"), headers: { ...s.headers, "content-type": "application/json" }, payload: "{}" });
      if (res.statusCode === 403 && res.json().rule?.kind === "matrix") gated.push(`${method} ${url}`);
    }
    expect(gated, gated.join("\n")).toEqual([]);
  }, 120_000);
});
