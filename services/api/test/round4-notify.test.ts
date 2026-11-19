import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, SESSION_KEY, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { registerNotificationProducer } from "../src/areas/notifications/producer.js";
import { notifyEventFor } from "../src/areas/notifications/events.js";

const d = TEST_URL ? describe : describe.skip;

/** S-35, S-36 and S-37 (the resume half): kill routes cannot be dropped in bulk, a kill always reaches someone, a deactivated person is skipped, a resume is announced. */
d("round 4: notifications of kill, restore and resume", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ config: { secrets: { sessionKey: SESSION_KEY, dataKey: randomBytes(32), edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
    registerNotificationProducer({ publicUrl: "https://gantry.test", onError: (e, ev) => console.error("PRODUCER", ev.type, e) });
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const MGR = "p-daniel"; // project admin on payments: notify.edit
  const patch = (value: unknown[]) => w.call(MGR, "PATCH", "/api/v1/projects/payments/config", { path: "notifications", value });
  const mail = async (id = "int-mail") => {
    await w.q(`insert into integration_types (org_id, id, name, builtin, field_schema, data) values ($1,'email','Email',true,'[]','{"destination":true}') on conflict do nothing`, [t.orgId]);
    await w.q(`insert into integration_instances (org_id, id, type_id, name, enabled, config) values ($1,$2,'email','Ops mail',true,$3::jsonb) on conflict do nothing`, [t.orgId, id, JSON.stringify({ from: "ops@acme.test", _meta: { projects: "all" } })]);
    return id;
  };
  const noRoutes = async () => {
    await w.q(`delete from notification_routes`);
    await w.q(`delete from deliveries`);
    await w.q(`delete from outbox`);
    await w.q(`update stops set lifted_at = now(), lifted_by = 'p-asha' where lifted_at is null`);
  };
  const outboxFor = (type: string) => w.q(`select o.destination, o.payload, o.status from outbox o join events e on e.id = o.event_id where e.type = $1 order by o.created_at`, [type]);
  const killFactory = () => w.call("p-asha", "POST", "/api/v1/stops", { scope: "factory", mode: "kill", reason: "Credential leak", confirmText: "KILL FACTORY", inFlight: "hold" });
  const restoreFactory = async () => {
    await w.call("p-asha", "POST", "/api/v1/stops/factory%3A/restore", { reason: "All clear" });
    await w.call("p-omar", "POST", "/api/v1/stops/factory%3A/restore", { reason: "All clear" });
  };

  it("S-35: a bulk save cannot drop or switch off the kill and restore routes, with the single-route messages", async () => {
    await noRoutes();
    const dest = [{ channel: "email", target: "project admins", integration: null }];
    const cond = { classes: [], priority: [], hours: "any" as const };
    const mk = (id: string, event: string, over: Record<string, unknown> = {}) => ({ id, event, dest, template: "", cond, enabled: true, fields: {}, ...over });
    const ok = await patch([mk("NR-1", "kill"), mk("NR-2", "restore"), mk("NR-3", "submitted")]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const dropped = await patch([mk("NR-3", "submitted")]);
    expect(dropped.status).toBe(409);
    expect(dropped.body.msg).toBe("Kill and restore routes cannot be removed. Change where they go instead.");
    const empty = await patch([]);
    expect(empty.status).toBe(409);
    const off = await patch([mk("NR-1", "kill", { enabled: false }), mk("NR-2", "restore")]);
    expect(off.status).toBe(422);
    expect(off.body.msg).toBe("Kill and restore notifications cannot be switched off or narrowed.");
    const narrow = await patch([mk("NR-1", "kill", { cond: { ...cond, priority: ["P0"] } }), mk("NR-2", "restore")]);
    expect(narrow.status).toBe(422);
    expect((await w.q(`select count(*)::int n from notification_routes where event in ('kill','restore')`))[0].n).toBe(2);
    // changing where they go is fine
    const moved = await patch([mk("NR-1", "kill", { dest: [{ channel: "email", target: "asha@acme.dev", integration: null }] }), mk("NR-2", "restore")]);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  });

  it("S-35: a kill with no kill route anywhere still tells the Factory Admins by email, and the delivery is logged", async () => {
    await noRoutes();
    const inst = await mail();
    const k = await killFactory();
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    const rows = await outboxFor("kill");
    expect(rows).toHaveLength(1);
    expect(rows[0].destination).toMatch(new RegExp(`^smtp:${inst}:`));
    expect(rows[0].payload.mandatory).toBe(true);
    expect(rows[0].payload.to).toContain("asha@acme.dev");
    const dl = await w.q(`select status, event_type from deliveries where event_type = 'kill'`);
    expect(dl).toEqual([{ status: "pending", event_type: "kill" }]);
    await restoreFactory();
  });

  it("S-35: with no connection that can carry a kill, a failed delivery is logged instead of silence", async () => {
    await noRoutes();
    await w.q(`delete from integration_instances`);
    const k = await w.call("p-asha", "POST", "/api/v1/stops", { scope: "project", id: "payments", mode: "kill", reason: "Bad release", confirmText: "Payments Platform", inFlight: "hold" });
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    const dl = await w.q(`select status, error, event_type from deliveries where event_type = 'kill'`);
    expect(dl).toHaveLength(1);
    expect(dl[0].status).toBe("failed");
    expect(dl[0].error).toMatch(/Factory Admins/);
    await w.call("p-asha", "POST", "/api/v1/stops/project%3Apayments/restore", { reason: "All clear" });
  });

  it("S-36: a typed address that belongs to a deactivated person is skipped and the skip is logged", async () => {
    await noRoutes();
    const inst = await mail();
    await w.q(`update people set status = 'deactivated' where id = 'p-rui'`).catch(() => undefined);
    const st = (await w.q(`select status from people where id = 'p-rui'`))[0].status;
    expect(st).not.toBe("active");
    await patch([{ id: "NR-1", event: "submitted", dest: [{ channel: "email", target: "rui@acme.dev, tomas@acme.dev, outsider@example.org", integration: inst }], template: "", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: {} }]);
    expect((await w.submit("p-tomas", { title: "Typed address of a leaver" })).status).toBe(200);
    const rows = await outboxFor("wo.submit");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.to.sort()).toEqual(["outsider@example.org", "tomas@acme.dev"]);
    const dl = (await w.q(`select request from deliveries where event_type = 'submitted'`))[0];
    expect(dl.request.skipped).toEqual([{ address: "rui@acme.dev", reason: "recipient deactivated" }]);
    // only a deactivated address: nothing is sent and the log says why
    await patch([{ id: "NR-1", event: "submitted", dest: [{ channel: "email", target: "rui@acme.dev", integration: inst }], template: "", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: {} }]);
    await w.q(`delete from deliveries`);
    await w.submit("p-tomas", { title: "Only a leaver" });
    const only = (await w.q(`select status, error from deliveries where event_type = 'submitted'`))[0];
    expect(only.status).toBe("failed");
    expect(only.error).toMatch(/deactivated/);
    await w.q(`update people set status = 'active' where id = 'p-rui'`);
  });

  it("S-37: a resume is announced on the halt routes, and a restore on the kill routes", async () => {
    expect(notifyEventFor({ type: "resume", category: "kill" })).toMatchObject({ event: "andon" });
    await noRoutes();
    const inst = await mail();
    const dest = [{ channel: "email", target: "asha@acme.dev", integration: inst }];
    const route = (id: string, event: string) => ({ id, event, dest, template: "", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: {} });
    expect((await patch([route("NR-1", "andon"), route("NR-2", "kill"), route("NR-3", "restore")])).status).toBe(200);
    const h = await w.call("p-meera", "POST", "/api/v1/stops", { scope: "project", id: "payments", mode: "halt", reason: "Flaky tests today" });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect(await outboxFor("halt")).toHaveLength(1);
    expect((await w.call("p-meera", "DELETE", "/api/v1/stops/project%3Apayments")).status).toBe(200);
    const res = await outboxFor("resume");
    expect(res).toHaveLength(1);
    expect(res[0].payload.text).toMatch(/resumed/i);
    expect((await w.q(`select route_id, event_type from deliveries where event_type = 'andon' order by created_at`)).map((r) => r.route_id)).toEqual(["NR-1", "NR-1"]);
    const k = await w.call("p-asha", "POST", "/api/v1/stops", { scope: "project", id: "payments", mode: "kill", reason: "Bad release", confirmText: "Payments Platform", inFlight: "hold" });
    expect(k.status).toBe(200);
    expect((await w.call("p-asha", "POST", "/api/v1/stops/project%3Apayments/restore", { reason: "All clear" })).status).toBe(200);
    expect(await outboxFor("restore")).toHaveLength(1);
  });
});
