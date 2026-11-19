import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { addMessage, ensureThread } from "../src/areas/console/threads.js";

const d = TEST_URL ? describe : describe.skip;
const ASHA = "p-asha";
const TOMAS = "p-tomas";

d("round 2: a console card's outcome comes from the command the server ran (S-19)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);

  /** An assistant message carrying one pending card, as the console stores it. */
  const card = async (who: string, call: object, extra: object = {}) => {
    const mid = `MSG-R2-${Math.random().toString(36).slice(2, 8)}`;
    await w.tx(async (tx: any) => {
      const th = await ensureThread(tx, t.orgId, who, null, "A card", new Date());
      await addMessage(tx, t.orgId, th!.id, "assistant", "Proposed.", { proposals: [{ id: "PROP-1", kind: "halt", title: "Halt", summary: "", steps: [], call, perm: { action: "line.halt" }, check: { allowed: true }, needsReason: 4, phrase: null, danger: false, entities: [], status: "pending", ...extra }] }, new Date(), mid);
    });
    return mid;
  };
  const send = async (who: string, method: "PUT" | "POST", url: string, payload: unknown) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method, url, headers: s.headers, payload: payload as object });
    return { status: r.statusCode, body: r.json() as any };
  };
  const stored = async (mid: string) => (await w.q(`select data from console_messages where id = $1`, [mid]))[0].data.proposals[0];

  it("the browser cannot record a card as done; the server runs it and records what happened", async () => {
    const mid = await card(ASHA, { method: "POST", path: "/api/v1/stops", body: { scope: "project", id: "payments", mode: "halt", reason: "", via: "console" }, idempotent: true });
    const lie = await send(ASHA, "PUT", `/api/v1/console/messages/${mid}/proposals/PROP-1`, { status: "done", result: "Halted payments." });
    expect(lie.status).toBe(409);
    expect((await stored(mid)).status).toBe("pending");
    expect((await w.q(`select count(*)::int as n from stops where lifted_at is null`))[0].n).toBe(0);
    // Too short a reason: still pending, nothing recorded.
    const short = await send(ASHA, "POST", `/api/v1/console/messages/${mid}/proposals/PROP-1/confirm`, { reason: "x" });
    expect(short.body.recorded).toBe(false);
    expect((await stored(mid)).status).toBe("pending");
    const ok = await send(ASHA, "POST", `/api/v1/console/messages/${mid}/proposals/PROP-1/confirm`, { reason: "duplicate refunds seen" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: "done", recorded: true });
    expect((await stored(mid)).status).toBe("done");
    expect((await w.q(`select count(*)::int as n from stops where lifted_at is null`))[0].n).toBeGreaterThan(0);
    expect((await send(ASHA, "POST", `/api/v1/console/messages/${mid}/proposals/PROP-1/confirm`, { reason: "again again" })).status).toBe(409);
  });
  it("a refused action ends the card as failed with the server's text and its needs line; dismissing is the only client-written outcome", async () => {
    const mid = await card(TOMAS, { method: "POST", path: "/api/v1/stops", body: { scope: "project", id: "payments", mode: "kill", reason: "", via: "console" }, idempotent: true });
    const r = await send(TOMAS, "POST", `/api/v1/console/messages/${mid}/proposals/PROP-1/confirm`, { reason: "just testing it" });
    expect(r.body.status).toBe("failed");
    expect(r.body.msg).toBeTruthy();
    const p = await stored(mid);
    expect(p).toMatchObject({ status: "failed", result: r.body.msg });
    expect(p.refusal.code).toBeGreaterThanOrEqual(400);
    const mid2 = await card(TOMAS, { method: "POST", path: "/api/v1/stops", body: {}, idempotent: true });
    expect((await send(TOMAS, "PUT", `/api/v1/console/messages/${mid2}/proposals/PROP-1`, { status: "dismissed" })).status).toBe(200);
    expect((await stored(mid2)).status).toBe("dismissed");
  });
});
