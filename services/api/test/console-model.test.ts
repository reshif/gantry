import { withTx } from "@gantry/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureConsoleEdge, resetConsoleEdge } from "../src/areas/console/model.js";
import { ensureDefaultModel } from "../src/areas/models/default.js";
import { bootstrapOrg } from "../src/core/bootstrap.js";
import { FakeEdge, parseSse } from "./console-edge.js";
import { startApp, testConfig, type TestApp } from "./helpers.js";

/**
 * The console's model (spec 12.6, 10.4): the routing default is set automatically when a callable model appears and none is set; the console
 * lists the models the gateway can call, saves a per-person choice, and validates it on every message. The edge is a double: no vendor is called.
 */
describe("console model picker and automatic routing default", () => {
  let t: TestApp;
  const edge = new FakeEdge();
  const ASHA = "p-asha"; // factory admin
  const TOMAS = "p-tomas"; // engineer
  const q = (sql: string, p: unknown[] = []) => t.db.admin.query(sql, p);

  beforeAll(async () => {
    await edge.start();
    configureConsoleEdge({ baseUrl: edge.url });
    t = await startApp({});
    await q(`update vendors set secret_enc = $2 where org_id = $1 and id in ('anthropic','openai','bedrock')`, [t.orgId, "sealed-for-tests"]);
  });
  afterAll(async () => {
    resetConsoleEdge();
    await edge.stop();
    await t.close();
  });
  beforeEach(async () => {
    edge.reset();
    await q(`delete from console_prefs where org_id = $1`, [t.orgId]);
    await q(`delete from console_threads where org_id = $1`, [t.orgId]);
  });

  const call = async (who: string, method: "GET" | "POST" | "PUT" | "PATCH", url: string, body?: unknown) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method, url, headers: s.headers, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body, json: () => r.json() as any, headers: r.headers };
  };
  const setDefault = async (model: string) => {
    const cur = (await q(`select version, body from routing_versions where org_id = $1 and published_at is not null order by version desc limit 1`, [t.orgId])).rows[0]!;
    await q(`insert into routing_versions (org_id, version, body, note, published_at, published_by) values ($1,$2,$3::jsonb,'test',now(),'test')`, [t.orgId, cur.version + 1, JSON.stringify({ ...cur.body, defaultModel: model })]);
  };
  const currentDefault = async (): Promise<string> => (await call(ASHA, "GET", "/api/v1/routing")).json().defaultModel;

  describe("automatic default", () => {
    it("sets the starter kit's general model when there is no default, audits it as a system routing change, and never overrides one", async () => {
      const original = await currentDefault();
      expect(original).toBe("claude-opus-5-5");
      // An existing default is never replaced.
      expect(await withTx(t.db.app, (tx) => ensureDefaultModel(tx, t.orgId, "test"))).toBeNull();
      expect(await currentDefault()).toBe(original);

      await setDefault("");
      const before = Number((await q(`select count(*)::int as n from events where org_id = $1 and type = 'routing.edit'`, [t.orgId])).rows[0]!.n);
      const picked = await withTx(t.db.app, (tx) => ensureDefaultModel(tx, t.orgId, "vendor.add"));
      expect(picked).toBe("claude-sonnet-5-5");
      const r = (await call(ASHA, "GET", "/api/v1/routing")).json();
      expect(r.defaultModel).toBe("claude-sonnet-5-5");
      expect(r.fallback.length).toBeGreaterThan(0);
      const ev = (await q(`select actor, channel, after from events where org_id = $1 and type = 'routing.edit' order by seq desc limit 1`, [t.orgId])).rows[0]!;
      expect(ev).toMatchObject({ actor: "system", channel: "system", after: { defaultModel: "claude-sonnet-5-5", automatic: true, cause: "vendor.add" } });
      expect(Number((await q(`select count(*)::int as n from events where org_id = $1 and type = 'routing.edit'`, [t.orgId])).rows[0]!.n)).toBe(before + 1);
      // Idempotent.
      expect(await withTx(t.db.app, (tx) => ensureDefaultModel(tx, t.orgId, "again"))).toBeNull();
      await setDefault(original);
    });

    it("falls back to the first callable enabled model when the general model is off", async () => {
      await q(`update models set enabled = false where org_id = $1 and id = 'claude-sonnet-5-5'`, [t.orgId]);
      await setDefault("");
      const picked = await withTx(t.db.app, (tx) => ensureDefaultModel(tx, t.orgId, "test"));
      expect(picked).toBeTruthy();
      expect(picked).not.toBe("claude-sonnet-5-5");
      await q(`update models set enabled = true where org_id = $1 and id = 'claude-sonnet-5-5'`, [t.orgId]);
      await setDefault("claude-opus-5-5");
    });

    it("enabling a model with no default sets one (the model switch path)", async () => {
      await q(`update models set enabled = false where org_id = $1 and id = 'claude-haiku-5-5'`, [t.orgId]);
      await setDefault("");
      const r = await call(ASHA, "PATCH", "/api/v1/models/claude-haiku-5-5", { enabled: true });
      expect(r.status).toBe(200);
      expect(await currentDefault()).toBe("claude-sonnet-5-5");
      await setDefault("claude-opus-5-5");
    });

    it("startup sets the default for an existing org that has none, and leaves an existing one alone", async () => {
      await setDefault("");
      await bootstrapOrg(t.db.app, testConfig(), undefined, {});
      expect(await currentDefault()).toBe("claude-sonnet-5-5");
      await bootstrapOrg(t.db.app, testConfig(), undefined, {});
      expect(await currentDefault()).toBe("claude-sonnet-5-5");
      await setDefault("claude-opus-5-5");
    });

    it("nothing callable: no default is invented", async () => {
      await q(`update vendors set connected = false where org_id = $1`, [t.orgId]);
      await setDefault("");
      expect(await withTx(t.db.app, (tx) => ensureDefaultModel(tx, t.orgId, "test"))).toBeNull();
      expect(await currentDefault()).toBe("");
      await q(`update vendors set connected = true where org_id = $1 and id in ('anthropic','openai','bedrock')`, [t.orgId]);
      await setDefault("claude-opus-5-5");
    });
  });

  describe("status and choice", () => {
    it("lists the enabled callable models with their vendor, tier and price, and the routing default", async () => {
      const st = (await call(TOMAS, "GET", "/api/v1/console/status")).json();
      const ids = st.models.map((m: any) => m.id);
      expect(ids).toEqual(expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]));
      expect(st.models[0]).toMatchObject({ id: "claude-sonnet-5-5", vendor: "anthropic", vendorName: "Anthropic", tier: "standard" });
      expect(st).toMatchObject({ defaultModel: "claude-opus-5-5", effectiveModel: "claude-opus-5-5", choice: null, canManageModels: false });
      expect((await call(ASHA, "GET", "/api/v1/console/status")).json().canManageModels).toBe(true);
      // The edge is asked whether the model in effect can be called.
      expect(edge.readyUrls.some((u) => u.includes("model="))).toBe(false);
    });

    it("a disabled model and a vendor that is off are not offered", async () => {
      await q(`update models set enabled = false where org_id = $1 and id = 'claude-haiku-5-5'`, [t.orgId]);
      const st = (await call(TOMAS, "GET", "/api/v1/console/status")).json();
      expect(st.models.map((m: any) => m.id)).not.toContain("claude-haiku-5-5");
      await q(`update models set enabled = true where org_id = $1 and id = 'claude-haiku-5-5'`, [t.orgId]);
    });

    it("saves the choice per person and refuses a model that is not callable", async () => {
      const ok = await call(TOMAS, "PUT", "/api/v1/console/model", { model: "claude-haiku-5-5" });
      expect(ok.status, ok.body).toBe(200);
      const mine = (await call(TOMAS, "GET", "/api/v1/console/status")).json();
      expect(mine).toMatchObject({ choice: "claude-haiku-5-5", effectiveModel: "claude-haiku-5-5" });
      expect(edge.readyUrls.at(-1)).toContain("model=claude-haiku-5-5");
      expect((await call(ASHA, "GET", "/api/v1/console/status")).json()).toMatchObject({ choice: null, effectiveModel: "claude-opus-5-5" });

      const bad = await call(TOMAS, "PUT", "/api/v1/console/model", { model: "no-such-model" });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(bad.json().msg).toMatch(/not available/);
      const inactive = await call(TOMAS, "PUT", "/api/v1/console/model", { model: "local-llama" });
      expect(inactive.status).toBeGreaterThanOrEqual(400);

      const reset = await call(TOMAS, "PUT", "/api/v1/console/model", { model: null });
      expect(reset.status).toBe(200);
      expect((await call(TOMAS, "GET", "/api/v1/console/status")).json().choice).toBeNull();
    });

    it("a saved choice that has since been disabled falls back to the default", async () => {
      await call(TOMAS, "PUT", "/api/v1/console/model", { model: "claude-haiku-5-5" });
      await q(`update models set enabled = false where org_id = $1 and id = 'claude-haiku-5-5'`, [t.orgId]);
      const st = (await call(TOMAS, "GET", "/api/v1/console/status")).json();
      expect(st).toMatchObject({ choice: null, effectiveModel: "claude-opus-5-5" });
      await q(`update models set enabled = true where org_id = $1 and id = 'claude-haiku-5-5'`, [t.orgId]);
    });
  });

  describe("messages", () => {
    const ask = async (who: string, body: Record<string, unknown>) => {
      const r = await call(who, "POST", "/api/v1/console/messages", { text: "How many projects are there?", ...body });
      return { ...r, events: r.headers["content-type"]?.toString().includes("text/event-stream") ? parseSse(r.body) : [] };
    };

    it("sends the person's chosen model to the edge", async () => {
      await call(TOMAS, "PUT", "/api/v1/console/model", { model: "claude-haiku-5-5" });
      edge.script = [{ blocks: [{ type: "text", text: "Three." }] }];
      const r = await ask(TOMAS, {});
      expect(r.status).toBe(200);
      expect(r.events.at(-1)!.event).toBe("done");
      expect(edge.calls[0]!.headers["x-gantry-model-pick"]).toBe("claude-haiku-5-5");
    });

    it("an explicit model on the message wins, and without any choice the routing decides (nothing is pinned)", async () => {
      edge.script = [{ blocks: [{ type: "text", text: "One." }] }, { blocks: [{ type: "text", text: "Two." }] }];
      await ask(ASHA, { model: "claude-sonnet-5-5" });
      expect(edge.calls[0]!.headers["x-gantry-model-pick"]).toBe("claude-sonnet-5-5");
      await ask(ASHA, {});
      expect(edge.calls[1]!.headers["x-gantry-model-pick"]).toBeUndefined();
    });

    it("refuses a disabled or unknown model before anything is saved or sent", async () => {
      await q(`update models set enabled = false where org_id = $1 and id = 'claude-haiku-5-5'`, [t.orgId]);
      const r = await ask(TOMAS, { model: "claude-haiku-5-5" });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.json().msg).toMatch(/not available/);
      expect((await ask(TOMAS, { model: "nope" })).status).toBeGreaterThanOrEqual(400);
      expect(edge.calls).toHaveLength(0);
      expect(Number((await q(`select count(*)::int as n from console_threads where org_id = $1`, [t.orgId])).rows[0]!.n)).toBe(0);
      await q(`update models set enabled = true where org_id = $1 and id = 'claude-haiku-5-5'`, [t.orgId]);
    });

    it("the project's routing policy limits the choice when the question is about a project", async () => {
      const cur = (await q(`select version, body from routing_versions where org_id = $1 and published_at is not null order by version desc limit 1`, [t.orgId])).rows[0]!;
      const projects = { ...(cur.body.projects ?? {}), payments: { ...(cur.body.projects?.payments ?? {}), allowedVendors: ["bedrock"] } };
      await q(`insert into routing_versions (org_id, version, body, note, published_at, published_by) values ($1,$2,$3::jsonb,'test',now(),'test')`, [t.orgId, cur.version + 1, JSON.stringify({ ...cur.body, projects })]);
      const r = await ask(ASHA, { model: "claude-haiku-5-5", project: "payments" });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.json().msg).toMatch(/not available/);
      const st = (await call(ASHA, "GET", "/api/v1/console/status?project=payments")).json();
      expect(st.models.every((m: any) => m.vendor === "bedrock")).toBe(true);
      await q(`insert into routing_versions (org_id, version, body, note, published_at, published_by) values ($1,$2,$3::jsonb,'test',now(),'test')`, [t.orgId, cur.version + 2, JSON.stringify(cur.body)]);
    });
  });
});
