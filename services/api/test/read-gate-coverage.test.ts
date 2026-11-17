import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readGateFor } from "../src/core/read-gates.js";
import { signIn } from "../src/core/auth/signin.js";
import { registerRoutes } from "../src/routes/index.js";
import { world } from "./flow-helpers.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

/**
 * Route-driven coverage of the read gates. Every GET under /api/v1 must either match READ_GATES (default deny, enforced before the handler runs)
 * or be listed in SELF_AUTHORIZING below with the reason it is safe without a gate. Adding a GET route that is neither fails this test and
 * names the route. Each listed route is also called by a signed-in person who holds no role, and must refuse (401/403/404) or return only
 * that person's own data, so an entry that is really open fails too.
 */

type Probe = {
  /** Why the handler needs no gate: one line. */
  why: string;
  /** What a signed-in person with no roles must see. */
  expect: "refuse" | "own" | "empty" | "open-settings";
  /** `own`: checks the body holds nothing but the caller's data. */
  check?: (body: any, ctx: { me: string }) => void;
  /** Route parameters filled with real ids, so an open route would show real data instead of a 404 for an unknown id. */
  params?: Record<string, string>;
  /** Routes that cannot be called in-process (a long-lived stream): the reason it is not probed. */
  skip?: string;
  /** Query string appended to the probe URL (for routes that require one). */
  query?: string;
};

const REFUSED = [401, 403, 404];

const SELF_AUTHORIZING: Record<string, Probe> = {
  "/api/v1/me": { why: "own profile; projects filtered to the ones the person can see", expect: "own", check: (b, { me }) => { expect(b.person.id).toBe(me); expect(b.projects).toEqual([]); } },
  "/api/v1/sessions": { why: "own sessions; ?all=1 needs security.manage in the handler", expect: "own", check: (b, { me }) => { for (const s of b) expect(s.person).toBe(me); } },
  "/api/v1/signins": { why: "own sign-ins; ?all=1 needs security.manage in the handler", expect: "own", check: (b, { me }) => { for (const s of b.items) expect(s.person).toBe(me); } },
  "/api/v1/saved-views": { why: "own saved views, keyed by the signed-in person", expect: "empty" },
  "/api/v1/chat-links": { why: "own chat links, keyed by the signed-in person", expect: "empty" },
  "/api/v1/stream": { why: "live updates: every event is filtered by project visibility in the hub", expect: "refuse", skip: "long-lived SSE; visibility filtering is covered in stream.test.ts" },
  "/api/v1/projects": { why: "the project list is filtered to projects the person can see (visible())", expect: "empty" },
  "/api/v1/api-keys": { why: "keys filtered to visible projects (visibleToPerson)", expect: "empty" },
  "/api/v1/api-requests": { why: "API request log filtered to visible projects (visibleToPerson)", expect: "empty" },
  // Known gap: org-wide API limits are readable by any signed-in person (no secrets in it). Tighten to a role and move this to "refuse".
  "/api/v1/api-config": { why: "org-wide API settings; visibleToPerson only requires a person, holds no secrets", expect: "open-settings" },
  "/api/v1/security": { why: "decide() on security.manage in the handler", expect: "refuse" },
  "/api/v1/audit": { why: "decide() on audit.view, else filtered to own actions and visible projects", expect: "own", check: (b, { me }) => { for (const e of b.items) expect(JSON.stringify(e.actor ?? e)).toContain(me); } },
  "/api/v1/audit/:seq": { why: "same visibility filter as the list; an entry outside it is a 404", expect: "refuse", params: { seq: "1" } },
  "/api/v1/audit/verify": { why: "requireVerifier: Auditor or Factory Admin only", expect: "refuse" },
  "/api/v1/work-orders/:id": { why: "scopeOf() resolves the project, then project.view is decided", expect: "refuse", params: { id: "$wo" } },
  "/api/v1/work-orders/:id/changes": { why: "scopeOf() then project.view", expect: "refuse", params: { id: "$wo" } },
  "/api/v1/work-orders/:id/record": { why: "scopeOf() then project.view", expect: "refuse", params: { id: "$wo" } },
  "/api/v1/work-orders/:id/record.md": { why: "scopeOf() then project.view", expect: "refuse", params: { id: "$wo" } },
  "/api/v1/work-orders/:id/record/export": { why: "scopeOf() then project.view", expect: "refuse", params: { id: "$wo" } },
  "/api/v1/work-orders/:id/gates/:gate/approvers": { why: "scopeOf() then decide(project.view)", expect: "refuse", params: { id: "$wo", gate: "brief" } },
  "/api/v1/work-orders/:id/session": { why: "woOf(): visible project and decide(project.view)", expect: "refuse", params: { id: "$wo" } },
  "/api/v1/work-orders/:id/dialogue": { why: "scopeOf() then project.view", expect: "refuse", params: { id: "$wo" } },
  "/api/v1/work-orders/:id/documents": { why: "scopeOf() then project.view", expect: "refuse", params: { id: "$wo" } },
  "/api/v1/work-orders/:id/documents/:doc": { why: "scopeOf() then project.view", expect: "refuse", params: { id: "$wo", doc: "x" } },
  "/api/v1/work-orders/:id/sources": { why: "scopeOf() then project.view", expect: "refuse", params: { id: "$wo" } },
  "/api/v1/work-orders/:id/sources/:ref": { why: "scopeOf() then project.view", expect: "refuse", params: { id: "$wo", ref: "s1" } },
  "/api/v1/work-orders/:id/timeline": { why: "scopeOf() then project.view", expect: "refuse", params: { id: "$wo" } },
  "/api/v1/prompt-calls": { why: "each call is kept only when mayRead() allows it: project.view on the call's project, or the asker for console and project-less calls", expect: "own", query: "?wo=x", check: (b) => expect(b.calls).toEqual([]) },
  "/api/v1/prompt-traces/:ref": { why: "mayRead() on the call the trace belongs to; anything else is a 404 as if it did not exist", expect: "refuse", params: { ref: "0".repeat(64) } },
  "/api/v1/workspace/inbox": { why: "the inbox lists only conversations the person can read (visible projects, own threads)", expect: "empty" },
  "/api/v1/workspace/agents": { why: "agents offered for a thread; a work order outside the person's projects is a 404", expect: "empty" },
  "/api/v1/workspace/operator": { why: "stuck work is limited to projects where the person may act (decide wo.park); spend by person needs people.view", expect: "empty" },
  "/api/v1/workspace/search": { why: "search results are filtered to what the person can read; a query under two characters is refused", expect: "empty", query: "?q=payments" },
  "/api/v1/workspace/threads/:key/export": { why: "chatAccess / project visibility decide who may read; an unreadable thread is a 404", expect: "refuse", params: { key: "x" } },
  "/api/v1/work-order-sessions": { why: "list filtered to visible projects", expect: "empty" },
  "/api/v1/repos/:id/onboarding/pr": { why: "repoOf(): the repo's project must be visible", expect: "refuse", params: { id: "$repo" } },
  "/api/v1/repos/:id/onboarding/session": { why: "repoOf(): the repo's project must be visible", expect: "refuse", params: { id: "$repo" } },
};

/** Whether a route pattern is answered by a read gate, with every :param filled by a plain segment. */
const gated = (pattern: string): boolean => readGateFor(pattern.replace(/:[^/.]+/g, "x")) !== null;

const d = TEST_URL ? describe : describe.skip;

d("every GET under /api/v1 is gated or explicitly self-authorizing", () => {
  let t: TestApp;
  const routes = new Set<string>();
  beforeAll(async () => {
    t = await startApp({
      seedAudit: true,
      build: {
        routes: async (app) => {
          app.addHook("onRoute", (r) => {
            const methods = ([] as string[]).concat(r.method as string | string[]);
            if (methods.includes("GET") && r.url.startsWith("/api/v1/")) routes.add(r.url);
            if (methods.includes("GET") && r.url === "/api/v1") routes.add(r.url);
          });
          await registerRoutes(app);
        },
      },
    });
  });
  afterAll(() => t.close());

  it("scans a plausible number of routes (the hook is live)", () => {
    expect(routes.size).toBeGreaterThan(60);
  });

  it("no GET route is outside READ_GATES unless it is named in the allow-list", () => {
    const loose = [...routes].filter((r) => !gated(r) && !(r in SELF_AUTHORIZING)).sort();
    expect(loose, `GET routes with no read gate and no allow-list entry (add a gate in core/read-gates.ts, or list the route here with its reason): ${loose.join(", ")}`).toEqual([]);
  });

  it("the allow-list holds no stale entries: each route exists and is still not covered by a gate", () => {
    for (const r of Object.keys(SELF_AUTHORIZING)) {
      expect(routes.has(r), `${r} is listed but is not a registered GET route`).toBe(true);
      expect(gated(r), `${r} is now covered by READ_GATES; remove it from the allow-list`).toBe(false);
    }
  });

  it("every entry says why it is safe", () => {
    for (const [r, p] of Object.entries(SELF_AUTHORIZING)) expect(p.why.length, r).toBeGreaterThan(10);
  });

  it("a signed-in person with no roles is refused, or sees only their own data, on every allow-listed route", async () => {
    const r = await signIn(t.app.gantry, { sub: "kc-norole", email: "norole@acme.dev", emailVerified: true, name: "No Role" }, { ip: "203.0.113.9", userAgent: "vitest", requestId: "r", method: "sso" });
    if (!r.ok) throw new Error("sign-in");
    const me = r.personId;
    const s = await t.session(me);
    // A real work order (submitted by an engineer on payments), so an open route would return real data rather than a 404 for an unknown id.
    const sub = await world(() => t).submit("p-tomas");
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const ids: Record<string, string> = {
      $wo: String(sub.body.id ?? ""),
      $repo: (await t.db.admin.query<{ id: string }>(`select id from repos where org_id = $1 order by id limit 1`, [t.orgId])).rows[0]?.id ?? "",
    };
    expect(ids.$wo, "the seed has a work order to probe with").not.toBe("");
    expect(ids.$repo, "the seed has a repo to probe with").not.toBe("");

    for (const [pattern, probe] of Object.entries(SELF_AUTHORIZING)) {
      if (probe.skip) continue;
      const url = pattern.replace(/:([A-Za-z]+)/g, (_m, k: string) => ids[probe.params?.[k] ?? ""] ?? probe.params?.[k] ?? "x") + (probe.query ?? "");
      const res = await t.app.inject({ method: "GET", url, headers: s.headers });
      const label = `${pattern} -> ${url} (${res.statusCode})`;
      if (probe.expect === "refuse") {
        expect(REFUSED, label).toContain(res.statusCode);
        continue;
      }
      expect(res.statusCode, label).toBe(200);
      const body = res.json();
      if (probe.expect === "empty") expect(Array.isArray(body) ? body : body.items ?? body.projects ?? [], label).toEqual([]);
      if (probe.expect === "open-settings") expect(body, label).not.toHaveProperty("secret");
      probe.check?.(body, { me });
    }
  });
});
