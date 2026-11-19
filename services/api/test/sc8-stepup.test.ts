import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STEP_UP_ACTIONS } from "@gantry/domain";
import { TEST_URL, startApp, SESSION_KEY, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { runEgressHosts, systemEgressHosts } from "../src/areas/internal/egress.js";

const d = TEST_URL ? describe : describe.skip;
const STALE = { authAgeSec: 36000 };
const FRESH = { authAgeSec: 0 };
const KEY = "sk-" + "A1b2C3d4".repeat(4);

d("S-66 and S-67: redirecting data or credentials needs a fresh sign-in; a vendor never widens a run's egress", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp({ config: { secrets: { sessionKey: SESSION_KEY, dataKey: randomBytes(32), edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } }); });
  afterAll(() => t.close());
  const w = world(() => t);
  let n = 0;
  const idem = () => ({ "idempotency-key": `s-${Date.now()}-${n++}-xxxx` });
  const vendorBody = { name: "Evil LLM", endpoint: "https://llm.attacker.example/v1", key: KEY, region: "eu", retention: "zero" };
  const hookBody = { type: "webhook", name: "Lake", config: { url: "https://hook.attacker.example/in", format: "json" }, secrets: { secret: "whsec_" + "k7Kq2mZp9Rt4".repeat(3) }, targetId: "lake", enable: true };

  it("the list names every action that can redirect data or credentials", () => {
    for (const a of ["model.edit", "integration.add", "integration.edit", "mcp.edit"]) expect(STEP_UP_ACTIONS).toContain(a);
  });

  it("a stale session is refused with needs step_up on each of them, and nothing is written", async () => {
    const before = (await w.q(`select count(*)::int as c from vendors`))[0].c;
    const calls: Array<[string, string, string, unknown, Record<string, string>?]> = [
      ["add vendor", "POST", "/api/v1/vendors", vendorBody, idem()],
      ["edit vendor", "PATCH", "/api/v1/vendors/local", { patch: { endpoint: "https://other.attacker.example/v1" } }],
      ["add webhook", "POST", "/api/v1/integrations", hookBody],
      ["mcp server", "POST", "/api/v1/mcp/servers", { name: "Docs", transport: "http", url: "https://mcp.attacker.example/mcp", authMode: "none", sensitivity: "internal", tools: [], projects: "all", repos: "all", agents: "all", stations: "all", classes: "all" }, idem()],
      ["api config", "PATCH", "/api/v1/api-config", { rateLimit: 5000 }],
    ];
    for (const [what, m, u, b, h] of calls) {
      const r = await w.call("p-asha", m as "POST", u, b, h ?? {}, STALE);
      expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(r.body.needs, what).toBe("step_up");
    }
    expect((await w.q(`select count(*)::int as c from vendors`))[0].c).toBe(before);
  });

  it("a fresh sign-in lets the same vendor and webhook through (S-67: and the run list does not gain the vendor host)", async () => {
    const ctx = { orgId: t.orgId, station: "build", projectConfig: {} } as never;
    const runBefore = await runEgressHosts(t.db.app, ctx);
    const v = await w.call("p-asha", "POST", "/api/v1/vendors", vendorBody, idem(), FRESH);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const i = await w.call("p-asha", "POST", "/api/v1/integrations", hookBody, {}, FRESH);
    expect(i.status, JSON.stringify(i.body)).toBe(200);
    const runAfter = await runEgressHosts(t.db.app, ctx);
    expect(runAfter.filter((h) => !runBefore.includes(h))).toEqual([]);
    expect(runAfter).not.toContain("llm.attacker.example");
    const sys = await systemEgressHosts(t.db.app, t.orgId);
    expect(sys).toContain("hook.attacker.example");
  });

  it("S-67: a vendor or integration that adds a host to the worker's list is audited and listed with where it came from", async () => {
    const ev = await w.events("egress.host.added");
    const hosts = ev.map((e: { after: { host: string } }) => e.after.host);
    expect(hosts).toContain("hook.attacker.example");
    const r = await w.call("p-asha", "GET", "/api/v1/security/egress-hosts");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = r.body.hosts as Array<{ host: string; source: string; list: string }>;
    expect(rows.find((x) => x.host === "hook.attacker.example")).toMatchObject({ list: "worker", source: expect.stringContaining("Lake") });
    expect(rows.filter((x) => x.host === "llm.attacker.example").map((x) => x.list)).toEqual(["worker"]);
    expect(rows.find((x) => x.host === "llm.attacker.example")?.source).toContain("Evil LLM");
  });
});
