import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signIn } from "../src/core/auth/signin.js";
import { registerRoutes } from "../src/routes/index.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

/**
 * Authorisation comes before validation (QA review of the live app): a signed-in person who holds no role posting an empty body to any
 * write route must be refused 403, not told with a 422 which fields the route expects. The routes are read from the live route table, so a
 * new write route is covered without editing this file.
 */

/** Write routes a person with no role may legitimately use (their own saved views and chat links): a bad body is a 422 for them. */
const OWN_DATA = new Set<string>(["POST /api/v1/saved-views", "PATCH /api/v1/saved-views/:id", "DELETE /api/v1/saved-views/:id", "POST /api/v1/chat-links"]);

const d = TEST_URL ? describe : describe.skip;

d("a person with no role is refused before the body is read", () => {
  let t: TestApp;
  const routes: Array<{ method: string; url: string }> = [];
  beforeAll(async () => {
    t = await startApp({
      build: {
        routes: async (app) => {
          app.addHook("onRoute", (r) => {
            for (const m of ([] as string[]).concat(r.method as string | string[])) {
              if (["POST", "PUT", "PATCH", "DELETE"].includes(m) && r.url.startsWith("/api/v1/")) routes.push({ method: m, url: r.url });
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
});
