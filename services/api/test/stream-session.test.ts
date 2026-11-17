import { withTx } from "@gantry/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addWoMessage } from "../src/areas/workorders/session/store.js";
import { world } from "./flow-helpers.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;

function sse(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const messages: string[] = [];
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
  })();
  return { messages, close: () => void reader.cancel().catch(() => undefined) };
}
const until = async (f: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return f();
};
const sessionChanges = (m: string[]) =>
  m
    .filter((x) => x.startsWith("event: change"))
    .map((x) => JSON.parse(x.split("data: ")[1]!) as { keys: string[]; project?: string })
    .filter((c) => c.keys.includes("conversations"));

d("live updates of the work-order conversation and the inbox", () => {
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

  it("a new message in a work order's conversation reaches the people who can read that project, and nobody else", async () => {
    const sub = await w.submit("p-tomas");
    expect(sub.status).toBe(200);
    const id = sub.body.id as string;
    const tomas = await open("p-tomas"); // engineer on payments
    const lena = await open("p-lena"); // no role in payments
    const asha = await open("p-asha"); // factory admin
    await new Promise((r) => setTimeout(r, 100));
    const before = { tomas: sessionChanges(tomas.messages).length, lena: sessionChanges(lena.messages).length, asha: sessionChanges(asha.messages).length };

    await withTx(t.db.app, (tx) => addWoMessage(tx, t.orgId, id, "assistant", "agent", "Here is what I found.", {}, new Date()));

    expect(await until(() => sessionChanges(tomas.messages).length > before.tomas)).toBe(true);
    expect(await until(() => sessionChanges(asha.messages).length > before.asha)).toBe(true);
    expect(sessionChanges(tomas.messages).at(-1)).toMatchObject({ keys: ["conversations"], project: "payments" });
    await new Promise((r) => setTimeout(r, 250));
    expect(sessionChanges(lena.messages).length).toBe(before.lena);
    for (const s of [tomas, lena, asha]) s.close();
  });

  it("a message written inside a rolled-back transaction announces nothing", async () => {
    const sub = await w.submit("p-tomas");
    const id = sub.body.id as string;
    const tomas = await open("p-tomas");
    await new Promise((r) => setTimeout(r, 100));
    const before = sessionChanges(tomas.messages).length;
    await withTx(t.db.app, async (tx) => {
      await addWoMessage(tx, t.orgId, id, "system", "system", "never saved", {}, new Date());
      throw new Error("rolled back");
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(sessionChanges(tomas.messages).length).toBe(before);
    tomas.close();
  });
});
