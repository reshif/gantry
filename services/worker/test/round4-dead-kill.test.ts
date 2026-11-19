import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { appendEvent, encrypt, withTx } from "@gantry/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_URL } from "./db.js";
import { startWorld, type World } from "./world.js";

const d = TEST_URL ? describe : describe.skip;
const DATA_KEY = randomBytes(32);
const TOKEN = "xoxb" + "-" + "2".repeat(12) + "-" + "b".repeat(24);

/** S-37: a kill notice that fails every attempt is tried on another channel, then the Factory Admins. A Slack double that always refuses the channel. */
d("round 4: a dead kill notice is tried on another channel (S-37)", () => {
  let w: World;
  let slack: http.Server;
  beforeEach(async () => {
    slack = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "channel_not_found" }));
      });
    });
    await new Promise<void>((r) => slack.listen(0, "127.0.0.1", r));
    process.env.GANTRY_SLACK_API = `http://127.0.0.1:${(slack.address() as AddressInfo).port}/api`;
    w = await startWorld({ cfg: { dataKey: DATA_KEY } });
    await w.q(`delete from notification_routes`);
    await w.q(`insert into integration_types (org_id, id, name, builtin, field_schema, data) values ($1,'slack','Slack',true,'[]','{"destination":true}') on conflict do nothing`, [w.orgId]);
    await w.q(`insert into integration_types (org_id, id, name, builtin, field_schema, data) values ($1,'email','Email',true,'[]','{"destination":true}') on conflict do nothing`, [w.orgId]);
    await w.q(`insert into integration_instances (org_id, id, type_id, name, enabled, config, secret_enc) values ($1,'int-slack','slack','Acme Slack',true,$2::jsonb,$3)`, [
      w.orgId, JSON.stringify({ workspace: "acme", defaultChannel: "#nope", _meta: { projects: "all" } }), encrypt(JSON.stringify({ botToken: TOKEN, signingSecret: "s".repeat(24) }), DATA_KEY, "integration:int-slack"),
    ]);
    await w.q(`insert into integration_instances (org_id, id, type_id, name, enabled, config) values ($1,'int-mail','email','Ops mail',true,$2::jsonb)`, [w.orgId, JSON.stringify({ from: "ops@acme.test", smtpHost: "127.0.0.1", smtpPort: w.smtp.port, _meta: { projects: "all" } })]);
  });
  afterEach(async () => {
    delete process.env.GANTRY_SLACK_API;
    await new Promise<void>((r) => slack.close(() => r()));
    await w.close();
  });

  it("a kill whose only route dies is sent to the Factory Admins by email; a second death does not loop", async () => {
    await w.q(`insert into notification_routes (org_id, id, project_id, event, destinations, template) values ($1,'payments:NR-1','payments','kill',$2::jsonb,'kill')`, [w.orgId, JSON.stringify([{ channel: "slack", target: "#nope", integration: "int-slack" }])]);
    const e = await withTx(w.db.app, async (tx) => (await appendEvent(tx, { orgId: w.orgId, type: "kill", category: "kill", actor: "p-asha", channel: "web", projectId: "payments", outcome: "ok", after: { text: "Security incident", scope: "project" } })).id);
    await w.worker.outbox.drain();
    await w.worker.outbox.drain();
    await w.worker.outbox.drain();
    expect((await w.q(`select status from deliveries where event_id = $1 and channel = 'slack'`, [e]))[0].status).toBe("dead");
    expect(w.smtp.mails.length).toBeGreaterThanOrEqual(1);
    const mail = w.smtp.mails.find((m) => m.data.includes("asha@acme.dev"));
    expect(mail, "the Factory Admins were emailed the kill").toBeTruthy();
    expect(mail!.data).toMatch(/Kill switch pulled/);
    // Two separate emails: the on-call page (sent at the kill) and the S-37 retry of the dead Slack notice to the Factory Admins. Nobody gets both.
    const sent = await w.q(`select status, event_type, coalesce(request->>'page', 'false') as page from deliveries where event_id = $1 and channel = 'email' order by page`, [e]);
    expect(sent).toEqual([{ status: "sent", event_type: "kill", page: "false" }, { status: "sent", event_type: "kill", page: "true" }]);
    const to = w.smtp.mails.map((m) => ((m.data.match(/^To: (.*)$/m) || ["", ""])[1] ?? "").split(/,\s*/)).flat();
    expect(new Set(to).size, "no address is emailed twice for one kill").toBe(to.length);
    expect(Number((await w.q(`select count(*)::int n from events where type = 'delivery.failed'`))[0].n)).toBe(1);
  });
});
