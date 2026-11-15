import type { FastifyPluginAsync } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishChange } from "../src/core/changes.js";
import { command } from "../src/core/command.js";
import { registerRoutes } from "../src/routes/index.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { withTx } from "@gantry/db";

const d = TEST_URL ? describe : describe.skip;

const testRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/v1/test/touch/:id", async (req) => {
    const { id } = req.params as { id: string };
    return command(req, { action: "project.config", scope: { project: id } }, async () => ({ msg: "ok", events: [{ type: "project.saved" }], changes: ["projects"] }));
  });
  app.post("/api/v1/test/touch-fail/:id", async (req) => {
    const { id } = req.params as { id: string };
    return command(req, { action: "project.config", scope: { project: id } }, async () => {
      throw new Error("fails after the body ran");
    });
  });
};

/** Reads an SSE response into messages. */
function sse(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const messages: string[] = [];
  let ended = false;
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        messages.push(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    }
    ended = true;
  })();
  return { messages, get ended() { return ended; }, close: () => void reader.cancel().catch(() => undefined) };
}
const until = async (f: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return f();
};
const changes = (m: string[]) => m.filter((x) => x.startsWith("event: change")).map((x) => JSON.parse(x.split("data: ")[1]!) as { keys: string[]; project?: string });

d("SSE stream over LISTEN/NOTIFY", () => {
  let t: TestApp;
  let base = "";
  beforeAll(async () => {
    t = await startApp({ build: { heartbeatMs: 100, routes: async (app) => { await registerRoutes(app); await app.register(testRoutes); } } });
    base = await t.app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(() => t.close());

  const open = async (who: string) => {
    const s = await t.session(who);
    const res = await fetch(`${base}/api/v1/stream`, { headers: { cookie: s.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    return { s, stream: sse(res) };
  };

  it("requires a session", async () => {
    const res = await fetch(`${base}/api/v1/stream`);
    expect(res.status).toBe(401);
  });

  it("delivers a committed command's change keys, filtered per person by visible project, with heartbeats", async () => {
    const a = await open("p-asha"); // factory admin: sees everything
    const tomas = await open("p-tomas"); // payments only
    expect(await until(() => a.stream.messages.some((m) => m.includes(": connected")))).toBe(true);
    expect(await until(() => a.stream.messages.some((m) => m.startsWith(": hb")))).toBe(true);

    await t.app.inject({ method: "POST", url: "/api/v1/test/touch/storefront", headers: a.s.headers });
    expect(await until(() => changes(a.stream.messages).length >= 1)).toBe(true);
    const c = changes(a.stream.messages)[0]!;
    expect(c.project).toBe("storefront");
    expect(c.keys).toEqual(expect.arrayContaining(["projects", "audit"]));
    await new Promise((r) => setTimeout(r, 250));
    expect(changes(tomas.stream.messages)).toHaveLength(0); // no role in storefront

    await t.app.inject({ method: "POST", url: "/api/v1/test/touch/payments", headers: a.s.headers });
    expect(await until(() => changes(tomas.stream.messages).length >= 1)).toBe(true);
    expect(changes(tomas.stream.messages)[0]!.project).toBe("payments");
    // the two streams get the same NOTIFY independently: wait for the admin's copy too instead of assuming it arrived first
    expect(await until(() => changes(a.stream.messages).length >= 2)).toBe(true);
    expect(changes(a.stream.messages)).toHaveLength(2);
    a.stream.close();
    tomas.stream.close();
  });

  it("a factory-wide change reaches a project-only person without the names of admin-only data", async () => {
    const a = await open("p-asha");
    const tomas = await open("p-tomas");
    expect(await until(() => tomas.stream.messages.some((m) => m.includes(": connected")))).toBe(true);
    await withTx(t.db.admin as never, (tx) => publishChange(tx, { org: t.orgId, keys: ["apiKeys", "audit"] }));
    await withTx(t.db.admin as never, (tx) => publishChange(tx, { org: t.orgId, keys: ["agents", "security", "audit"] }));
    expect(await until(() => changes(a.stream.messages).length >= 2)).toBe(true);
    expect(changes(a.stream.messages).map((c) => c.keys)).toEqual([["apiKeys", "audit"], ["agents", "security", "audit"]]);
    expect(await until(() => changes(tomas.stream.messages).length >= 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    // the API-key change is not sent at all; the agents change arrives with only the name Tomas may read
    expect(changes(tomas.stream.messages)).toEqual([{ keys: ["agents"] }]);
    a.stream.close();
    tomas.stream.close();
  });

  it("a rolled-back command publishes nothing (NOTIFY fires on commit only)", async () => {
    const a = await open("p-asha");
    expect(await until(() => a.stream.messages.some((m) => m.includes(": connected")))).toBe(true);
    const r = await t.app.inject({ method: "POST", url: "/api/v1/test/touch-fail/payments", headers: a.s.headers });
    expect(r.statusCode).toBe(500);
    await new Promise((r2) => setTimeout(r2, 300));
    expect(changes(a.stream.messages)).toHaveLength(0);
    a.stream.close();
  });

  it("another replica or the worker can publish: a NOTIFY from any connection reaches the stream", async () => {
    const a = await open("p-asha");
    expect(await until(() => a.stream.messages.some((m) => m.includes(": connected")))).toBe(true);
    await withTx(t.db.admin as never, (tx) => publishChange(tx, { org: t.orgId, keys: ["workOrders", "floor"], project: "risk" }));
    expect(await until(() => changes(a.stream.messages).length === 1)).toBe(true);
    expect(changes(a.stream.messages)[0]).toEqual({ keys: ["workOrders", "floor"], project: "risk" });
    // another organisation's notification is ignored
    await withTx(t.db.admin as never, (tx) => publishChange(tx, { org: "00000000-0000-0000-0000-000000000000", keys: ["workOrders"] }));
    await new Promise((r) => setTimeout(r, 200));
    expect(changes(a.stream.messages)).toHaveLength(1);
    a.stream.close();
  });

  it("a sweep closes streams whose session expired or went idle, and keeps live ones", async () => {
    const live = await open("p-asha");
    const gone = await open("p-tomas");
    const idle = await open("p-chloe");
    expect(await until(() => gone.stream.messages.some((m) => m.includes(": connected")))).toBe(true);
    await t.db.admin.query(`update sessions set expires_at = now() - interval '1 second' where id = $1`, [gone.s.id]);
    await t.db.admin.query(`update sessions set last_seen_at = now() - interval '3 hours' where id = $1`, [idle.s.id]);
    await t.app.gantry.hub.sweep();
    expect(await until(() => gone.stream.ended && idle.stream.ended)).toBe(true);
    expect(live.stream.ended).toBe(false);
    live.stream.close();
  });

  it("revoking the session closes its stream", async () => {
    const x = await open("p-tomas");
    expect(await until(() => x.stream.messages.some((m) => m.includes(": connected")))).toBe(true);
    const admin = await t.session("p-asha");
    const r = await t.app.inject({ method: "DELETE", url: `/api/v1/sessions/${x.s.id}`, headers: admin.headers });
    expect(r.statusCode).toBe(200);
    expect(await until(() => x.stream.ended)).toBe(true);
  });
});
