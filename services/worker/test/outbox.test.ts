import { createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, encrypt, enqueueOutbox, withTx } from "@gantry/db";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OutboxDispatcher } from "../src/outbox/dispatcher.js";
import { proxiedHttp } from "../src/outbox/http.js";
import { TEST_URL } from "./db.js";
import { FakeEndpoint, FakeProxy } from "./doubles.js";
import { startWorld, type World } from "./world.js";

const d = TEST_URL ? describe : describe.skip;
const DATA_KEY = randomBytes(32);

d("outbox dispatcher (spec 12.2)", () => {
  let w: World;
  let out: OutboxDispatcher;
  let hook: FakeEndpoint;
  beforeEach(async () => {
    w = await startWorld({ cfg: { dataKey: DATA_KEY } });
    out = w.worker.outbox;
    hook = await new FakeEndpoint().start();
  });
  afterEach(async () => { await hook.stop(); await w.close(); });

  const event = async (type = "gate.waiting", category: "approvals" | "kill" = "approvals") =>
    withTx(w.db.app, async (tx) => (await appendEvent(tx, { orgId: w.orgId, type, category, actor: "system", channel: "system", woId: null, after: { gate: "G3" } })).id);
  const row = async (eventId: string, destination: string) => (await w.q(`select * from outbox where event_id = $1 and destination = $2`, [eventId, destination]))[0];
  const push = async (eventId: string, destination: string, payload: object, maxAttempts?: number) =>
    enqueueOutbox(w.db.app, { orgId: w.orgId, eventId, destination, payload, ...(maxAttempts ? { maxAttempts } : {}) });
  const due = () => w.q(`update outbox set next_attempt_at = now() where status = 'pending'`);
  const integration = async (id: string, type: string, o: { url?: string; secret?: string; enabled?: boolean }) => {
    await w.q(`insert into integration_types (org_id, id, name, builtin) values ($1,$2,$2,true) on conflict do nothing`, [w.orgId, type]);
    await w.q(`insert into integration_instances (org_id, id, type_id, name, enabled, config, secret_enc) values ($1,$2,$3,$2,$4,$5::jsonb,$6)`, [
      w.orgId, id, type, o.enabled ?? true, JSON.stringify(o.url ? { url: o.url } : {}), o.secret ? encrypt(o.secret, DATA_KEY, `integration:${id}`) : null,
    ]);
  };

  it("sends email through SMTP with a Message-ID keyed by event and destination", async () => {
    const e = await event();
    await push(e, "smtp", { to: ["asha@example.com"], subject: "G3 is waiting", text: "WO-1042 needs your approval." });
    await out.drain();
    expect(w.smtp.mails).toHaveLength(1);
    expect(w.smtp.mails[0]!.to[0]).toContain("asha@example.com");
    expect(w.smtp.mails[0]!.data).toContain(`Message-ID: <${e}.smtp@gantry>`);
    expect(w.smtp.mails[0]!.data).toContain("G3 is waiting");
    expect((await row(e, "smtp")).status).toBe("delivered");
  });

  it("one delivery per event and destination: enqueueing again creates nothing, and a delivered row is never sent twice", async () => {
    const e = await event();
    const a = await push(e, "smtp", { to: ["a@example.com"], text: "x" });
    const b = await push(e, "smtp", { to: ["a@example.com"], text: "x" });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    await out.drain();
    await out.drain();
    expect(w.smtp.mails).toHaveLength(1);
  });

  it("retries a temporary failure with backoff and delivers on the next attempt (at least once)", async () => {
    const e = await event();
    w.smtp.tempFail = 1;
    await push(e, "smtp", { to: ["a@example.com"], text: "x" });
    await out.drain();
    let r = await row(e, "smtp");
    expect(r.status).toBe("pending");
    expect(r.attempts).toBe(1);
    expect(r.last_error).toMatch(/SMTP delivery failed/);
    expect(new Date(r.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    await due();
    await out.drain();
    r = await row(e, "smtp");
    expect(r.status).toBe("delivered");
    expect(w.smtp.mails).toHaveLength(1);
  });

  it("dead-letters after the attempts are used up, and at once for a failure that cannot be fixed by retrying", async () => {
    const e1 = await event("gate.waiting");
    const e2 = await event("gate.escalated");
    await integration("hook-a", "webhook", { url: `http://127.0.0.1:${hook.port}/a` });
    hook.statuses = [500, 500, 400];
    await push(e1, "webhook", { integration: "hook-a", text: "x" }, 2);
    await out.drain();
    expect((await row(e1, "webhook")).status).toBe("pending");
    await due();
    await out.drain();
    const dead = await row(e1, "webhook");
    expect(dead.status).toBe("dead");
    expect(dead.attempts).toBe(2);
    expect(dead.last_error).toMatch(/500/);
    await push(e2, "webhook", { integration: "hook-a", text: "y" });
    await out.drain();
    const bad = await row(e2, "webhook");
    expect(bad.status).toBe("dead");
    expect(bad.attempts).toBe(1);
    expect(bad.last_error).toMatch(/400/);
  });

  it("signs webhooks with HMAC-SHA256 over timestamp and body, using the sealed secret", async () => {
    const e = await event("wo.released");
    await integration("hook-b", "webhook", { url: `http://127.0.0.1:${hook.port}/b`, secret: "whsec_test_123" });
    await push(e, "webhook", { integration: "hook-b", text: "Released." });
    await out.drain();
    const got = hook.received[0]!;
    const sig = String(got.headers["x-gantry-signature"]);
    const [t, v1] = [/t=(\d+)/.exec(sig)![1]!, /v1=([0-9a-f]+)/.exec(sig)![1]!];
    expect(v1).toBe(createHmac("sha256", "whsec_test_123").update(`${t}.${got.body}`).digest("hex"));
    const body = JSON.parse(got.body);
    expect(body).toMatchObject({ id: e, type: "wo.released", destination: "webhook", text: "Released." });
    expect(got.headers["x-gantry-event"]).toBe(e);
    expect(got.headers["x-gantry-delivery"]).toBe((await row(e, "webhook")).id);
  });

  it("a disabled destination is skipped, except for kill and restore, which cannot be switched off", async () => {
    await integration("hook-c", "webhook", { url: `http://127.0.0.1:${hook.port}/c`, enabled: false });
    const normal = await event("gate.waiting");
    const kill = await event("kill", "kill");
    await push(normal, "webhook", { integration: "hook-c", text: "n" });
    await push(kill, "webhook", { integration: "hook-c", text: "k" });
    await out.drain();
    // The kill goes out through the disabled connection: the pushed row, and the producer's own fallback (a kill with no route reaches every connection that can carry it, S-35).
    expect(hook.received.length).toBeGreaterThanOrEqual(1);
    expect(hook.received.every((m) => JSON.parse(m.body).type === "kill")).toBe(true);
    const r = await row(normal, "webhook");
    expect(r.status).toBe("delivered");
    expect(r.last_error).toMatch(/skipped/);
  });

  it("a malformed payload, an unknown integration and a missing recipient dead-letter immediately", async () => {
    const e = await event();
    await push(e, "smtp", { text: "no recipient" });
    await push(e, "slack", { integration: "nope", text: "x" });
    await push(e, "teams", { to: "not-a-list", text: 5 });
    await out.drain();
    const rows = await w.q(`select destination, status, last_error from outbox where event_id = $1 order by destination`, [e]);
    expect(rows.map((r) => r.status)).toEqual(["dead", "dead", "dead"]);
  });
});

d("chat and webhook delivery through the egress proxy", () => {
  let w: World;
  let proxy: FakeProxy;
  let tls: FakeEndpoint;
  let plain: FakeEndpoint;
  let ca = "";
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wrk-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
    ca = readFileSync(join(dir, "c.pem"), "utf8");
  });
  beforeEach(async () => {
    proxy = await new FakeProxy().start();
    tls = await new FakeEndpoint().start({ key: readFileSync(join(dir, "k.pem"), "utf8"), cert: ca });
    plain = await new FakeEndpoint().start();
    w = await startWorld({ cfg: { dataKey: DATA_KEY, egressProxy: proxy.url, egressCa: ca } });
    // startWorld builds its deps without the proxy settings of the test's cfg for http; build the real client from that cfg.
    (w.deps as { http: unknown }).http = proxiedHttp({ proxy: proxy.url, ca });
  });
  afterEach(async () => { await Promise.allSettled([proxy.stop(), tls.stop(), plain.stop()]); await w.close(); });

  const event = async () => withTx(w.db.app, async (tx) => (await appendEvent(tx, { orgId: w.orgId, type: "gate.waiting", category: "approvals", actor: "system", channel: "system", after: {} })).id);
  const instance = async (id: string, type: string, url: string) => {
    await w.q(`insert into integration_types (org_id, id, name, builtin) values ($1,$2,$2,true) on conflict do nothing`, [w.orgId, type]);
    await w.q(`insert into integration_instances (org_id, id, type_id, name, config, secret_enc) values ($1,$2,$3,$2,'{}'::jsonb,$4)`, [w.orgId, id, type, encrypt(url, DATA_KEY, `integration:${id}`)]);
  };

  it("slack over HTTPS goes through a CONNECT tunnel and the webhook URL comes from the sealed secret", async () => {
    const e = await event();
    await instance("slack-1", "slack", `https://localhost:${tls.port}/services/T/B/x`);
    await enqueueOutbox(w.db.app, { orgId: w.orgId, eventId: e, destination: "slack", payload: { integration: "slack-1", text: "WO-1 is waiting at G3" } });
    await w.worker.outbox.drain();
    expect(proxy.connects).toEqual([`localhost:${tls.port}`]);
    expect(tls.received).toHaveLength(1);
    expect(tls.received[0]!.url).toBe("/services/T/B/x");
    expect(JSON.parse(tls.received[0]!.body)).toEqual({ text: "WO-1 is waiting at G3" });
    expect((await w.q(`select status from outbox where event_id = $1`, [e]))[0].status).toBe("delivered");
  });

  it("teams over plain HTTP is sent to the proxy as an absolute-URI request", async () => {
    const e = await event();
    await instance("teams-1", "teams", `http://127.0.0.1:${plain.port}/teams/hook`);
    await enqueueOutbox(w.db.app, { orgId: w.orgId, eventId: e, destination: "teams", payload: { integration: "teams-1", text: "hello", subject: "Gate" } });
    await w.worker.outbox.drain();
    expect(proxy.absolute[0]).toBe(`POST http://127.0.0.1:${plain.port}/teams/hook`);
    expect(JSON.parse(plain.received[0]!.body)["@type"]).toBe("MessageCard");
  });

  it("a host the proxy refuses is a retryable failure that names the allow-list", async () => {
    const e = await event();
    proxy.refuse.add("localhost");
    await instance("slack-2", "slack", `https://localhost:${tls.port}/x`);
    await enqueueOutbox(w.db.app, { orgId: w.orgId, eventId: e, destination: "slack", payload: { integration: "slack-2", text: "x" } });
    await w.worker.outbox.drain();
    const r = (await w.q(`select status, last_error from outbox where event_id = $1`, [e]))[0];
    expect(r.status).toBe("pending");
    expect(r.last_error).toMatch(/allow-list/);
    expect(tls.received).toHaveLength(0);
  });
});

