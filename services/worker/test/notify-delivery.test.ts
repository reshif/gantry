import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { appendEvent, encrypt, enqueueOutbox, withTx } from "@gantry/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_URL } from "./db.js";
import { FakeEndpoint } from "./doubles.js";
import { startWorld, type World } from "./world.js";

const d = TEST_URL ? describe : describe.skip;
const DATA_KEY = randomBytes(32);
const TOKEN = "xoxb" + "-" + "1".repeat(12) + "-" + "a".repeat(24);

/** A Slack Web API double: chat.postMessage and chat.update with a bot token. Test code only. */
class SlackDouble {
  calls: Array<{ path: string; auth: string; json: Record<string, any> }> = [];
  server!: http.Server;
  port = 0;
  n = 0;
  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const json = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, any>;
        this.calls.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? ""), json });
        res.writeHead(200, { "content-type": "application/json" });
        const ok = this.calls.at(-1)!.auth === `Bearer ${TOKEN}`;
        if (!ok) return void res.end(JSON.stringify({ ok: false, error: "invalid_auth" }));
        if (json.channel === "#nope") return void res.end(JSON.stringify({ ok: false, error: "channel_not_found" }));
        if (json.channel === "#slow") return void res.end(JSON.stringify({ ok: false, error: "ratelimited" }));
        this.n += 1;
        res.end(JSON.stringify({ ok: true, channel: "C0123", ts: req.url?.endsWith("chat.update") ? json.ts : `1700000000.00000${this.n}` }));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  stop = (): Promise<void> => new Promise((r) => this.server.close(() => r()));
}

d("notification delivery (spec 12.2): producer, outbox, Slack bot API, delivery log", () => {
  let w: World;
  let slack: SlackDouble;
  beforeEach(async () => {
    slack = await new SlackDouble().start();
    process.env.GANTRY_SLACK_API = `http://127.0.0.1:${slack.port}/api`;
    w = await startWorld({ cfg: { dataKey: DATA_KEY } });
    await w.q(`delete from notification_routes`);
    await w.q(`insert into integration_types (org_id, id, name, builtin, field_schema, data) values ($1,'slack','Slack',true,'[]','{"destination":true}') on conflict do nothing`, [w.orgId]);
    await w.q(`insert into integration_instances (org_id, id, type_id, name, enabled, config, secret_enc) values ($1,'int-slack','slack','Acme Slack',true,$2::jsonb,$3)`, [
      w.orgId, JSON.stringify({ workspace: "acme", defaultChannel: "#ops", _meta: { projects: "all" } }), encrypt(JSON.stringify({ botToken: TOKEN, signingSecret: "s".repeat(24) }), DATA_KEY, "integration:int-slack"),
    ]);
  });
  afterEach(async () => {
    delete process.env.GANTRY_SLACK_API;
    await slack.stop();
    await w.close();
  });

  const route = (n: number, event: string, target: string, over: { template?: string } = {}) =>
    w.q(`insert into notification_routes (org_id, id, project_id, event, destinations, template) values ($1,$2,'payments',$3,$4::jsonb,$5)`, [w.orgId, `payments:NR-${n}`, event, JSON.stringify([{ channel: "slack", target, integration: "int-slack" }]), over.template ?? ""]);
  const emit = (type: string, o: { category?: "flow" | "approvals" | "integrations"; after?: object; outcome?: "ok" | "failed" } = {}) =>
    withTx(w.db.app, async (tx) => (await appendEvent(tx, { orgId: w.orgId, type, category: o.category ?? "flow", actor: "p-tomas", channel: "web", projectId: "payments", outcome: o.outcome ?? "ok", after: o.after ?? { text: "Refund retries" } })).id);

  it("an appended event produces its card, the worker posts it with the bot token, and the message reference is stored", async () => {
    await route(1, "submitted", "#intake");
    const e = await emit("wo.submit");
    const ob = (await w.q(`select * from outbox where event_id = $1`, [e]))[0];
    expect(ob.destination).toBe("slack:int-slack:#intake");
    await w.worker.outbox.drain();
    const post = slack.calls.find((c) => c.path === "/api/chat.postMessage")!;
    expect(post.auth).toBe(`Bearer ${TOKEN}`);
    expect(post.json.channel).toBe("#intake");
    expect(JSON.stringify(post.json.blocks)).toContain("submitted to");
    const dl = (await w.q(`select * from deliveries where event_id = $1`, [e]))[0];
    expect(dl).toMatchObject({ status: "sent", attempts: 1, response_status: 200, error: "", message_ref: { channel: "C0123", ts: "1700000000.000001" } });
    expect((await w.q(`select status from outbox where id = $1`, [ob.id]))[0].status).toBe("delivered");
  });

  it("a card is updated in place through its stored message reference", async () => {
    await route(1, "submitted", "#intake");
    const e = await emit("wo.submit");
    await w.worker.outbox.drain();
    const dl = (await w.q(`select id, message_ref from deliveries where event_id = $1`, [e]))[0];
    const e2 = await emit("gate.decision", { category: "approvals", after: { gate: "G2", by: "p-meera", text: "approved" } });
    await enqueueOutbox(w.db.app, { orgId: w.orgId, eventId: e2, destination: "slack:int-slack:#intake:update", payload: { integration: "int-slack", target: "#intake", mode: "update", messageRef: dl.message_ref, deliveryId: dl.id, text: "Gate approved", card: [{ type: "section", text: { type: "mrkdwn", text: "*Approved*" } }] } });
    await w.worker.outbox.drain();
    const upd = slack.calls.find((c) => c.path === "/api/chat.update")!;
    expect(upd.json).toMatchObject({ channel: "C0123", ts: "1700000000.000001", text: "Gate approved" });
    expect((await w.q(`select message_ref, status from deliveries where id = $1`, [dl.id]))[0]).toMatchObject({ status: "sent", message_ref: { channel: "C0123", ts: "1700000000.000001", updated: true } });
  });

  it("a permanent failure is dead at once, logged with its reason, and is itself a notification; a delivery failure never undoes the event", async () => {
    await route(1, "submitted", "#nope");
    await route(2, "delivery.failed", "#ops");
    const e = await emit("wo.submit");
    await w.worker.outbox.drain();
    const dl = (await w.q(`select * from deliveries where event_id = $1`, [e]))[0];
    expect(dl.status).toBe("dead");
    expect(dl.error).toMatch(/channel_not_found/);
    expect((await w.q(`select status from outbox where event_id = $1`, [e]))[0].status).toBe("dead");
    expect((await w.q(`select 1 from events where id = $1`, [e]))).toHaveLength(1);
    const fail = (await w.q(`select id, after from events where type = 'delivery.failed'`))[0];
    expect(fail.after).toMatchObject({ delivery: dl.id, origEvent: "submitted" });
    await w.worker.outbox.drain();
    const notice = slack.calls.filter((c) => c.path === "/api/chat.postMessage" && c.json.channel === "#ops");
    expect(notice).toHaveLength(1);
    expect(JSON.stringify(notice[0]!.json.blocks)).toContain("could not be delivered");
  });

  it("a rate limit is retried with backoff and the log shows the attempt; a dead delivery that fails again does not loop", async () => {
    await route(1, "submitted", "#slow");
    const e = await emit("wo.submit");
    await w.worker.outbox.drain();
    const dl = (await w.q(`select status, attempts, error from deliveries where event_id = $1`, [e]))[0];
    expect(dl).toMatchObject({ status: "failed", attempts: 1 });
    expect(dl.error).toMatch(/ratelimited/);
    expect((await w.q(`select status, attempts from outbox where event_id = $1`, [e]))[0]).toMatchObject({ status: "pending", attempts: 1 });
    // A delivery-failure notice that itself dies must not notify again.
    await route(2, "delivery.failed", "#nope");
    await w.q(`update outbox set max_attempts = 1, next_attempt_at = now() where event_id = $1`, [e]);
    await w.worker.outbox.drain();
    await w.worker.outbox.drain();
    await w.worker.outbox.drain();
    expect(Number((await w.q(`select count(*)::int n from events where type = 'delivery.failed'`))[0].n)).toBe(1);
  });

  it("an email connection with its own SMTP settings sends from its own address", async () => {
    await w.q(`insert into integration_types (org_id, id, name, builtin, field_schema, data) values ($1,'email','Email',true,'[]','{"destination":true}') on conflict do nothing`, [w.orgId]);
    await w.q(`insert into integration_instances (org_id, id, type_id, name, enabled, config) values ($1,'int-mail','email','Ops mail',true,$2::jsonb)`, [w.orgId, JSON.stringify({ from: "ops@acme.test", smtpHost: "127.0.0.1", smtpPort: w.smtp.port, _meta: { projects: "all" } })]);
    const e = await emit("wo.submit");
    await enqueueOutbox(w.db.app, { orgId: w.orgId, eventId: e, destination: "smtp:int-mail:project admins", payload: { integration: "int-mail", to: ["asha@acme.test"], subject: "[PAY] submitted", text: "hello", deliveryId: "DLV-1" } });
    await w.worker.outbox.drain();
    expect(w.smtp.mails).toHaveLength(1);
    expect(w.smtp.mails[0]!.data).toContain("From: ops@acme.test");
  });

  it("a custom type sends its rendered template, signed with its one secret", async () => {
    const hook = await new FakeEndpoint().start();
    try {
      await w.q(`insert into integration_types (org_id, id, name, builtin, field_schema, data) values ($1,'audit-lake','Audit lake',false,$2::jsonb,'{"destination":true}')`, [w.orgId, JSON.stringify([{ key: "endpoint", label: "Endpoint", type: "url", required: true }, { key: "signKey", label: "Signing key", type: "secret", required: true }])]);
      await w.q(`insert into integration_instances (org_id, id, type_id, name, enabled, config, secret_enc) values ($1,'int-lake','audit-lake','Lake',true,$2::jsonb,$3)`, [w.orgId, JSON.stringify({ endpoint: `http://127.0.0.1:${hook.port}/in`, _meta: { projects: "all" } }), encrypt(JSON.stringify({ signKey: "whsec_" + "z".repeat(20) }), DATA_KEY, "integration:int-lake")]);
      const e = await emit("wo.submit");
      await enqueueOutbox(w.db.app, { orgId: w.orgId, eventId: e, destination: "webhook:int-lake:", payload: { integration: "int-lake", body: '{"text":"WO-1 submitted"}', contentType: "application/json", method: "POST", deliveryId: "DLV-2" } });
      await w.worker.outbox.drain();
      const got = hook.received[0]!;
      expect(got.body).toBe('{"text":"WO-1 submitted"}');
      const sig = String(got.headers["x-gantry-signature"]);
      const [t, v1] = [/t=(\d+)/.exec(sig)![1]!, /v1=([0-9a-f]+)/.exec(sig)![1]!];
      expect(v1).toBe(createHmac("sha256", "whsec_" + "z".repeat(20)).update(`${t}.${got.body}`).digest("hex"));
    } finally {
      await hook.stop();
    }
  });

  it("a switched-off connection is not sent to, and the delivery log says why", async () => {
    await route(1, "submitted", "#intake");
    await w.q(`update integration_instances set enabled = false where id = 'int-slack'`);
    const e = await emit("wo.submit");
    // Switched off before the producer ran: logged as failed with the reason, no outbox row.
    expect((await w.q(`select status, error from deliveries where event_id = $1`, [e]))[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/switched off/) });
    expect(await w.q(`select 1 from outbox where event_id = $1`, [e])).toHaveLength(0);
    expect(slack.calls).toHaveLength(0);
  });
});
