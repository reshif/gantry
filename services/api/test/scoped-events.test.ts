import { withTx } from "@gantry/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeFor } from "../src/core/stream.js";
import { publishChange } from "../src/core/changes.js";
import { addWoMessage } from "../src/areas/workorders/session/store.js";
import { world } from "./flow-helpers.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
type Ch = { keys: string[]; project?: string };

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
  return {
    changes: () => messages.filter((x) => x.startsWith("event: change")).map((x) => JSON.parse(x.split("data: ")[1]!) as Ch),
    messages,
    get ended() { return ended; },
    close: () => void reader.cancel().catch(() => undefined),
  };
}
const until = async (f: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return f();
};
const settle = () => new Promise((r) => setTimeout(r, 300));

describe("changeFor (pure)", () => {
  const ch = (keys: string[], project?: string, audience?: string[]) => ({ org: "o", keys, ...(project ? { project } : {}), ...(audience ? { audience } : {}) });
  it("an audience limits the change to those people, factory-wide readers included", () => {
    expect(changeFor(ch(["console"], undefined, ["a"]), new Set(), "a")).toEqual({ keys: ["console"] });
    expect(changeFor(ch(["console"], undefined, ["a"]), "all", "b")).toBeNull();
    expect(changeFor(ch(["console"], "p1", ["a"]), new Set(["p1"]), "b")).toBeNull();
    expect(changeFor(ch(["console"], "p1", ["a"]), new Set(), "a")).toBeNull(); // still needs the project
  });
  it("a chat change with neither audience nor project reaches no one; other item keys reach only factory-wide readers", () => {
    expect(changeFor(ch(["console", "workspace"]), "all", "a")).toBeNull();
    expect(changeFor(ch(["workOrders", "floor", "agents"]), new Set(["p1"]), "a")).toEqual({ keys: ["agents"] });
    expect(changeFor(ch(["workOrders"]), new Set(["p1"]), "a")).toBeNull();
    expect(changeFor(ch(["workOrders"]), "all", "a")).toEqual({ keys: ["workOrders"] });
  });
});

d("live change events are scoped to people who may read the item", () => {
  let t: TestApp;
  const w = world(() => t);
  let base = "";
  beforeAll(async () => {
    t = await startApp({ build: { heartbeatMs: 100 } });
    base = await t.app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(() => t.close());

  const open = async (who: string) => {
    const s = await t.session(who);
    const stream = sse(await fetch(`${base}/api/v1/stream`, { headers: { cookie: s.cookie } }));
    expect(await until(() => stream.messages.some((m) => m.includes(": connected")))).toBe(true);
    return stream;
  };
  const chatKeys = (s: ReturnType<typeof sse>) => s.changes().filter((c) => c.keys.some((k) => k === "console" || k === "workspace"));

  it("a private conversation: only its owner hears of it, not a factory admin or a project colleague; an invited member then does", async () => {
    const tomas = await open("p-tomas");
    const lena = await open("p-lena");
    const asha = await open("p-asha");
    const made = await w.call("p-tomas", "POST", "/api/v1/workspace/threads", { scope: { kind: "project", id: "payments" } });
    expect(made.status).toBe(200);
    const id = String(made.body.id);
    expect(await until(() => chatKeys(tomas).length >= 1)).toBe(true);
    await settle();
    expect(chatKeys(lena)).toHaveLength(0);
    expect(chatKeys(asha)).toHaveLength(0);
    // a rename is private too
    expect((await w.call("p-tomas", "PATCH", `/api/v1/workspace/threads/${id}`, { title: "Quiet plans" })).status).toBe(200);
    await settle();
    expect(chatKeys(asha)).toHaveLength(0);
    // the owner invites the admin: from now on the admin may read it, so the admin hears of it (and Lena still does not)
    expect((await w.call("p-tomas", "POST", `/api/v1/workspace/threads/${id}/members`, { person: "p-asha" })).status).toBe(200);
    expect(await until(() => chatKeys(asha).length >= 1)).toBe(true);
    await settle();
    expect(chatKeys(lena)).toHaveLength(0);
    // removing the member tells the member (to refetch) and then stops
    const before = chatKeys(asha).length;
    expect((await w.call("p-tomas", "DELETE", `/api/v1/workspace/threads/${id}/members/p-asha`)).status).toBe(200);
    expect(await until(() => chatKeys(asha).length > before)).toBe(true);
    const after = chatKeys(asha).length;
    expect((await w.call("p-tomas", "PATCH", `/api/v1/workspace/threads/${id}`, { title: "Quieter" })).status).toBe(200);
    await settle();
    expect(chatKeys(asha)).toHaveLength(after);
    expect(chatKeys(lena)).toHaveLength(0);
    for (const s of [tomas, lena, asha]) s.close();
  });

  it("a conversation shared with its project reaches people who see that project, and not others", async () => {
    const tomas = await open("p-tomas");
    const lena = await open("p-lena"); // no role in payments
    const asha = await open("p-asha");
    const made = await w.call("p-tomas", "POST", "/api/v1/workspace/threads", { scope: { kind: "project", id: "payments" }, visibility: "project" });
    expect(made.status).toBe(200);
    expect(await until(() => chatKeys(tomas).length >= 1 && chatKeys(asha).length >= 1)).toBe(true);
    expect(chatKeys(tomas)[0]).toMatchObject({ project: "payments" });
    await settle();
    expect(chatKeys(lena)).toHaveLength(0);
    for (const s of [tomas, lena, asha]) s.close();
  });

  it("a person's own console changes (model, pins) reach only their own streams", async () => {
    const tomas = await open("p-tomas");
    const asha = await open("p-asha");
    expect((await w.call("p-tomas", "PUT", "/api/v1/console/model", { model: null })).status).toBe(200);
    expect(await until(() => chatKeys(tomas).length >= 1)).toBe(true);
    await settle();
    expect(chatKeys(asha)).toHaveLength(0);
    tomas.close();
    asha.close();
  });

  it("work-order and project events reach people who can read the project, and nobody else", async () => {
    const sub = await w.submit("p-tomas");
    const id = sub.body.id as string;
    const tomas = await open("p-tomas");
    const lena = await open("p-lena");
    const asha = await open("p-asha");
    await settle();
    const n = { tomas: tomas.changes().length, lena: lena.changes().length, asha: asha.changes().length };
    await withTx(t.db.app, (tx) => addWoMessage(tx, t.orgId, id, "assistant", "agent", "Found it.", {}, new Date()));
    await withTx(t.db.admin as never, (tx) => publishChange(tx, { org: t.orgId, keys: ["workOrders", "floor"], project: "payments" }));
    expect(await until(() => tomas.changes().length >= n.tomas + 2 && asha.changes().length >= n.asha + 2)).toBe(true);
    expect(tomas.changes().at(-1)).toEqual({ keys: ["workOrders", "floor"], project: "payments" });
    await settle();
    expect(lena.changes().length).toBe(n.lena);
    // A work order change with no project is not announced to a person who is not factory-wide
    await withTx(t.db.admin as never, (tx) => publishChange(tx, { org: t.orgId, keys: ["workOrders", "deliveries", "agents"] }));
    expect(await until(() => asha.changes().at(-1)?.keys.length === 3)).toBe(true);
    await settle();
    expect(tomas.changes().at(-1)).toEqual({ keys: ["agents"] });
    for (const s of [tomas, lena, asha]) s.close();
  });

  it("losing a project role stops its events at once, and a deactivated person's stream is closed", async () => {
    const q = (sql: string, p: unknown[] = []) => t.db.admin.query(sql, p);
    await q(`insert into role_assignments (org_id, id, person_id, role_id, scope_type, project_id) values ($1,'ra-scope-test','p-lena','viewer','project','payments')`, [t.orgId]);
    await withTx(t.db.admin as never, (tx) => publishChange(tx, { org: t.orgId, keys: ["people"] }));
    const lena = await open("p-lena");
    await withTx(t.db.admin as never, (tx) => publishChange(tx, { org: t.orgId, keys: ["workOrders"], project: "payments" }));
    expect(await until(() => lena.changes().some((c) => c.project === "payments"))).toBe(true);
    await q(`update role_assignments set revoked_at = now() where id = 'ra-scope-test'`);
    await withTx(t.db.admin as never, (tx) => publishChange(tx, { org: t.orgId, keys: ["people"] }));
    await settle();
    const n = lena.changes().length;
    await withTx(t.db.admin as never, (tx) => publishChange(tx, { org: t.orgId, keys: ["workOrders"], project: "payments" }));
    await settle();
    expect(lena.changes().length).toBe(n);

    const kenji = await open("p-kenji");
    const admin = await t.session("p-asha", { authAgeSec: 0 });
    const v = (await q(`select version from people where id = 'p-kenji'`)).rows[0].version;
    const r = await t.app.inject({ method: "POST", url: "/api/v1/people/p-kenji/deactivate", headers: { ...admin.headers, "if-match": String(v) }, payload: { reason: "Left the company on Friday" } });
    expect(r.statusCode).toBe(200);
    expect(await until(() => kenji.ended)).toBe(true);
    lena.close();
  });
});
