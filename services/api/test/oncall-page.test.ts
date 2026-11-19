import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, SESSION_KEY, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { registerNotificationProducer } from "../src/areas/notifications/producer.js";

const d = TEST_URL ? describe : describe.skip;

/** The on-call pager: the "on-call" recipient keyword, the default page for urgent events, one page per person, and the delivery log and audit trail of each page. */
d("on-call pager", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ config: { secrets: { sessionKey: SESSION_KEY, dataKey: randomBytes(32), edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
    registerNotificationProducer({ publicUrl: "https://gantry.test", onError: (e, ev) => console.error("PRODUCER", ev.type, e) });
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const MGR = "p-daniel";
  const ONCALL = "p-meera";
  const emailOf = async (id: string) => String((await w.q(`select email from people where id = $1`, [id]))[0].email).toLowerCase();
  const reset = async (list: string[] = [ONCALL]) => {
    await w.q(`insert into integration_types (org_id, id, name, builtin, field_schema, data) values ($1,'email','Email',true,'[]','{"destination":true}') on conflict do nothing`, [t.orgId]);
    await w.q(`insert into integration_instances (org_id, id, type_id, name, enabled, config) values ($1,'int-mail','email','Ops mail',true,$2::jsonb) on conflict do nothing`, [t.orgId, JSON.stringify({ from: "ops@acme.test", _meta: { projects: "all" } })]);
    await w.q(`delete from notification_routes`);
    await w.q(`delete from deliveries`);
    await w.q(`delete from outbox`);
    await w.q(`update stops set lifted_at = now(), lifted_by = 'p-asha' where lifted_at is null`);
    await w.q(`update people set away = null`);
    await w.q(`update projects set config = jsonb_set(config - 'oncallPage', '{oncall}', $1::jsonb) where id = 'payments'`, [JSON.stringify(list)]);
  };
  const outbox = (type: string) => w.q(`select o.destination, o.payload from outbox o join events e on e.id = o.event_id where e.type = $1 order by o.created_at`, [type]);
  const halt = () => w.call("p-meera", "POST", "/api/v1/stops", { scope: "project", id: "payments", mode: "halt", reason: "Andon: check the agents" });
  const kill = () => w.call("p-asha", "POST", "/api/v1/stops", { scope: "project", id: "payments", mode: "kill", reason: "Incident", confirmText: "Payments Platform", inFlight: "hold" });
  const toOf = (rows: Array<{ payload: { to?: string[] } }>) => rows.flatMap((r) => r.payload.to ?? []);

  it("a project kill pages the on-call person by default, in the delivery log and the audit trail", async () => {
    await reset();
    expect((await kill()).status).toBe(200);
    const rows = await outbox("kill");
    expect(toOf(rows)).toContain(await emailOf(ONCALL));
    const log = await w.q(`select request, status from deliveries where project_id = 'payments' and event_type = 'kill'`);
    expect(log.some((r: { request: { page?: boolean } }) => r.request.page === true)).toBe(true);
    const ev = await w.q(`select after from events where type = 'notify.page' and project_id = 'payments' order by seq`);
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev[0].after).toMatchObject({ event: "kill", source: "kill", paged: [ONCALL] });
  });

  it("a halt pages on call; the project can turn the default page off for halts, but never for kill", async () => {
    await reset();
    expect((await halt()).status).toBe(200);
    expect(toOf(await outbox("halt"))).toContain(await emailOf(ONCALL));
    await reset();
    const off = await w.call(MGR, "PATCH", "/api/v1/projects/payments/config", { path: "notifications.oncallPage", value: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect((await w.call("p-asha", "GET", "/api/v1/projects")).body.find((p: { id: string }) => p.id === "payments")?.pageOnCall).toBe(false);
    expect((await halt()).status).toBe(200);
    expect(await outbox("halt"), "default page is off for halts").toHaveLength(0);
    expect((await kill()).status).toBe(200);
    expect(toOf(await outbox("kill")), "kill pages whatever the setting").toContain(await emailOf(ONCALL));
  });

  it("a route that names on-call and the default page together page the person once", async () => {
    await reset();
    const route = { id: "NR-1", event: "kill", dest: [{ channel: "email", target: "on-call", integration: null }], template: "", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: {} };
    const r = await w.call(MGR, "PATCH", "/api/v1/projects/payments/config", { path: "notifications", value: [route] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await kill()).status).toBe(200);
    const to = toOf(await outbox("kill"));
    expect(new Set(to).size, "no address twice").toBe(to.length);
    expect(to.filter((x) => x === to[0]).length).toBe(1);
    expect(to).toContain(await emailOf(ONCALL));
  });

  it("an away person is not paged; with nobody left the Factory Admins are", async () => {
    await reset();
    await w.q(`update people set away = $1::jsonb where id = $2`, [JSON.stringify({ from: Date.now() - 1000, to: Date.now() + 3_600_000, delegate: null }), ONCALL]);
    expect((await halt()).status).toBe(200);
    const to = toOf(await outbox("halt"));
    expect(to).not.toContain(await emailOf(ONCALL));
    const admins = (await w.q(`select distinct p.email from people p join effective_role_assignments ra on ra.org_id = p.org_id and ra.person_id = p.id where p.status = 'active' and ra.role_id = 'factory_admin' and ra.revoked_at is null`)).map((r: { email: string }) => r.email.toLowerCase());
    expect(admins.length).toBeGreaterThan(0);
    expect(to.sort()).toEqual(admins.sort());
    const ev = await w.q(`select after from events where type = 'notify.page' order by seq desc limit 1`);
    expect(ev[0].after.fallback).toMatch(/Factory Admins/);
  });

  it("the on-call keyword also works in a test send", async () => {
    await reset();
    const r = await w.call(MGR, "POST", "/api/v1/projects/payments/routes/test", { dest: "email", target: "on-call", event: "andon" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const o = await w.q(`select payload from outbox order by created_at desc limit 1`);
    expect(o[0].payload.to).toContain(await emailOf(ONCALL));
  });
});
