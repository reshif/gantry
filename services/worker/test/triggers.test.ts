import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler.js";
import { TEST_URL } from "./db.js";
import { startWorld, type World } from "./world.js";

const d = TEST_URL ? describe : describe.skip;
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

d("triggers in the worker (spec 11.7)", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    await w.q(`insert into integration_types (org_id, id, name, builtin, field_schema, data) values ($1,'github','GitHub',true,'[]','{"source":true}')`, [w.orgId]);
    await w.q(`insert into integration_instances (org_id, id, type_id, name, enabled, config) values ($1,'gh-1','github','Acme GitHub',true,'{}')`, [w.orgId]);
    await w.q(`update people set github_login = 'tomas-acme' where id = 'p-tomas'`);
    await w.q(`update orgs set settings = jsonb_set(settings, '{api}', '{"triggersEnabled": true, "version": 1}') where id = $1`, [w.orgId]);
  });
  afterEach(async () => {
    await w.close();
  });
  const trigger = (id: string, kind: string, config: Record<string, unknown>, o: { next?: string } = {}) =>
    w.q(`insert into triggers (org_id, id, project_id, kind, name, enabled, config, next_run_at, created_by) values ($1,$2,'payments',$3,$4,true,$5::jsonb,$6,'p-asha')`, [w.orgId, id, kind, `Trigger ${id}`, JSON.stringify({ source: "gh-1", dedupe: true, who: "org", reply: "", ...config }), o.next ?? null]);
  const delivery = async (id: string, event: string, payload: object) => {
    const raw = Buffer.from(JSON.stringify(payload));
    await w.q(`insert into github_blobs (org_id, hash, kind, content, size_bytes) values ($1,$2,'payload',$3,$4)`, [w.orgId, sha(raw), raw, raw.length]);
    await w.q(`insert into inbound_deliveries (org_id, id, source, delivery_id, event_type, payload_hash) values ($1,$2,'github',$3,$4,$5)`, [w.orgId, `gh-${id}`, id, event, sha(raw)]);
    await w.enqueue("github.event", { deliveryId: id }, { dedupeKey: `github.event:${id}` });
  };
  const comment = (id: number, body: string, login = "tomas-acme") => ({
    action: "created", repository: { full_name: "acme/payments-api", default_branch: "main" }, issue: { number: 7, title: "Refund PR", pull_request: {} }, comment: { id, body, user: { login, type: "User" } },
  });

  it("a PR comment webhook becomes a work order through github.event, then trigger.evaluate; a replay of the same comment makes nothing new", async () => {
    await trigger("TR-1", "comment", { command: "/factory fix" });
    await delivery("d-1", "issue_comment", comment(501, "/factory fix the flaky ledger test"));
    await w.drain();
    const jobs = await w.jobs();
    expect(jobs.map((j) => j.kind).sort()).toEqual(["github.event", "trigger.evaluate"]);
    expect(jobs.every((j) => j.status === "done")).toBe(true);
    const wo = (await w.q(`select * from work_orders where title = 'the flaky ledger test'`))[0];
    expect(wo).toMatchObject({ source: "github", submitter: "p-tomas", project_id: "payments" });
    expect((await w.q(`select * from events where type = 'wo.submit' and wo_id = $1`, [wo.id]))[0]).toMatchObject({ actor: "trigger:TR-1", channel: "github" });
    expect((await w.q(`select outcome from trigger_runs`))).toEqual([{ outcome: "created" }]);
    // The same comment again under another delivery id (a redelivery with a new id): the event's identity dedupes it per trigger.
    await delivery("d-2", "issue_comment", { ...comment(501, "/factory fix the flaky ledger test"), sender: { login: "redelivered" } });
    await w.drain();
    expect((await w.q(`select 1 from work_orders where title = 'the flaky ledger test'`))).toHaveLength(1);
    expect((await w.q(`select outcome from trigger_runs`))).toEqual([{ outcome: "created" }]);
  });

  it("a comment from someone who does not map to a person is held as a proposal; a plain comment and a bot's comment do nothing", async () => {
    await trigger("TR-1", "comment", { command: "/factory fix" });
    await delivery("d-3", "issue_comment", comment(601, "/factory fix something", "stranger"));
    await delivery("d-4", "issue_comment", comment(602, "thanks, merging", "tomas-acme"));
    await delivery("d-5", "issue_comment", { ...comment(603, "/factory fix loop"), comment: { id: 603, body: "/factory fix loop", user: { login: "gantry[bot]", type: "Bot" } } });
    await w.drain();
    expect((await w.q(`select 1 from work_orders where source = 'github'`))).toHaveLength(0);
    expect((await w.q(`select title, actor, status from trigger_proposals`))).toEqual([{ title: "something", actor: "stranger", status: "held" }]);
    expect((await w.q(`select outcome from trigger_runs`))).toEqual([{ outcome: "held" }]);
  });

  it("a schedule that came due is ticked by the scheduler once, however many workers tick, and the tick creates the work", async () => {
    await trigger("TR-2", "schedule", { source: "schedule", schedule: "Mon 06:00 IST", title: "Weekly dependency updates", who: "system" }, { next: new Date(Date.now() - 60_000).toISOString() });
    const s1 = new Scheduler(w.deps);
    const s2 = new Scheduler({ ...w.deps, workerId: "b" });
    await Promise.all([s1.tick(), s2.tick()]);
    expect((await w.jobs("trigger.tick"))).toHaveLength(1);
    expect((await w.q(`select next_run_at > now() as later from triggers where id = 'TR-2'`))[0].later).toBe(true);
    await w.drain();
    expect((await w.jobs("trigger.tick"))[0]?.status).toBe("done");
    const wo = (await w.q(`select * from work_orders where title = 'Weekly dependency updates'`))[0];
    expect(wo).toMatchObject({ source: "schedule", submitter: "p-asha" });
    expect((await w.q(`select * from events where type = 'wo.submit' and wo_id = $1`, [wo.id]))[0]).toMatchObject({ actor: "trigger:TR-2", channel: "schedule" });
    // Nothing more is due.
    await s1.tick();
    expect((await w.jobs("trigger.tick"))).toHaveLength(1);
  });

  it("with the organisation switch off a due schedule is moved on but creates nothing", async () => {
    await w.q(`update orgs set settings = jsonb_set(settings, '{api,triggersEnabled}', 'false') where id = $1`, [w.orgId]);
    await trigger("TR-2", "schedule", { source: "schedule", schedule: "Daily 06:00 UTC", who: "system" }, { next: new Date(Date.now() - 60_000).toISOString() });
    await new Scheduler(w.deps).tick();
    await w.drain();
    expect((await w.q(`select 1 from work_orders where source = 'schedule'`))).toHaveLength(0);
    expect((await w.q(`select 1 from trigger_runs`))).toHaveLength(0);
    expect((await w.q(`select next_run_at > now() as later from triggers where id = 'TR-2'`))[0].later).toBe(true);
  });
});
