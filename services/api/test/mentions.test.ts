import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureConsoleEdge, resetConsoleEdge } from "../src/areas/console/model.js";
import { configureSessionBroker, resetSessionBroker } from "../src/areas/onboarding/session/broker.js";
import { configureRuntime, resetRuntime } from "../src/areas/integrations/runtime.js";
import { proxiedHttp } from "../src/areas/notifications/http.js";
import { registerNotificationProducer, unregisterNotificationProducer } from "../src/areas/notifications/producer.js";
import { RepoFacts } from "@gantry/domain";
import { FakeEdge } from "./console-edge.js";
import { world } from "./flow-helpers.js";
import { TEST_URL, SESSION_KEY, startApp, type TestApp } from "./helpers.js";
import { Double, fakeBotToken, fakeSigningSecret, slackDouble } from "./notify-doubles.js";

const d = TEST_URL ? describe : describe.skip;
const tomas = "p-tomas"; // engineer on payments: submits, may talk on the work order
const rui = "p-rui"; // viewer on payments: reads, cannot talk
const lena = "p-lena"; // no access to payments
const daniel = "p-daniel"; // project admin on payments
const DATA_KEY = randomBytes(32);

d("@mentioning a person in a work-order session", () => {
  let t: TestApp;
  let slack: Double;
  let inst: string;
  const edge = new FakeEdge();
  const token = fakeBotToken();
  let n = 0;
  const w = world(() => t);
  const q = w.q;
  const url = (id: string, tail = "") => `/api/v1/work-orders/${id}/session${tail}`;
  const call = async (who: string, method: "GET" | "POST", u: string, payload?: unknown) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method, url: u, headers: { ...s.headers, "idempotency-key": `k-${++n}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
    const sse = String(r.headers["content-type"] ?? "").includes("text/event-stream");
    return { status: r.statusCode, body: sse ? ({} as Record<string, any>) : (r.json() as Record<string, any>) };
  };
  const facts = () => RepoFacts.parse({ repo: "acme/payments-api", defaultBranch: "main", headSha: "a".repeat(40), language: "TypeScript", files: ["package.json"], contents: { "package.json": "{}" }, secrets: { scanned: 1, complete: true, hits: [] }, protection: null });

  beforeAll(async () => {
    await edge.start();
    configureConsoleEdge({ baseUrl: edge.url });
    configureSessionBroker(async () => ({ ok: true, facts: facts() }));
    slack = await slackDouble(token);
    t = await startApp({ config: { secrets: { sessionKey: SESSION_KEY, dataKey: DATA_KEY, edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
    configureRuntime({ http: proxiedHttp({ proxy: null }), slackBase: `${slack.url}/api`, smtp: { host: null, port: 25 } });
    registerNotificationProducer({ publicUrl: "https://gantry.test", onError: (e, ev) => console.error("PRODUCER", ev.type, e) });
    const r = await w.call("p-asha", "POST", "/api/v1/integrations", { type: "slack", name: "Acme Slack", config: { workspace: "acme", defaultChannel: "#factory-gates" }, secrets: { botToken: token, signingSecret: fakeSigningSecret() }, projects: "all", enable: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    inst = r.body.integration.id;
  });
  afterAll(async () => {
    unregisterNotificationProducer();
    resetRuntime();
    resetConsoleEdge();
    resetSessionBroker();
    await edge.stop();
    await slack.stop();
    await t.close();
  });
  beforeEach(async () => {
    edge.reset();
    await q(`delete from notification_routes`);
    await q(`delete from deliveries`);
    await q(`delete from outbox`);
    await q(`delete from access_requests`);
    await q(`delete from workorder_mentions`);
  });
  afterEach(async () => { await q(`delete from stops where org_id = $1`, [t.orgId]); });

  const submit = async () => {
    const r = await w.submit(tomas);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  };
  const say = async (id: string, text: string, mentions: string[]) => {
    edge.script = [{ blocks: [{ type: "text", text: "Noted." }] }];
    const r = await call(tomas, "POST", url(id, "/messages"), { text, mentions });
    expect(r.status).toBe(200);
  };
  const route = () => w.call(daniel, "POST", "/api/v1/projects/payments/routes", { event: "mention", dest: [{ channel: "slack", target: "#mentions", integration: inst }], template: "submitted" });
  const rolesOf = async (p: string) => Number((await q(`select count(*)::int n from effective_role_assignments where org_id = $1 and person_id = $2 and revoked_at is null`, [t.orgId, p]))[0].n);

  it("offers people to mention, saying who cannot read the project; only someone who may talk can ask", async () => {
    const id = await submit();
    const l = await call(tomas, "GET", url(id, "/people?q=len"));
    expect(l.status).toBe(200);
    expect(l.body.people).toEqual([expect.objectContaining({ id: lena, access: false })]);
    const r = await call(tomas, "GET", url(id, "/people?q=rui"));
    expect(r.body.people.find((p: any) => p.id === rui)).toMatchObject({ access: true });
    expect(r.body.people.some((p: any) => p.id === tomas)).toBe(false);
    expect((await call(lena, "GET", url(id, "/people?q=rui"))).status).toBe(404);
    expect((await call(rui, "GET", url(id, "/people?q=tom"))).status).toBe(403);
    expect((await call(tomas, "GET", url(id, "/people?q="))).status).toBe(422);
  });

  it("notifies a person with access through the project's mention routes and the inbox; nothing is requested", async () => {
    { const rr = await route(); expect(rr.status, JSON.stringify(rr.body)).toBe(200); }
    const id = await submit();
    await say(id, "@Rui can you look at this?", [rui]);
    const rows = await q(`select person_id, has_access from workorder_mentions where wo_id = $1`, [id]);
    expect(rows).toEqual([{ person_id: rui, has_access: true }]);
    expect(Number((await q(`select count(*)::int n from access_requests`))[0].n)).toBe(0);
    const ob = await q(`select o.destination, o.payload from outbox o join events e on e.id = o.event_id where e.type = 'wo.mention'`);
    expect(ob).toHaveLength(1);
    expect(ob[0].destination).toMatch(/^slack:/);
    const home = (await call(rui, "GET", "/api/v1/home")).body;
    const mine = (home.conversations ?? home.waiting?.conversations ?? []).find((c: any) => c.wo === id);
    expect(mine?.question).toMatch(/mentioned you/);
    await call(rui, "POST", url(id, "/seen"));
    const home2 = (await call(rui, "GET", "/api/v1/home")).body;
    expect((home2.conversations ?? home2.waiting?.conversations ?? []).some((c: any) => c.wo === id)).toBe(false);
    const s = (await call(tomas, "GET", url(id))).body;
    expect(s.messages.find((m: any) => m.role === "user" && /@Rui/.test(m.text)).data.mentions).toEqual([{ id: rui, name: expect.any(String), access: true }]);
    expect(Number((await q(`select count(*)::int n from events where type = 'wo.mention' and outcome = 'ok'`))[0].n)).toBe(1);
  });

  it("never grants access: a person without read access gets nothing from the routes, an access request opens for the project admin, who can dismiss it", async () => {
    { const rr = await route(); expect(rr.status, JSON.stringify(rr.body)).toBe(200); }
    const id = await submit();
    const before = await rolesOf(lena);
    await say(id, "@Lena please join", [lena]);
    expect(await rolesOf(lena)).toBe(before);
    expect((await call(lena, "GET", url(id))).status).toBe(404);
    expect((await call(lena, "GET", `/api/v1/home`)).body.conversations ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ wo: id })]));
    // The project's mention route (a channel everyone on the project reads) did not carry it.
    expect(await q(`select 1 from outbox o join events e on e.id = o.event_id where e.type = 'wo.mention'`)).toHaveLength(0);
    expect(Number((await q(`select count(*)::int n from events where type = 'access.request' and category = 'access'`))[0].n)).toBe(1);
    // The admin sees the request; someone without the right sees none (and a named project is refused).
    const list = await call(daniel, "GET", "/api/v1/access-requests?project=payments");
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([expect.objectContaining({ person: lena, project: "payments", wo: id, by: tomas })]);
    expect((await call(tomas, "GET", "/api/v1/access-requests?project=payments")).status).toBe(403);
    expect((await call(rui, "GET", "/api/v1/access-requests")).body.items).toEqual([]);
    const att = (await call(daniel, "GET", "/api/v1/home")).body;
    expect(JSON.stringify(att)).toMatch(/cannot open/);
    // A second mention does not pile up requests.
    await say(id, "@Lena again", [lena]);
    expect((await call(daniel, "GET", "/api/v1/access-requests?project=payments")).body.items).toHaveLength(1);
    const reqId = list.body.items[0].id as string;
    expect((await call(tomas, "POST", `/api/v1/access-requests/${reqId}/dismiss`)).status).toBe(403);
    expect((await call(daniel, "POST", `/api/v1/access-requests/${reqId}/dismiss`)).status).toBe(200);
    expect((await call(daniel, "POST", `/api/v1/access-requests/${reqId}/dismiss`)).status).toBe(409);
    expect((await call(daniel, "GET", "/api/v1/access-requests?project=payments")).body.items).toEqual([]);
    expect(await rolesOf(lena)).toBe(before);
    expect(Number((await q(`select count(*)::int n from events where type = 'access.request.dismissed'`))[0].n)).toBe(1);
  });

  it("skips yourself, duplicates and people who do not exist; refuses more than five; a mention does not let a non-participant speak", async () => {
    const id = await submit();
    await say(id, "@Tomas @Rui @Rui @nobody", [tomas, rui, rui, "p-nobody"]);
    expect(await q(`select person_id from workorder_mentions where wo_id = $1`, [id])).toEqual([{ person_id: rui }]);
    const six = ["a", "b", "c", "d", "e", "f"].map((x) => `p-${x}`);
    expect((await call(tomas, "POST", url(id, "/messages"), { text: "hi", mentions: six })).status).toBe(422);
    expect((await call(rui, "POST", url(id, "/messages"), { text: "hi", mentions: [tomas] })).status).toBe(403);
    expect((await call(lena, "POST", url(id, "/messages"), { text: "hi", mentions: [tomas] })).status).toBe(404);
  });
});
