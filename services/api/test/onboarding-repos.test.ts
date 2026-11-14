import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;

d("GET /api/v1/projects/{id}/repos", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp(); });
  afterAll(() => t.close());

  const get = async (who: string, url: string) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method: "GET", url, headers: s.headers });
    return { status: r.statusCode, body: r.json() as any };
  };

  it("lists the project's repos with their onboarding stage, so the Floor can find a Ready one", async () => {
    const r = await get("p-asha", "/api/v1/projects/payments/repos");
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body.every((x: any) => x.project === "payments")).toBe(true);
    expect(r.body.some((x: any) => x.onboarding?.stage === "ready")).toBe(true);
  });

  it("does not reveal the repos of a project the viewer cannot see", async () => {
    const r = await get("p-arjun", "/api/v1/projects/payments/repos"); // engineer on storefront and growth-experiments only
    expect(r.status).toBe(404);
  });

  it("refuses an unauthenticated caller", async () => {
    const r = await t.app.inject({ method: "GET", url: "/api/v1/projects/payments/repos" });
    expect(r.statusCode).toBe(401);
  });
});
