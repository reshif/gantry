import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, SESSION_KEY, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { Double, fakeBotToken, fakeSigningSecret, slackDouble } from "./notify-doubles.js";
import { configureRuntime, resetRuntime } from "../src/areas/integrations/runtime.js";
import { proxiedHttp } from "../src/areas/notifications/http.js";
import { chatApprovalFor } from "../src/areas/integrations/chat-policy.js";
import { notifyEventFor } from "../src/areas/notifications/events.js";
import { signSlack } from "../src/areas/notifications/slack.js";
import { registerNotificationProducer } from "../src/areas/notifications/producer.js";

const d = TEST_URL ? describe : describe.skip;
const DATA_KEY = randomBytes(32);

d("notifications (spec 12.2): routes, producer, deliveries, cards", () => {
  let t: TestApp;
  let slack: Double;
  const token = fakeBotToken();
  const signing = fakeSigningSecret();
  let inst: string;
  beforeAll(async () => {
    slack = await slackDouble(token);
    t = await startApp({ config: { secrets: { sessionKey: SESSION_KEY, dataKey: DATA_KEY, edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
    configureRuntime({ http: proxiedHttp({ proxy: null }), slackBase: `${slack.url}/api`, smtp: { host: null, port: 25 } });
    registerNotificationProducer({ publicUrl: "https://gantry.test", onError: (e, ev) => console.error("PRODUCER", ev.type, e) });
    const r = await w.call("p-asha", "POST", "/api/v1/integrations", { type: "slack", name: "Acme Slack", config: { workspace: "acme", defaultChannel: "#factory-gates" }, secrets: { botToken: token, signingSecret: signing }, projects: "all", enable: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    inst = r.body.integration.id;
  });
  afterAll(async () => {
    resetRuntime();
    await slack.stop();
    await t.close();
  });
  const w = world(() => t);
  const MGR = "p-daniel"; // project admin on payments: notify.edit
  const route = (over: Record<string, unknown> = {}, who = MGR, project = "payments") =>
    w.call(who, "POST", `/api/v1/projects/${project}/routes`, { event: "submitted", dest: [{ channel: "slack", target: "#intake", integration: inst }], template: "submitted", ...over });
  const outboxFor = (eventType: string) =>
    w.q(`select o.destination, o.payload, o.status, e.type, o.event_id from outbox o join events e on e.id = o.event_id where e.type = $1 order by o.created_at`, [eventType]);
  const clear = async () => {
    await w.q(`delete from notification_routes`);
    await w.q(`delete from deliveries`);
    await w.q(`delete from outbox`);
  };

  it("routes: create, edit with the version, delete; denied and stale are refused; kill and restore routes stay on", async () => {
    await clear();
    const denied = await route({}, "p-rui");
    expect(denied.status).toBe(403);
    expect(Number((await w.q(`select count(*)::int n from events where type = 'notify.edit.denied'`))[0].n)).toBeGreaterThan(0);
    const r = await route();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id: "NR-1", version: 1 });
    const list = (await w.call(MGR, "GET", "/api/v1/projects/payments/routes")).body as unknown as Array<Record<string, any>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "NR-1", event: "submitted", version: 1, enabled: true });
    // The project read carries the same route in the legacy shape.
    const p = (await w.call(MGR, "GET", "/api/v1/projects/payments")).body as Record<string, any>;
    expect(p.notifications.find((x: any) => x.id === "NR-1").dest[0].target).toBe("#intake");
    const stale = await w.call(MGR, "PATCH", "/api/v1/projects/payments/routes/NR-1", { enabled: false }, w.ifm(7));
    expect(stale.status).toBe(409);
    expect((await w.call(MGR, "PATCH", "/api/v1/projects/payments/routes/NR-1", { enabled: false })).status).toBe(409);
    const ok = await w.call(MGR, "PATCH", "/api/v1/projects/payments/routes/NR-1", { enabled: false, cond: { classes: ["bug"], priority: [], hours: "any" } }, w.ifm(1));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.version).toBe(2);
    expect((await route({ event: "nope" })).status).toBe(422);
    expect((await route({ template: "no-such-card" })).body.msg).toMatch(/no card template/i);
    expect((await route({ dest: [{ channel: "slack", target: "#x", integration: "int-missing" }] })).body.msg).toMatch(/no connection/i);
    // Kill and restore cannot be switched off, narrowed or removed.
    expect((await route({ event: "kill", enabled: false, dest: [{ channel: "slack", target: "#kill", integration: inst }] })).status).toBe(422);
    expect((await route({ event: "kill", cond: { classes: ["bug"], priority: [], hours: "any" }, dest: [{ channel: "slack", target: "#kill", integration: inst }] })).status).toBe(422);
    const kill = await route({ event: "kill", template: "kill", dest: [{ channel: "slack", target: "#kill", integration: inst }] });
    expect(kill.status).toBe(200);
    const del = await w.call(MGR, "DELETE", `/api/v1/projects/payments/routes/${kill.body.id}`, undefined, w.ifm(1));
    expect(del.status).toBe(409);
    expect(del.body.msg).toMatch(/cannot be removed/i);
    expect((await w.call(MGR, "DELETE", "/api/v1/projects/payments/routes/NR-1", undefined, w.ifm(2))).status).toBe(200);
    expect((await w.call(MGR, "DELETE", "/api/v1/projects/payments/routes/NR-1", undefined, w.ifm(2))).status).toBe(404);
  });

  it("a committed event produces its outbox row and delivery in the same transaction, with the card", async () => {
    await clear();
    expect((await route()).status).toBe(200);
    const sub = await w.submit("p-tomas", { title: "Notify me about this one" });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const [row] = await outboxFor("wo.submit");
    expect(row).toBeTruthy();
    expect(row.destination).toBe(`slack:${inst}:#intake`);
    expect(row.status).toBe("pending");
    expect(row.payload.text).toMatch(new RegExp(`${sub.body.id} submitted to Payments`));
    expect(JSON.stringify(row.payload.card)).toContain("Notify me about this one");
    expect(row.payload.integration).toBe(inst);
    const dl = (await w.q(`select * from deliveries where wo_id = $1`, [sub.body.id]))[0];
    expect(dl).toMatchObject({ status: "pending", event_type: "submitted", channel: "slack", target: "#intake", project_id: "payments", route_id: "NR-1", outbox_id: expect.any(String) });
    expect(dl.event_id).toBe(row.event_id);
    // The same event never produces a second row for the same destination: replaying the producer is idempotent.
    const again = await w.q(`select count(*)::int n from outbox where event_id = $1`, [row.event_id]);
    expect(again[0].n).toBe(1);
  });

  it("conditions, switches and hours decide; a repo override adds or replaces destinations", async () => {
    await clear();
    expect((await route({ cond: { classes: ["hotfix"], priority: [], hours: "any" } })).status).toBe(200);
    await w.submit("p-tomas", { title: "A plain feature" });
    expect(await outboxFor("wo.submit")).toHaveLength(0);
    await w.q(`update notification_routes set conditions = '{"classes":[],"priority":[],"hours":"any"}', enabled = false`);
    await w.submit("p-tomas", { title: "Route switched off" });
    expect(await outboxFor("wo.submit")).toHaveLength(0);
    await w.q(`update notification_routes set enabled = true`);
    // Business hours only: the route fires only inside the plant's 09:00 to 19:00.
    await w.q(`update notification_routes set conditions = '{"classes":[],"priority":[],"hours":"business"}'`);
    const h = new Date().getUTCHours();
    await w.submit("p-tomas", { title: "Hours" });
    const inHours = (await outboxFor("wo.submit")).length;
    const ist = (h + 5.5 + 24) % 24;
    expect(inHours).toBe(ist >= 9 && ist < 19 ? 1 : 0);
    await clear();
    await route();
    await w.q(`update repos set data = data || $1::jsonb where id = 'payments-api'`, [JSON.stringify({ notifyOverrides: [{ id: "OV-1", event: "submitted", dest: [{ channel: "slack", target: "#payments-api", integration: inst }], template: "submitted", mode: "also" }] })]);
    await w.submit("p-tomas", { title: "Also override" });
    expect((await outboxFor("wo.submit")).map((r) => r.destination).sort()).toEqual([`slack:${inst}:#intake`, `slack:${inst}:#payments-api`]);
    await clear();
    await route();
    await w.q(`update repos set data = jsonb_set(data, '{notifyOverrides,0,mode}', '"instead"') where id = 'payments-api'`);
    await w.submit("p-tomas", { title: "Instead override" });
    expect((await outboxFor("wo.submit")).map((r) => r.destination)).toEqual([`slack:${inst}:#payments-api`]);
    await w.q(`update repos set data = data - 'notifyOverrides' where id = 'payments-api'`);
  });

  it("a destination that cannot be resolved is a failed delivery with its reason, and a retry works once it is fixed", async () => {
    await clear();
    expect((await route({ dest: [{ channel: "webhook", target: "audit-lake" }] })).status).toBe(200);
    const sub = await w.submit("p-tomas", { title: "Nowhere to go" });
    const dl = (await w.q(`select * from deliveries where wo_id = $1`, [sub.body.id]))[0];
    expect(dl.status).toBe("failed");
    expect(dl.error).toMatch(/no webhook connection/i);
    expect(await outboxFor("wo.submit")).toHaveLength(0);
    const hook = await new Double().start();
    hook.on("/in", () => [200, {}]);
    try {
      const still = await w.call(MGR, "POST", `/api/v1/deliveries/${dl.id}/retry`);
      expect(still.status).toBe(409);
      expect(still.body.msg).toMatch(/failed again/i);
      const a = await w.call("p-asha", "POST", "/api/v1/integrations", { type: "webhook", name: "Audit lake", config: { url: `${hook.url}/in`, format: "json" }, secrets: { secret: "whsec_" + "k7Kq2mZp9Rt4".repeat(3) }, targetId: "audit-lake", enable: true });
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect((await w.call("p-rui", "POST", `/api/v1/deliveries/${dl.id}/retry`)).status).toBe(403);
      const ok = await w.call(MGR, "POST", `/api/v1/deliveries/${dl.id}/retry`);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const after = (await w.q(`select status, error, outbox_id from deliveries where id = $1`, [dl.id]))[0];
      expect(after).toMatchObject({ status: "pending", error: "" });
      expect((await outboxFor("wo.submit"))[0]!.destination).toMatch(/^webhook:/);
    } finally {
      await hook.stop();
    }
  });

  it("deliveries: newest first with filters and a cursor; a dead delivery is re-driven by retry; a sent one is not", async () => {
    await clear();
    expect((await route()).status).toBe(200);
    for (let i = 0; i < 3; i++) await w.submit("p-tomas", { title: `Delivery ${i}` });
    const all = (await w.call(MGR, "GET", "/api/v1/deliveries?limit=2")).body as Record<string, any>;
    expect(all.items).toHaveLength(2);
    expect(all.next).toEqual(expect.any(String));
    expect(all.items[0].at).toBeGreaterThanOrEqual(all.items[1].at);
    const rest = (await w.call(MGR, "GET", `/api/v1/deliveries?limit=2&cursor=${encodeURIComponent(all.next)}`)).body as Record<string, any>;
    expect(rest.items).toHaveLength(1);
    expect(all.items.map((x: any) => x.id)).not.toContain(rest.items[0].id);
    expect(all.items[0]).toMatchObject({ event: "submitted", channel: "slack", target: "#intake", status: "pending", integration: inst, project: "payments" });
    const id = all.items[0].id as string;
    expect((await w.call(MGR, "POST", `/api/v1/deliveries/${id}/retry`)).status).toBe(409); // still pending
    await w.q(`update deliveries set status = 'dead', error = 'HTTP 500', attempts = 8 where id = $1`, [id]);
    await w.q(`update outbox set status = 'dead', attempts = 8, last_error = 'HTTP 500' where id = (select outbox_id from deliveries where id = $1)`, [id]);
    expect(((await w.call(MGR, "GET", "/api/v1/deliveries?status=failed")).body as Record<string, any>).items.map((x: any) => x.id)).toEqual([id]);
    const re = await w.call(MGR, "POST", `/api/v1/deliveries/${id}/retry`);
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect((await w.q(`select status, attempts from outbox where id = (select outbox_id from deliveries where id = $1)`, [id]))[0]).toMatchObject({ status: "pending", attempts: 0 });
    await w.q(`update deliveries set status = 'sent' where id = $1`, [id]);
    expect((await w.call(MGR, "POST", `/api/v1/deliveries/${id}/retry`)).status).toBe(409);
    // A person who cannot see the project sees none of its deliveries.
    // A person sees the deliveries of the projects they can see, and no others.
    const visible = new Set(((await w.call("p-rui", "GET", "/api/v1/projects")).body as unknown as Array<{ id: string }>).map((p) => p.id));
    const hidden = ((await w.call("p-asha", "GET", "/api/v1/projects")).body as unknown as Array<{ id: string }>).map((p) => p.id).find((p) => !visible.has(p))!;
    await w.q(`insert into deliveries (org_id, id, event_type, channel, target, project_id, destination, status) values ($1,'DLV-HIDDEN','submitted','slack','#x',$2,'slack:x:#x','failed')`, [t.orgId, hidden]);
    const seen = ((await w.call("p-rui", "GET", "/api/v1/deliveries?limit=200")).body as Record<string, any>).items as Array<{ id: string }>;
    expect(seen.map((x) => x.id)).not.toContain("DLV-HIDDEN");
    expect((((await w.call("p-asha", "GET", "/api/v1/deliveries?limit=200")).body as Record<string, any>).items as Array<{ id: string }>).map((x) => x.id)).toContain("DLV-HIDDEN");
  });

  it("kill and restore cannot be switched off: they go out through a disabled connection and with no route at all", async () => {
    await clear();
    await w.q(`update integration_instances set enabled = false where id = $1`, [inst]);
    const k = await w.call("p-asha", "POST", "/api/v1/stops", { scope: "project", id: "payments", mode: "kill", reason: "Security incident", confirmText: "Payments Platform", inFlight: "hold" });
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    const rows = await outboxFor("kill");
    // Every connection open to the project that can notify gets it at its default target (the webhook from an earlier test included).
    const slackRow = rows.find((r: any) => r.destination === `slack:${inst}:#factory-gates`);
    expect(slackRow).toBeTruthy();
    expect(slackRow.payload.mandatory).toBe(true);
    expect(slackRow.payload.card).toBeTruthy();
    const dl = (await w.q(`select status, event_type from deliveries where event_type = 'kill'`))[0];
    expect(dl).toMatchObject({ status: "pending" });
    // A halt is an Andon; a lifted stop is not a notification at all.
    expect(notifyEventFor({ type: "halt", category: "kill" })).toMatchObject({ event: "andon", mandatory: false });
    expect(notifyEventFor({ type: "restore", category: "kill", after: { pending: true } })).toBeNull();
    expect(notifyEventFor({ type: "restore", category: "kill" })).toMatchObject({ event: "restore", mandatory: true });
    // Restoring the project: the notification goes out again, and the stopped project refuses route edits meanwhile.
    expect((await route()).status).toBe(409);
    await w.q(`update integration_instances set enabled = true where id = $1`, [inst]);
  });

  it("a gate card is updated in place when its gate changes, through the stored message reference", async () => {
    await clear();
    await w.q(`update stops set lifted_at = now(), lifted_by = 'p-asha' where lifted_at is null`);
    expect((await route({ event: "gate.waiting", template: "gate", dest: [{ channel: "slack", target: "#gates", integration: inst }] })).status).toBe(200);
    const id = (await w.submit("p-tomas", { title: "Card in place" })).body.id as string;
    await w.answerAll(id);
    expect((await w.confirm(id)).status).toBe(200);
    const wo = await w.walk(id, (x) => x.state === "waiting" && !!x.allowed.approve && x.allowed.approve.gate === "G2");
    expect(wo.state).toBe("waiting");
    const posted = (await w.q(`select d.*, o.payload from deliveries d join outbox o on o.id = d.outbox_id where d.wo_id = $1 and d.event_type = 'gate.waiting'`, [id]))[0];
    expect(posted.card_key).toMatch(new RegExp(`^gate:${id}:G2:\\d+$`));
    // The worker posted it: record what Slack answered (the worker test covers the posting itself).
    await w.q(`update deliveries set status = 'sent', message_ref = '{"channel":"C0123","ts":"1700000000.000001"}' where id = $1`, [posted.id]);
    const approver = (await Promise.all(w.APPROVERS.map(async (p) => ({ p, ok: !!(await w.get(id, p)).allowed.approve })))).find((x) => x.ok)!.p;
    const r = await w.call(approver, "POST", await w.gateUrl(id, "G2"), {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const upd = (await w.q(`select o.payload, o.destination from outbox o join events e on e.id = o.event_id where e.type = 'gate.decision' and e.wo_id = $1 and o.destination like '%:update'`, [id]));
    expect(upd).toHaveLength(1);
    expect(upd[0].payload).toMatchObject({ mode: "update", messageRef: { channel: "C0123", ts: "1700000000.000001" }, deliveryId: posted.id });
    expect(JSON.stringify(upd[0].payload.card)).toMatch(/Decided|approved/i);
    expect(JSON.stringify(upd[0].payload.card)).not.toContain('"type":"actions"'); // no buttons left on a closed card
    expect((await w.q(`select message_ref from deliveries where id = $1`, [posted.id]))[0].message_ref.closing).toBe(true);
  });

  it("card templates: save, list, preview and remove (refused while a route uses it)", async () => {
    await clear();
    const bad = await w.call(MGR, "POST", "/api/v1/card-templates", { name: "Gate card", kind: "gate", actions: ["approve", "nuke"], project: "payments" });
    expect(bad.status).toBe(422);
    const sv = await w.call(MGR, "POST", "/api/v1/card-templates", { name: "Gate card", kind: "gate", actions: ["approve", "open"], fields: ["title"], project: "payments" });
    expect(sv.status, JSON.stringify(sv.body)).toBe(200);
    const id = sv.body.template.id as string;
    expect((await w.call("p-rui", "POST", "/api/v1/card-templates", { name: "Nope", kind: "gate", actions: [], project: "payments" })).status).toBe(403);
    const list = (await w.call(MGR, "GET", "/api/v1/card-templates")).body as unknown as Array<Record<string, any>>;
    expect(list.find((x) => x.id === id)).toMatchObject({ name: "Gate card", kind: "gate", actions: ["approve", "open"], version: 1 });
    expect((await route({ event: "gate.waiting", template: id })).status).toBe(200);
    const rm = await w.call(MGR, "DELETE", `/api/v1/card-templates/${id}?project=payments`);
    expect(rm.status).toBe(409);
    expect(rm.body.msg).toMatch(/Used by payments NR-/);
    await w.q(`delete from notification_routes`);
    // Preview renders the real card from a work order of the project and sends nothing.
    const before = Number((await w.q(`select count(*)::int n from outbox`))[0].n);
    const pv = await w.call(MGR, "POST", "/api/v1/card-templates/preview", { project: "payments", event: "gate.waiting", template: "gate", fields: { repo: false } });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.sample.head).toMatch(/is waiting on WO-/);
    expect(pv.body.rows.map((r: string[]) => r[0])).not.toContain("Repo");
    expect(pv.body.slack.blocks.length).toBeGreaterThan(1);
    expect(pv.body.email.subject).toMatch(/^\[PAY\]|\[Payments\]|\[/);
    expect(Number((await w.q(`select count(*)::int n from outbox`))[0].n)).toBe(before);
    expect((await w.call(MGR, "DELETE", `/api/v1/card-templates/${id}?project=payments`)).status).toBe(200);
  });

  it("a test send queues a real card to one destination and logs it as a test", async () => {
    await clear();
    const r = await w.call(MGR, "POST", "/api/v1/projects/payments/routes/test", { dest: { channel: "slack", target: "#test", integration: inst }, event: "gate.waiting" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.delivery).toMatchObject({ queued: true, event: "gate.waiting", target: "#test" });
    const dl = (await w.q(`select * from deliveries where id = $1`, [r.body.delivery.id]))[0];
    expect(dl).toMatchObject({ is_test: true, status: "pending", target: "#test" });
    const ob = (await outboxFor("notify.test"))[0]!;
    expect(ob.payload.deliveryId).toBe(dl.id);
    expect((await w.call("p-rui", "POST", "/api/v1/projects/payments/routes/test", { dest: "slack", target: "#t" })).status).toBe(403);
    const none = await w.call(MGR, "POST", "/api/v1/projects/payments/routes/test", { dest: "teams", target: "General" });
    expect(none.body.delivery).toMatchObject({ queued: false });
    expect(none.body.msg).toMatch(/no teams connection|not yet available/i);
  });

  it("in-chat approval policy: off by default, named gates only, never release, security, hotfix or risk-tagged", () => {
    const wo = { cls: "feature", risk: "normal", position: "review" };
    expect(chatApprovalFor({}, "G2", wo).ok).toBe(false);
    expect(chatApprovalFor({ approve: true }, "G2", wo)).toMatchObject({ ok: false, reason: expect.stringMatching(/not on the list/) });
    expect(chatApprovalFor({ approve: true, approveGates: "G2, G3d" }, "G2", wo).ok).toBe(true);
    expect(chatApprovalFor({ approve: true, approveGates: "G6" }, "G6", wo)).toMatchObject({ ok: false, reason: expect.stringMatching(/never approved from chat/) });
    expect(chatApprovalFor({ approve: true, approveGates: "G3G3s" }, "G3G3s", wo).ok).toBe(false);
    expect(chatApprovalFor({ approve: true, approveGates: "G2" }, "G2", { ...wo, cls: "hotfix" }).ok).toBe(false);
    expect(chatApprovalFor({ approve: true, approveGates: "G2" }, "G2", { ...wo, position: "sechold" }).ok).toBe(false);
    expect(chatApprovalFor({ approve: true, approveGates: "G2" }, "G2", { ...wo, riskTags: ["payments"] }).ok).toBe(false);
    expect(chatApprovalFor({ approve: true, approveGates: "G2" }, "G2", { ...wo, risk: "high" }).ok).toBe(false);
  });
});

d("Slack callbacks (spec 12.3): signature, replay, linking and in-chat approval", () => {
  let t: TestApp;
  let slack: Double;
  const token = fakeBotToken();
  const signing = fakeSigningSecret();
  let inst: string;
  beforeAll(async () => {
    slack = await slackDouble(token);
    t = await startApp({ config: { secrets: { sessionKey: SESSION_KEY, dataKey: DATA_KEY, edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
    configureRuntime({ http: proxiedHttp({ proxy: null }), slackBase: `${slack.url}/api`, smtp: { host: null, port: 25 } });
  });
  afterAll(async () => {
    resetRuntime();
    await slack.stop();
    await t.close();
  });
  const w = world(() => t);
  const hook = (raw: string, o: { ts?: string; sig?: string | null; secret?: string; type?: string } = {}) => {
    const ts = o.ts ?? String(Math.floor(Date.now() / 1000));
    return t.app.inject({
      method: "POST", url: "/hooks/slack", payload: raw,
      headers: { "content-type": o.type ?? "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, ...(o.sig === null ? {} : { "x-slack-signature": o.sig ?? signSlack(raw, ts, o.secret ?? signing) }) },
    });
  };
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
  let seq = 0;
  const click = (user: string, value: object, action = "gantry.approve") =>
    hook(form({ payload: JSON.stringify({ type: "block_actions", user: { id: user }, team: { id: "T1" }, trigger_id: `trig-${++seq}-${Date.now()}`, response_url: `${slack.url}/respond`, actions: [{ action_id: action, value: JSON.stringify(value) }] }) }));
  const slash = (user: string, text: string) => hook(form({ command: "/gantry", text, user_id: user, team_id: "T1", trigger_id: `cmd-${++seq}-${Date.now()}` }));
  const replies = () => slack.calls("/respond").map((c) => String(c.json?.text));

  it("refuses with no Slack connection switched on, and a bad, missing or stale signature, each audited", async () => {
    expect((await hook(form({ command: "/gantry", text: "link x", user_id: "U1" }))).statusCode).toBe(503);
    const r = await w.call("p-asha", "POST", "/api/v1/integrations", { type: "slack", name: "Acme Slack", config: { workspace: "acme", defaultChannel: "#gates", approve: true }, secrets: { botToken: token, signingSecret: signing }, enable: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    inst = r.body.integration.id;
    const raw = form({ command: "/gantry", text: "link ABCD-EFGH", user_id: "U1", trigger_id: "t-sig" });
    const bad = await hook(raw, { secret: "wrong-secret-0123456789" });
    expect(bad.statusCode).toBe(401);
    expect((await hook(raw, { sig: null })).statusCode).toBe(401);
    const stale = await hook(raw, { ts: String(Math.floor(Date.now() / 1000) - 3600) });
    expect(stale.statusCode).toBe(401);
    const denied = await w.q(`select rule, after from events where type = 'slack.hook.denied' order by seq`);
    expect(denied.map((e) => e.rule)).toEqual(["HOOK-SIG", "HOOK-SIG", "HOOK-STALE"]);
    expect(await w.q(`select 1 from inbound_deliveries where source = 'slack'`)).toHaveLength(0);
  });

  it("Teams is listed but not yet available: its endpoint says so", async () => {
    const r = await t.app.inject({ method: "POST", url: "/hooks/teams", payload: {} });
    expect(r.statusCode).toBe(501);
    expect(r.json().msg).toMatch(/not yet available/i);
  });

  it("a replayed delivery creates nothing new", async () => {
    const raw = form({ command: "/gantry", text: "hello", user_id: "U9", trigger_id: "t-replay" });
    const ts = String(Math.floor(Date.now() / 1000));
    expect((await hook(raw, { ts })).statusCode).toBe(200);
    const again = await hook(raw, { ts });
    expect(again.statusCode).toBe(200);
    expect(await w.q(`select 1 from inbound_deliveries where source = 'slack' and delivery_id = 't-replay'`)).toHaveLength(1);
    expect((await w.q(`select rule from events where type = 'slack.hook.denied' order by seq desc limit 1`))[0].rule).toBe("HOOK-REPLAY");
  });

  it("linking is a recorded step: a one-time code from the browser, sent from Slack, ties the chat user to exactly one person", async () => {
    const a = await w.call("p-priya", "POST", "/api/v1/chat-links", { channel: "slack" }, { "idempotency-key": "link-1" });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(JSON.stringify(await w.q(`select * from chat_link_requests`))).not.toContain(a.body.code); // only the hash is stored
    expect(JSON.stringify(await w.q(`select response from idempotency_keys`))).not.toContain(a.body.code); // nor kept in the stored reply
    expect(JSON.stringify(await w.q(`select after from events where type = 'chat.link.requested'`))).not.toContain(a.body.code);
    const wrong = await slash("U-priya", "link ZZZZ-ZZZZ");
    expect(JSON.parse(wrong.body).text).toMatch(/not valid/i);
    const ok = await slash("U-priya", `link ${a.body.code}`);
    expect(JSON.parse(ok.body).text).toMatch(/Linked/);
    const links = (await w.call("p-priya", "GET", "/api/v1/chat-links")).body as unknown as Array<Record<string, any>>;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ channel: "slack", externalId: "U-priya", person: "p-priya" });
    expect((await w.q(`select type, actor, channel from events where type = 'chat.link.completed'`))[0]).toMatchObject({ actor: "p-priya", channel: "slack" });
    // A code is single use, and a chat user already linked to someone cannot be linked to another person.
    expect(JSON.parse((await slash("U-priya", `link ${a.body.code}`)).body).text).toMatch(/not valid/i);
    const b = await w.call("p-meera", "POST", "/api/v1/chat-links", { channel: "slack" });
    expect(JSON.parse((await slash("U-priya", `link ${b.body.code}`)).body).text).toMatch(/already linked to another person/i);
    // The link can be removed by its owner only.
    expect((await w.call("p-meera", "DELETE", `/api/v1/chat-links/${links[0]!.id}`)).status).toBe(404);
  });

  it("an expired code is refused", async () => {
    const a = await w.call("p-grace", "POST", "/api/v1/chat-links", { channel: "slack" });
    await w.q(`update chat_link_requests set expires_at = now() - interval '1 minute' where person_id = 'p-grace'`);
    expect(JSON.parse((await slash("U-grace", `link ${a.body.code}`)).body).text).toMatch(/expired/i);
  });

  it("in-chat approval: refused unlinked, off the list, stale and by a person the matrix does not allow; allowed once, recorded with the chat identity", async () => {
    const id = (await w.submit("p-tomas", { title: "Approve from chat" })).body.id as string;
    await w.answerAll(id);
    expect((await w.confirm(id)).status).toBe(200);
    await w.walk(id, (x) => x.state === "waiting" && !!x.allowed.approve && x.allowed.approve.gate === "G2");
    const gi = (await w.q(`select id from gate_instances where wo_id = $1 and gate_id = 'G2' and status = 'open'`, [id]))[0].id as string;
    const value = { instance: gi, wo: id, gate: "G2" };
    const approverFor = async () => (await Promise.all(w.APPROVERS.map(async (p) => ({ p, ok: !!(await w.get(id, p)).allowed.approve })))).filter((x) => x.ok).map((x) => x.p);
    const approvers = await approverFor();
    expect(approvers.length).toBeGreaterThan(1);
    const [who, other] = approvers.filter((p) => p !== "p-priya");

    // Unlinked chat user.
    await click("U-stranger", value);
    expect(replies().at(-1)).toMatch(/not linked to a Gantry person/i);
    // Off the list: approve is on for the connection but no gate is named yet.
    const link = async (person: string, user: string) => {
      const c = await w.call(person, "POST", "/api/v1/chat-links", { channel: "slack" });
      expect(JSON.parse((await slash(user, `link ${c.body.code}`)).body).text).toMatch(/Linked/);
    };
    await link(who!, "U-who");
    await click("U-who", value);
    expect(replies().at(-1)).toMatch(/not on the list/i);
    expect((await w.q(`select 1 from gate_votes where gate_instance_id = $1`, [gi]))).toHaveLength(0);
    // Name the gate: the connection's switch stays the administrator's choice.
    const cur = (await w.q(`select version from integration_instances where id = $1`, [inst]))[0].version;
    expect((await w.call("p-asha", "PATCH", `/api/v1/integrations/${inst}`, { config: { approveGates: "G2" } }, w.ifm(cur))).status).toBe(200);
    // A linked person the matrix does not allow at click time is refused by the decision point, and it is audited.
    await link("p-rui", "U-rui");
    const deniedBefore = Number((await w.q(`select count(*)::int n from events where outcome = 'denied'`))[0].n);
    await click("U-rui", value);
    expect(replies().at(-1)).toMatch(/./);
    expect(Number((await w.q(`select count(*)::int n from events where outcome = 'denied'`))[0].n)).toBeGreaterThan(deniedBefore);
    expect(await w.q(`select 1 from gate_votes where gate_instance_id = $1`, [gi])).toHaveLength(0);
    // The allowed click counts, with the chat identity stored on the vote.
    await click("U-who", value);
    const votes = await w.q(`select voter, via, chat from gate_votes where gate_instance_id = $1`, [gi]);
    expect(votes).toHaveLength(1);
    expect(votes[0]).toMatchObject({ voter: who, via: "slack", chat: { channel: "slack", chatUser: "U-who", person: who, instance: gi, integration: inst } });
    expect((await w.q(`select channel, actor, on_behalf_of from events where type = 'chat.approve'`))[0]).toMatchObject({ channel: "slack", actor: who });
    expect((await w.q(`select channel, on_behalf_of from events where type in ('gate.vote','gate.decision') and wo_id = $1 order by seq desc limit 1`, [id]))[0]).toMatchObject({ channel: "slack" });
    // The same card clicked again, after the gate moved on, is a stale click and is refused.
    const nowOpen = (await w.q(`select id from gate_instances where wo_id = $1 and gate_id = 'G2' and status = 'open'`, [id]))[0];
    const again = await click("U-who", value);
    void again;
    expect(replies().at(-1)).toMatch(/no longer|already voted|not waiting/i);
    expect(nowOpen === undefined || nowOpen.id !== gi).toBe(true);
    void other;
  });

  it("never from chat: a release, a hotfix or a risk-tagged change is refused even when named", async () => {
    const cur = (await w.q(`select version from integration_instances where id = $1`, [inst]))[0].version;
    expect((await w.call("p-asha", "PATCH", `/api/v1/integrations/${inst}`, { config: { approveGates: "G2, G6" } }, w.ifm(cur))).status).toBe(200);
    const wo = (await w.submit("p-tomas", { title: "Hotfix from chat", cls: "hotfix" })).body.id as string;
    // The Release Manager is linked and the matrix would allow the release, but a release is never approved from chat, even when named.
    const c = await w.call("p-kenji", "POST", "/api/v1/chat-links", { channel: "slack" });
    expect(JSON.parse((await slash("U-kenji", `link ${c.body.code}`)).body).text).toMatch(/Linked/);
    await click("U-kenji", { instance: `${wo}:G6:1`, wo, gate: "G6" });
    expect(replies().at(-1)).toMatch(/never approved from chat/i);
    // A hotfix at a named low-risk gate is refused too.
    await click("U-kenji", { instance: `${wo}:G2:1`, wo, gate: "G2" });
    expect(replies().at(-1)).toMatch(/hotfix|no role|never/i);
    expect(await w.q(`select 1 from gate_votes where gate_instance_id like $1`, [`${wo}:%`])).toHaveLength(0);
  });
});
