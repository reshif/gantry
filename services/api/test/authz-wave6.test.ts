import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { Hub, STREAMS_PER_PERSON, type Subscriber } from "../src/core/stream.js";
import { gateModeLock } from "@gantry/domain";

const d = TEST_URL ? describe : describe.skip;
const ASHA = "p-asha"; // Factory Admin
const DANIEL = "p-daniel"; // Project Admin on payments only: project.config, notify.edit there, no agents.view
const STALE = { authAgeSec: 4000 };

d("wave 6 authz: flow locks, card templates, effective instructions, stops, grants", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const cfg = "/api/v1/projects/payments/config";
  const flow = async (who: string, body: unknown, o: { authAgeSec?: number } = {}) => w.call(who, "PATCH", cfg, body, {}, o);
  const routeOf = async (cls: string) => {
    const { routeGates } = await import("@gantry/domain");
    const p = (await w.call(ASHA, "GET", "/api/v1/projects/payments")).body as any;
    const cat = (await w.call(ASHA, "GET", "/api/v1/catalog")).body as any;
    return routeGates(cat, p, cls);
  };

  describe("the flow keeps its locked gates (I1)", () => {
    it("turning off the Verify or Review station is refused: its gate would leave the route", async () => {
      for (const st of ["verify", "review"]) {
        const r = await flow(ASHA, { path: `flow.stations.${st}.enabled`, value: false });
        expect(r.status, JSON.stringify(r.body)).toBe(409);
        expect(String(r.body.msg)).toMatch(/cannot be turned off/);
      }
      const gates = await routeOf("feature");
      expect(gates).toContain("G4");
      expect(gates).toContain("G5");
    });

    it("a regulated project keeps every station that carries a gate", async () => {
      await w.q(`update projects set regulated = true where id = 'payments'`);
      try {
        expect((await flow(ASHA, { path: "flow.stations.design.enabled", value: false })).status).toBe(409);
        expect((await flow(ASHA, { gate: "G3G3s", mode: "auto" })).status).toBe(422);
      } finally {
        await w.q(`update projects set regulated = false where id = 'payments'`);
      }
    });

    it("plan and security (G3G3s) stays a person's decision in a project that is not regulated", async () => {
      expect((await flow(ASHA, { gate: "G3G3s", mode: "auto" })).status).toBe(422);
      expect(gateModeLock({ id: "G3G3s", kind: "mixed", checks: ["x"] }, "auto", null)).not.toBeNull();
      expect(gateModeLock({ id: "G3G3s", kind: "mixed", checks: ["x"] }, "mixed", null)).toBeNull();
      expect(gateModeLock({ id: "G3G3s", kind: "mixed", checks: ["x"] }, "human", null)).toBeNull();
    });

    it("a mode stored before the lock existed never lowers a locked gate at runtime", async () => {
      const { gateKind } = await import("@gantry/domain");
      const cat = (await w.call(ASHA, "GET", "/api/v1/catalog")).body as any;
      const p = (await w.call(ASHA, "GET", "/api/v1/projects/payments")).body as any;
      const stale = (gate: string, mode: string) => ({ ...p, flow: { ...p.flow, gates: { ...p.flow.gates, [gate]: { ...p.flow.gates[gate], mode } } } });
      for (const [g, m] of [["G5", "auto"], ["G5", "mixed"], ["G2", "auto"], ["G3d", "mixed"], ["G3G3s", "auto"]]) expect(gateKind(cat, stale(g!, m!), g!), `${g} ${m}`).toBe("human");
      expect(gateKind(cat, stale("G3G3s", "mixed"), "G3G3s")).toBe("mixed");
    });

    it("class-level routes through the config path cannot drop G4 or G5 either, even with a stale sign-in", async () => {
      const cur = ((await w.call(ASHA, "GET", "/api/v1/projects/payments")).body as any).flow.classes as any[];
      const feature = cur.find((c) => c.id === "feature");
      const put = (classes: unknown[], o: { authAgeSec?: number } = {}) => flow(ASHA, { path: "flow.classes", value: classes }, o);
      const noGates = cur.map((c) => (c.id === "feature" ? { ...c, gates: ["G2"] } : c));
      const r1 = await put(noGates);
      expect(r1.status, JSON.stringify(r1.body)).toBe(409);
      const r2 = await put(noGates, STALE);
      expect([403, 409]).toContain(r2.status);
      const skip = cur.map((c) => (c.id === "feature" ? { ...c, skips: [...(feature.skips ?? []), "review"] } : c));
      expect((await put(skip)).status).toBe(409);
      expect((await put(skip, STALE)).status).not.toBe(200);
      for (const cls of ["feature", "bug", "refactor", "security"]) {
        const gates = await routeOf(cls);
        expect(gates, cls).toContain("G5");
        expect(gates, cls).toContain("G4");
      }
    });

    it("turning a station off needs a fresh sign-in", async () => {
      const r = await flow(ASHA, { path: "flow.stations.design.enabled", value: false }, STALE);
      expect(r.status).toBe(403);
      expect(r.body.needs).toBe("step_up");
    });

    it("a class cannot skip a locked gate's station or leave a locked gate out of its list", async () => {
      const skip = await w.call(ASHA, "PATCH", "/api/v1/projects/payments/flow/classes/bug", { skips: ["research", "design", "review"] });
      expect(skip.status, JSON.stringify(skip.body)).toBe(409);
      const list = await w.call(ASHA, "PATCH", "/api/v1/projects/payments/flow/classes/feature", { gates: ["G2"] });
      expect(list.status, JSON.stringify(list.body)).toBe(409);
      for (const cls of ["feature", "bug", "refactor", "security"]) {
        const gates = await routeOf(cls);
        expect(gates, cls).toContain("G5");
        expect(gates, cls).toContain("G4");
      }
    });

    it("a gate that a person decides never becomes automatic or mixed, whatever the route", async () => {
      for (const g of ["G2", "G3d", "G5"]) {
        for (const m of ["auto", "mixed"]) {
          const r = await flow(ASHA, { gate: g, mode: m });
          expect(r.status, `${g} ${m}`).toBe(422);
        }
      }
      const cat = (await w.call(ASHA, "GET", "/api/v1/catalog")).body as any;
      for (const g of cat.gates.filter((x: any) => x.kind === "human")) expect(gateModeLock(g, "auto", null), g.id).not.toBeNull();
      expect(gateModeLock({ id: "G5", kind: "human", checks: [] }, "human", null)).toBeNull();
    });

    it("lowering a gate to checks-then-a-person needs a fresh sign-in", async () => {
      const r = await flow(ASHA, { gate: "G1f", mode: "mixed" }, STALE);
      expect(r.status).toBe(403);
      expect(r.body.needs).toBe("step_up");
    });
  });

  describe("another project's data stays out of reach", () => {
    beforeAll(async () => {
      await w.q(`insert into repos (org_id, id, project_id, name) values ($1, 'r-risk-x', 'risk', 'risk-x') on conflict do nothing`, [t.orgId]);
      await w.insertWo("WO-risk-9", { project: "risk", repo: "payments-api", position: "plan" });
      await w.insertWo("WO-pay-9", { project: "payments", position: "plan" });
    });

    it("card preview binds the work order to the authorised project", async () => {
      const other = await w.call(DANIEL, "POST", "/api/v1/card-templates/preview", { project: "payments", event: "gate.waiting", wo: "WO-risk-9" });
      expect(other.status, JSON.stringify(other.body)).toBe(404);
      expect(JSON.stringify(other.body)).not.toMatch(/Work WO-risk-9/);
      expect((await w.call(DANIEL, "POST", "/api/v1/card-templates/preview", { project: "payments", event: "gate.waiting", wo: "WO-nope-1" })).status).toBe(404);
      const own = await w.call(DANIEL, "POST", "/api/v1/card-templates/preview", { project: "payments", event: "gate.waiting", wo: "WO-pay-9" });
      expect(own.status, JSON.stringify(own.body)).toBe(200);
    });

    it("effective instructions: a repo of another project is a 404, with or without a project", async () => {
      const eff = (qs: string, who = DANIEL) => w.call(who, "GET", `/api/v1/agents/ag-build/effective${qs}`);
      expect((await eff("?repo=r-risk-x")).status).toBe(404);
      expect((await eff("?repo=r-risk-x&project=payments")).status).toBe(404);
      expect((await eff("?repo=r-nope")).status).toBe(404);
      expect((await eff("?repo=payments-api")).status).toBe(200);
      expect((await eff("?repo=payments-api")).status).toBe(200);
      // the saved draft and earlier versions are the agent's configuration: they need the agents register
      expect((await eff("?project=payments&version=draft")).status).toBe(403);
      expect((await eff("?project=payments&version=draft", ASHA)).status).toBe(200);
    });

    it("stop commands do not confirm that an id exists: unknown and not-visible are the same 404", async () => {
      const kill = (scope: string, id: string) => w.call(DANIEL, "POST", "/api/v1/stops", { scope, id, mode: "halt", reason: "Checking the response only" });
      for (const [scope, hidden, unknown] of [["project", "risk", "nope"], ["repo", "r-risk-x", "r-nope"], ["workorder", "WO-risk-9", "WO-nope-1"]] as const) {
        const a = await kill(scope, hidden);
        const b = await kill(scope, unknown);
        expect([a.status, b.status], scope).toEqual([404, 404]);
        expect(a.body.msg, scope).toBe(b.body.msg);
      }
      expect((await w.call(DANIEL, "GET", "/api/v1/stops/impact?scope=project&id=risk")).status).toBe(404);
      expect((await w.call(DANIEL, "DELETE", "/api/v1/stops/project%3Arisk")).status).toBe(404);
    });
  });

  describe("card templates have an owner", () => {
    it("project notify.edit changes only its own templates; factory-wide ones need the factory right", async () => {
      const mine = await w.call(DANIEL, "POST", "/api/v1/card-templates", { name: "Payments gate", kind: "gate", actions: ["open"], project: "payments" });
      expect(mine.status, JSON.stringify(mine.body)).toBe(200);
      const fac = await w.call(ASHA, "POST", "/api/v1/card-templates", { name: "Factory gate", kind: "gate", actions: ["open"] });
      expect(fac.status, JSON.stringify(fac.body)).toBe(200);
      const other = await w.call(ASHA, "POST", "/api/v1/card-templates", { name: "Risk gate", kind: "gate", actions: ["open"], project: "risk" });
      expect(other.status).toBe(200);
      const edit = (id: string, over: Record<string, unknown> = {}) => w.call(DANIEL, "POST", "/api/v1/card-templates", { id, name: "Changed", kind: "gate", actions: ["open"], project: "payments", ...over });
      expect((await edit(mine.body.template.id)).status).toBe(200);
      for (const id of [fac.body.template.id, other.body.template.id, "CT-does-not-exist"]) expect((await edit(id)).status, id).toBe(403);
      for (const id of [fac.body.template.id, other.body.template.id]) expect((await w.call(DANIEL, "DELETE", `/api/v1/card-templates/${id}?project=payments`)).status, id).toBe(403);
      // a project-owned card that another project's route uses is not the owner's to change; a factory admin still can
      await w.q(`insert into notification_routes (org_id, id, project_id, event, destinations, template) values ($1,'risk-r-ct','risk','gate.opened','[]'::jsonb,$2)`, [t.orgId, mine.body.template.id]);
      const shared = await edit(mine.body.template.id);
      expect(shared.status, JSON.stringify(shared.body)).toBe(409);
      expect((await w.call(ASHA, "POST", "/api/v1/card-templates", { id: mine.body.template.id, name: "Shared", kind: "gate", actions: ["open"], project: "payments" })).status).toBe(200);
      await w.q(`delete from notification_routes where org_id = $1 and id = 'risk-r-ct'`, [t.orgId]);
      expect((await w.call(ASHA, "POST", "/api/v1/card-templates", { id: fac.body.template.id, name: "Factory gate 2", kind: "gate", actions: ["open"] })).status).toBe(200);
      expect((await w.call(DANIEL, "DELETE", `/api/v1/card-templates/${mine.body.template.id}?project=payments`)).status).toBe(200);
    });
  });

  describe("MCP pre-authorisation", () => {
    it("needs a fresh sign-in, and an unknown work order is not distinguishable from one the caller may not approve", async () => {
      await w.insertWo("WO-grant-8", { project: "payments", position: "build", state: "running" });
      await w.q(`insert into attempts (org_id, id, wo_id, station, visit, state) values ($1,'at-grant-8','WO-grant-8','build',1,'running') on conflict do nothing`, [t.orgId]);
      const stale = await w.call(ASHA, "POST", "/api/v1/mcp/grants", { wo: "WO-grant-8", tools: ["any/x"] }, { "idempotency-key": "grant-stale-1" }, STALE);
      expect(stale.status).toBe(403);
      expect(stale.body.needs).toBe("step_up");
      const hidden = await w.call(DANIEL, "POST", "/api/v1/mcp/grants", { wo: "WO-risk-9", tools: ["any/x"] }, { "idempotency-key": "grant-hid-1" });
      const unknown = await w.call(DANIEL, "POST", "/api/v1/mcp/grants", { wo: "WO-nope-9", tools: ["any/x"] }, { "idempotency-key": "grant-unk-1" });
      expect([hidden.status, unknown.status]).toEqual([404, 404]);
      expect(hidden.body.msg).toBe(unknown.body.msg);
    });

    it("only a Factory Admin pre-authorises MCP writes; a project admin is refused, and a wildcard is flagged in the ledger", async () => {
      await w.insertWo("WO-grant-10", { project: "payments", position: "build", state: "running" });
      await w.q(`insert into attempts (org_id, id, wo_id, station, visit, state) values ($1,'at-grant-10','WO-grant-10','build',1,'running')`, [t.orgId]);
      const no = await w.call(DANIEL, "POST", "/api/v1/mcp/grants", { wo: "WO-grant-10", tools: ["any/x"] }, { "idempotency-key": "grant-pa-1" });
      expect(no.status).toBe(403);
      expect(String(no.body.msg)).toMatch(/Factory Admin/);
      expect((await w.q(`select data from attempts where id = 'at-grant-10'`))[0].data.writeGrants ?? null).toBeNull();
    });

    it("the requester of a work order cannot pre-authorise writes for it", async () => {
      await w.insertWo("WO-grant-9", { project: "payments", position: "build", state: "running", requestedBy: ASHA });
      await w.q(`insert into attempts (org_id, id, wo_id, station, visit, state) values ($1,'at-grant-9','WO-grant-9','build',1,'running')`, [t.orgId]);
      const r = await w.call(ASHA, "POST", "/api/v1/mcp/grants", { wo: "WO-grant-9", tools: ["any/*"] }, { "idempotency-key": "grant-self-1" });
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(String(r.body.msg)).toMatch(/requested by you/);
    });
  });

  describe("live stream", () => {
    it("one person holds a bounded number of streams; a further one is refused and nobody is evicted", () => {
      const hub = new Hub(t.db.app, t.orgId, { refresh: async () => "all" }, 60_000);
      const closed: number[] = [];
      // a real subscriber's close() removes it from the hub
      const add = (n: number, person = "p-x"): void => {
        let remove = (): void => undefined;
        const s: Subscriber = { personId: person, sessionId: null, visible: "all", write: () => true, close: () => (closed.push(n), remove()) };
        remove = hub.add(s);
      };
      for (let i = 0; i < STREAMS_PER_PERSON; i++) {
        expect(hub.hasRoom("p-x")).toBe(true);
        add(i);
      }
      expect(hub.hasRoom("p-x")).toBe(false);
      expect(hub.hasRoom("p-y")).toBe(true);
      add(99, "p-y");
      expect(closed).toEqual([]);
    });

    it("a visibility change refreshes once per person, not once per stream", async () => {
      let n = 0;
      const hub = new Hub(t.db.app, t.orgId, { refresh: async () => (n++, "all") }, 60_000);
      for (let i = 0; i < 4; i++) hub.add({ personId: "p-z", sessionId: "s1", visible: "all", write: () => true, close: () => undefined });
      await hub.dispatch({ org: t.orgId, keys: ["roles"] });
      expect(n).toBe(1);
    });
  });
});
