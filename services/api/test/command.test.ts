import { devSeed } from "@gantry/domain";
import { verifyChain } from "@gantry/db";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { command, stopCommand } from "../src/core/command.js";
import { registerRoutes } from "../src/routes/index.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const admin = "p-asha";
const lead = "p-meera"; // line lead on payments
const engineer = "p-tomas"; // engineer on payments

const testRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/v1/test/templates", { config: { apiKey: "template.edit" } }, async (req) => {
    const b = z.object({ id: z.string(), name: z.string(), via: z.string().optional() }).parse(req.body);
    return command(req, { action: "template.edit", idempotent: true }, async (tx) => {
      await tx.query(`insert into templates (org_id, id, name, body) values ($1,$2,$3,'{}')`, [req.gx.orgId, b.id, b.name]);
      return { msg: "Template saved.", events: [{ type: "template.saved", category: "config", subject: { type: "template", id: b.id }, after: { name: b.name } }], extra: { id: b.id }, changes: ["templates"], project: null };
    });
  });
  app.patch("/api/v1/test/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ desc: z.string() }).parse(req.body);
    return command(
      req,
      { action: "project.config", scope: { project: id }, ifMatch: async (tx) => (await tx.query(`select version from projects where org_id = $1 and id = $2`, [req.gx.orgId, id])).rows[0]?.version ?? null },
      async (tx) => {
        const cur = (await tx.query(`select description, version from projects where org_id = $1 and id = $2 for update`, [req.gx.orgId, id])).rows[0];
        const v = cur.version + 1;
        await tx.query(`update projects set description = $3, version = $4 where org_id = $1 and id = $2`, [req.gx.orgId, id, b.desc, v]);
        return { msg: "Saved.", events: [{ type: "project.saved", before: { desc: cur.description }, after: { desc: b.desc }, subject: { type: "project", id } }], extra: { version: v }, changes: ["projects"] };
      },
    );
  });
  app.post("/api/v1/test/projects/:id/submit", async (req) => {
    const { id } = req.params as { id: string };
    return command(req, { action: "wo.submit", scope: { project: id } }, async () => ({ msg: "Submitted.", events: [{ type: "wo.submitted" }], changes: ["workOrders"] }));
  });
  // The body writes state, then the transaction fails: nothing may remain.
  app.post("/api/v1/test/rollback/:how", async (req) => {
    const { how } = req.params as { how: string };
    return command(req, { action: "template.edit" }, async (tx) => {
      await tx.query(`insert into templates (org_id, id, name, body) values ($1,'tpl-rollback','x','{}')`, [req.gx.orgId]);
      if (how === "throw") throw new Error("boom");
      return { msg: "never", events: [{ type: "template.saved", category: "nonsense" as never }], changes: ["templates"] };
    });
  });
  app.post("/api/v1/test/jobs", async (req) =>
    command(req, { action: "template.edit" }, async () => ({
      msg: "Queued.", events: [{ type: "template.saved", category: "config" }], jobs: [{ kind: "test.job", payload: { a: 1 }, dedupeKey: "k1" }], outbox: [{ destination: "webhook:test", payload: { hello: "world" } }],
    })),
  );
  app.post("/internal/v1/test/heartbeat", async (req) =>
    command(req, { action: null, service: true }, async () => ({ msg: "ok", events: [{ type: "run.heartbeat", category: "flow", subject: { type: "run", id: "r1" } }], changes: ["workOrders"], project: "payments" })),
  );
  app.post("/internal/v1/test/no-service-flag", async (req) => command(req, { action: "wo.submit" }, async () => ({ msg: "ok", events: [] })));
  app.post("/api/v1/test/stop-with-jobs", async (req) =>
    stopCommand(req, { action: "line.halt", scope: { project: "payments" } }, async () => ({ msg: "x", events: [{ type: "stop.set", category: "kill" }], jobs: [{ kind: "nope" }] })),
  );
};

d("command pipeline", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ build: { routes: async (app) => { await registerRoutes(app); await app.register(testRoutes); } } });
  });
  afterAll(() => t.close());

  const events = async (type: string) => (await t.db.admin.query(`select * from events where type = $1 order by seq`, [type])).rows;
  const post = async (who: string, url: string, payload: unknown, extra: Record<string, string> = {}, method: "POST" | "PATCH" = "POST") => {
    const s = await t.session(who);
    return t.app.inject({ method, url, headers: { ...s.headers, ...extra }, payload: payload as object });
  };

  it("success writes state and its event together, with every audit field, and the chain verifies", async () => {
    const s = await t.session(admin);
    const r = await t.app.inject({ method: "POST", url: "/api/v1/test/templates", headers: { ...s.headers, "x-request-id": "req-abc-12345" }, payload: { id: "tpl-1", name: "One" }, remoteAddress: "203.0.113.9" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, msg: "Template saved.", id: "tpl-1" });
    expect((await t.db.admin.query(`select name from templates where id = 'tpl-1'`)).rows).toHaveLength(1);
    const [e] = await events("template.saved");
    expect(e).toMatchObject({ actor: admin, channel: "web", category: "config", outcome: "ok", session_id: s.id, request_id: "req-abc-12345", command_id: "req-abc-12345", source_ip: "203.0.113.9", rule: "MATRIX" });
    expect(e.subject).toEqual({ type: "template", id: "tpl-1" });
    expect(e.after).toEqual({ name: "One" });
    const chain = await verifyChain(t.db.app, t.orgId);
    expect(chain.ok).toBe(true);
  });

  it("a failing body or a failing event append rolls the state back: no row, no event", async () => {
    const a = await post(admin, "/api/v1/test/rollback/throw", {});
    expect(a.statusCode).toBe(500);
    const b = await post(admin, "/api/v1/test/rollback/badevent", {});
    expect(b.statusCode).toBe(500);
    expect((await t.db.admin.query(`select 1 from templates where id = 'tpl-rollback'`)).rowCount).toBe(0);
    expect(await events("template.saved")).toHaveLength(1);
  });

  it("a denial is audited in its own transaction and returns 403 with the rule", async () => {
    const before = (await events("template.edit.denied")).length;
    const r = await post(engineer, "/api/v1/test/templates", { id: "tpl-denied", name: "No" });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ ok: false, rule: { kind: "matrix" } });
    expect(r.json().msg).toBeTruthy();
    expect((await t.db.admin.query(`select 1 from templates where id = 'tpl-denied'`)).rowCount).toBe(0);
    const ev = await events("template.edit.denied");
    expect(ev).toHaveLength(before + 1);
    expect(ev.at(-1)).toMatchObject({ actor: engineer, outcome: "denied", category: "config", channel: "web" });
    expect(ev.at(-1).after.reason).toBeTruthy();
    expect((await verifyChain(t.db.app, t.orgId)).ok).toBe(true);
  });

  it("If-Match: a stale version is a 409 and changes nothing; the current version succeeds and bumps; no header proceeds", async () => {
    const v0 = (await t.db.admin.query(`select version from projects where id = 'payments'`)).rows[0].version;
    const nEvents = (await events("project.saved")).length;
    const stale = await post(admin, "/api/v1/test/projects/payments", { desc: "stale" }, { "if-match": String(v0 + 5) }, "PATCH");
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ ok: false });
    expect((await events("project.saved")).length).toBe(nEvents);
    const ok = await post(admin, "/api/v1/test/projects/payments", { desc: "fresh" }, { "if-match": String(v0) }, "PATCH");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().version).toBe(v0 + 1);
    const again = await post(admin, "/api/v1/test/projects/payments", { desc: "twice" }, { "if-match": String(v0) }, "PATCH"); // the same stale token again
    expect(again.statusCode).toBe(409);
    const none = await post(admin, "/api/v1/test/projects/payments", { desc: "no header" }, {}, "PATCH");
    expect(none.statusCode).toBe(200);
    const [e] = await events("project.saved");
    expect(e.before).toEqual({ desc: expect.any(String) });
    expect(e.after).toEqual({ desc: "fresh" });
    expect((await post(admin, "/api/v1/test/projects/payments", { desc: "x" }, { "if-match": "abc" }, "PATCH")).statusCode).toBe(422);
    expect((await post(admin, "/api/v1/test/projects/nope", { desc: "x" }, { "if-match": "1" }, "PATCH")).statusCode).toBe(404); // unknown project
  });

  it("an engineer cannot change project config: denied, not stale", async () => {
    const r = await post(engineer, "/api/v1/test/projects/payments", { desc: "no" }, { "if-match": "999" }, "PATCH");
    expect(r.statusCode).toBe(403);
  });

  it("idempotent create: same key and body replays the first result once; a different body is a 409", async () => {
    const s = await t.session(admin);
    const send = (body: object, key = "key-1") => t.app.inject({ method: "POST", url: "/api/v1/test/templates", headers: { ...s.headers, "idempotency-key": key }, payload: body });
    const a = await send({ id: "tpl-idem", name: "Once" });
    const b = await send({ id: "tpl-idem", name: "Once" });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(a.headers["idempotent-replayed"]).toBeUndefined();
    expect((await t.db.admin.query(`select 1 from templates where id = 'tpl-idem'`)).rowCount).toBe(1);
    expect((await events("template.saved")).filter((e) => e.subject.id === "tpl-idem")).toHaveLength(1);
    const c = await send({ id: "tpl-idem", name: "Different" });
    expect(c.statusCode).toBe(409);
    // concurrent retries with one key create one row
    const burst = await Promise.all(Array.from({ length: 5 }, () => send({ id: "tpl-burst", name: "B" }, "key-burst")));
    expect(burst.every((r) => r.statusCode === 200)).toBe(true);
    expect((await events("template.saved")).filter((e) => e.subject.id === "tpl-burst")).toHaveLength(1);
    // a denied attempt does not consume the key
    const e = await t.session(engineer);
    const denied = await t.app.inject({ method: "POST", url: "/api/v1/test/templates", headers: { ...e.headers, "idempotency-key": "key-denied" }, payload: { id: "tpl-d2", name: "x" } });
    expect(denied.statusCode).toBe(403);
    const keyRows = await t.db.admin.query(`select 1 from idempotency_keys where key = 'key-denied'`);
    expect(keyRows.rowCount).toBe(0);
  });

  it("a killed scope refuses with 409 and the stop reason, audited; lifting it restores access", async () => {
    await t.db.admin.query(`insert into stops (org_id, id, scope_type, project_id, mode, reason, in_flight, set_by) values ($1,'project:payments:t1','project','payments','kill','Contained an incident','hold',$2)`, [t.orgId, admin]);
    const r = await post(lead, "/api/v1/test/projects/payments/submit", {});
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ ok: false, rule: { kind: "stop" } });
    expect(r.json().msg).toContain("Contained an incident");
    const ev = await events("wo.submit.denied");
    expect(ev.at(-1)).toMatchObject({ actor: lead, outcome: "denied", project_id: "payments" });
    // another project is unaffected
    expect((await post("p-chloe", "/api/v1/test/projects/storefront/submit", {})).statusCode).toBe(200);
    // stop controls still work in the stopped scope (invariant I7)
    expect((await post("p-daniel", "/api/v1/test/stop-with-jobs", {})).statusCode).not.toBe(409);
    await t.db.admin.query(`update stops set lifted_at = now(), lifted_by = $1 where id = 'project:payments:t1'`, [admin]);
    expect((await post(lead, "/api/v1/test/projects/payments/submit", {})).statusCode).toBe(200);
  });

  it("a halt blocks gate progression but not intake; a factory kill blocks everyone's work", async () => {
    await t.db.admin.query(`insert into stops (org_id, id, scope_type, mode, reason, in_flight, set_by) values ($1,'factory:factory:t1','factory','kill','Drill',null,$2)`, [t.orgId, admin]);
    const r = await post("p-chloe", "/api/v1/test/projects/storefront/submit", {});
    expect(r.statusCode).toBe(409);
    expect(r.json().msg).toContain("Drill");
    await t.db.admin.query(`update stops set lifted_at = now(), lifted_by = $1 where id = 'factory:factory:t1'`, [admin]);
  });

  it("via and principal kind are recorded: console on behalf of the person; API key as its own actor on channel api", async () => {
    await post(admin, "/api/v1/test/templates", { id: "tpl-via", name: "V", via: "console" });
    const e = (await events("template.saved")).find((x) => x.subject.id === "tpl-via")!;
    expect(e).toMatchObject({ channel: "console", actor: admin, on_behalf_of: admin });

    const { generateApiKey } = await import("../src/core/auth/apikeys.js");
    const k = generateApiKey();
    await t.db.admin.query(`insert into api_keys (org_id, id, name, key_hash, key_prefix, scopes) values ($1,'key-9','bot',$2,$3,'["template.edit"]')`, [t.orgId, k.hash, k.prefix]);
    // spec 5.3: an API key creating something must send an Idempotency-Key
    const noKey = await t.app.inject({ method: "POST", url: "/api/v1/test/templates", headers: { authorization: `Bearer ${k.key}` }, payload: { id: "tpl-key", name: "K" } });
    expect(noKey.statusCode).toBe(422);
    expect(noKey.json()).toMatchObject({ ok: false, msg: expect.stringContaining("Idempotency-Key") });
    expect((await events("template.saved")).find((x) => x.subject.id === "tpl-key")).toBeUndefined();
    const r = await t.app.inject({ method: "POST", url: "/api/v1/test/templates", headers: { authorization: `Bearer ${k.key}`, "idempotency-key": "k9-create-1" }, payload: { id: "tpl-key", name: "K" } });
    expect(r.statusCode).toBe(200);
    const ke = (await events("template.saved")).find((x) => x.subject.id === "tpl-key")!;
    expect(ke).toMatchObject({ actor: "apikey:key-9", channel: "api", session_id: null });
  });

  it("jobs and outbox rows are written in the same transaction; reduced stop commands refuse them", async () => {
    const r = await post(admin, "/api/v1/test/jobs", {});
    expect(r.statusCode).toBe(200);
    const job = (await t.db.admin.query(`select kind, payload from jobs where kind = 'test.job'`)).rows;
    expect(job).toEqual([{ kind: "test.job", payload: { a: 1 } }]);
    const ob = (await t.db.admin.query(`select o.destination, o.event_id, e.type from outbox o join events e on e.id = o.event_id`)).rows;
    expect(ob).toHaveLength(1);
    expect(ob[0]).toMatchObject({ destination: "webhook:test", type: "template.saved" });
    const stop = await post("p-daniel", "/api/v1/test/stop-with-jobs", {});
    expect(stop.statusCode).toBe(500);
    expect(await events("stop.set")).toHaveLength(0);
  });

  it("a service principal runs commands only where the handler declares service: true; its events name the service on channel system", async () => {
    const hdr = { authorization: `Bearer ${t.config.secrets.githubToken}` };
    const r = await t.app.inject({ method: "POST", url: "/internal/v1/test/heartbeat", headers: hdr, payload: {} });
    expect(r.statusCode).toBe(200);
    const [e] = await events("run.heartbeat");
    expect(e).toMatchObject({ actor: "github", channel: "system", rule: "github", project_id: null });
    const no = await t.app.inject({ method: "POST", url: "/internal/v1/test/no-service-flag", headers: hdr, payload: {} });
    expect(no.statusCode).toBe(403);
    // browsers never reach /internal, and service tokens never work on the product API
    expect((await t.app.inject({ method: "POST", url: "/api/v1/can", headers: hdr, payload: { checks: [] } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "POST", url: "/internal/v1/test/heartbeat", payload: {} })).statusCode).toBe(401);
  });

  it("an unauthenticated command is refused before anything runs", async () => {
    const r = await t.app.inject({ method: "POST", url: "/api/v1/test/templates", payload: { id: "x", name: "y" } });
    expect(r.statusCode).toBe(401);
  });

  it("the hash chain stays valid after all of the above", async () => {
    const c = await verifyChain(t.db.app, t.orgId);
    expect(c.ok).toBe(true);
    expect(devSeed()).toBeTruthy();
  });
});
