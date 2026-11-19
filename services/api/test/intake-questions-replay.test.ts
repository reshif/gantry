import { RepoFacts } from "@gantry/domain";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureConsoleEdge, resetConsoleEdge } from "../src/areas/console/model.js";
import { configureSessionBroker, resetSessionBroker } from "../src/areas/onboarding/session/broker.js";
import { woSessionJobs } from "../src/routes/workorder-session.js";
import { FakeEdge, parseSse } from "./console-edge.js";
import { world } from "./flow-helpers.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

/** Replays of the statechart model of the Intake questions (statechart/intake-questions): the race the model found, and the paths it covers. */
const d = TEST_URL ? describe : describe.skip;
const tomas = "p-tomas";

d("intake questions: statechart replays", () => {
  let t: TestApp;
  const edge = new FakeEdge();
  let n = 0;
  const w = world(() => t);
  const q = w.q;
  const url = (id: string, tail = "") => `/api/v1/work-orders/${id}/session${tail}`;
  const call = async (who: string, method: "GET" | "POST", u: string, payload?: unknown) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method, url: u, headers: { ...s.headers, "idempotency-key": `kr-${++n}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
    const sse = String(r.headers["content-type"] ?? "").includes("text/event-stream");
    return { status: r.statusCode, body: sse ? ({} as Record<string, any>) : (r.json() as Record<string, any>), events: sse ? parseSse(r.body) : [] };
  };
  const facts = () => RepoFacts.parse({ repo: "acme/payments-api", defaultBranch: "main", headSha: "a".repeat(40), language: "TypeScript", files: ["package.json"], contents: { "package.json": "{}" }, secrets: { scanned: 1, complete: true, hits: [] }, protection: null });
  beforeAll(async () => { await edge.start(); configureConsoleEdge({ baseUrl: edge.url }); configureSessionBroker(async () => ({ ok: true, facts: facts() })); t = await startApp(); });
  afterAll(async () => { resetConsoleEdge(); resetSessionBroker(); await edge.stop(); await t.close(); });
  beforeEach(() => edge.reset());
  afterEach(async () => { await q(`delete from stops where org_id = $1`, [t.orgId]); });

  const BRIEF = { goal: "Accept an Idempotency-Key header on refund requests so client retries never refund twice.", scopeIn: ["POST /refunds accepts Idempotency-Key"], scopeOut: ["Other endpoints"], ac: ["A repeated key returns the original refund"], risks: [], open: [], estimate: "2 days", summary: "Idempotency for refunds." };
  const submit = async () => (await w.submit(tomas)).body.id as string;
  const ask = (input: Record<string, unknown>, tid = "a") => ({ blocks: [{ type: "tool_use", id: tid, name: "ask_user", input }] });
  const tool = (name: string, input: Record<string, unknown>, tid = "x") => ({ blocks: [{ type: "tool_use", id: tid, name, input }] });
  const say = (text = "ok") => ({ blocks: [{ type: "text", text }] });
  const turn = async (id: string, script: unknown[], text?: string) => {
    edge.script = script as never;
    const r = await call(tomas, "POST", url(id, "/messages"), text ? { text } : { kind: "continue" });
    expect(r.status).toBe(200);
    return JSON.stringify(edge.calls.at(-1)!.body.messages);
  };
  const cards = async (id: string) => ((await call(tomas, "GET", url(id))).body.messages as any[]).flatMap((m) => (m.data.cards ?? []).map((c: any) => ({ ...c, mid: m.id }))).filter((c) => c.kind === "question");
  const insert = (id: string, mid: string, role: string, body: string, data: unknown, at: Date) => q(`insert into workorder_messages (org_id, id, wo_id, role, author, body, data, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)`, [t.orgId, mid, id, role, role === "user" ? tomas : "ag-intake", body, JSON.stringify(data), at]);
  const Q1 = { kind: "question", id: "Q-1", question: "Which screen or flow first?", options: ["Sign-up", "Checkout"], blocking: true };

  // Model: IntakeQuestions.tla with Atomic = FALSE violates AtMostOneTurnRunning, UniqueIds and AtMostOneOpenPerIntent.
  it("RACE: the person's turn and the 'open' nudge never run two agent turns at once (no two copies of the question)", async () => {
    for (const lead of [0, 5, 15, 30]) {
      edge.reset();
      const id = await submit();
      await q(`insert into workorder_messages (org_id, id, wo_id, role, author, body, data, created_at, updated_at) values ($1, $2, $3, 'system', 'system', 'The Intake conversation is open.', '{"kind":"update","event":"session.opened","followUp":"pending","cards":[]}'::jsonb, now(), now())`, [t.orgId, `wm-op-${lead}`, id]);
      let inflight = 0;
      let peak = 0;
      // A turn is two model calls: the first asks (tool_use), the second (carrying the tool result) says its text and ends. A turn is in flight from its first call to its second.
      edge.respond = (body) => {
        const last = JSON.stringify((body.messages as any[]).at(-1));
        if (last.includes("tool_result")) { setTimeout(() => { inflight--; }, 100); return { blocks: [{ type: "text", text: "Which first?" }], delayMs: 100 }; }
        inflight++; peak = Math.max(peak, inflight);
        return { blocks: [{ type: "tool_use", id: "a", name: "ask_user", input: { question: "Which screen or flow first?", options: ["Sign-up", "Checkout"], blocking: true } }], delayMs: 120 };
      };
      const post = call(tomas, "POST", url(id, "/messages"), { text: "please start" });
      await new Promise((r) => setTimeout(r, lead));
      const job = woSessionJobs.followUps();
      const [p] = await Promise.all([post, job]);
      expect([200, 409]).toContain(p.status);
      await new Promise((r) => setTimeout(r, 400));
      await woSessionJobs.followUps();
      expect(peak, `lead ${lead}ms: two turns were in flight at once`).toBeLessThanOrEqual(1);
      const open = (await cards(id)).filter((c) => !c.answered && !c.superseded);
      expect(open.length, `lead ${lead}ms: open copies of the question`).toBeLessThanOrEqual(1);
      const ids = (await cards(id)).map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  // Model: UniqueIds / refs. Two older cards share Q-1; a bare id is ambiguous in resolve_question and in replaces.
  it("an ambiguous bare id is refused in resolve_question and in replaces; the ref works", async () => {
    const id = await submit();
    await turn(id, [ask({ question: "Which screen or flow first?", options: ["Sign-up", "Checkout"], blocking: true }), say("?")]);
    const [first] = await cards(id);
    const base = (await q(`select created_at from workorder_messages where wo_id = $1 order by created_at desc limit 1`, [id]))[0].created_at as Date;
    const at = (ms: number) => new Date(base.getTime() + ms);
    await insert(id, "wm-dup2", "assistant", "again", { mode: "agent", cards: [Q1] }, at(1000));
    await insert(id, "wm-says", "user", "all of them please", {}, at(2000));
    const amb = await turn(id, [tool("resolve_question", { questionId: "Q-1", answerQuote: "all of them please" }), say("x")]);
    expect(amb).toContain("names more than one open question");
    const amb2 = await turn(id, [tool("ask_user", { question: "Pick one?", blocking: true, replaces: "Q-1" }), say("x")]);
    expect(amb2).toContain("names more than one open question");
    const ok = await turn(id, [tool("resolve_question", { questionId: `${first.mid}/Q-1`, answerQuote: "all of them please" }), say("x")]);
    expect(ok).toContain("resolved");
    expect((await cards(id)).filter((c) => c.id === "Q-1" && !c.answered)).toHaveLength(1);
  });

  // Model: NoForgedAnswer. A question asked in this very turn cannot be resolved by anything.
  it("a question asked in this same turn cannot be resolved", async () => {
    const id = await submit();
    await turn(id, [ask({ question: "Which first?", options: [], blocking: true }), tool("resolve_question", { questionId: "Q-1", answerQuote: "hello" }, "r"), say("x")], "hello");
    const cs = await cards(id);
    expect(cs).toHaveLength(1);
    expect(cs[0].answered).toBeUndefined();
  });

  // Model (race config, NoPermanentBlock): a stale copy that lands AFTER the person's answer cannot be resolved by quote; the person's next typed reply closes the last assistant message's cards, so it is never permanent.
  it("a stale copy written after the person's answer: resolve refuses it, the next typed reply unblocks propose_brief", async () => {
    const id = await submit();
    await turn(id, [ask({ question: "Which screen or flow first?", options: ["Sign-up", "Checkout"], blocking: true }), say("?")]);
    const [first] = await cards(id);
    const base = (await q(`select created_at from workorder_messages where wo_id = $1 order by created_at desc limit 1`, [id]))[0].created_at as Date;
    const at = (ms: number) => new Date(base.getTime() + ms);
    await insert(id, "wm-ans", "user", "Checkout first", {}, at(1000));
    await insert(id, "wm-late", "assistant", "late copy", { mode: "agent", cards: [Q1] }, at(2000));
    await q(`update workorder_messages set data = jsonb_set(data, '{cards,0,answered}', '"Checkout first"') where id = $1`, [first.mid]);
    const refused = await turn(id, [tool("resolve_question", { questionId: "wm-late/Q-1", answerQuote: "Checkout first" }), say("x")]);
    expect(refused).toContain("not in anything the person wrote after you asked");
    const blocked = await turn(id, [tool("propose_brief", BRIEF), say("x")]);
    expect(blocked).toContain("still unanswered");
    const done = await turn(id, [tool("propose_brief", BRIEF, "p"), say("Brief drafted.")], "yes, checkout");
    expect(done).not.toContain("still unanswered: ");
    const s = (await call(tomas, "GET", url(id))).body;
    expect((s.messages as any[]).some((m) => (m.data.cards ?? []).some((c: any) => c.kind === "proposal" && c.status === "pending"))).toBe(true);
  });
});
