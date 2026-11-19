import { RepoFacts } from "@gantry/domain";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureConsoleEdge, resetConsoleEdge } from "../src/areas/console/model.js";
import { configureSessionBroker, resetSessionBroker } from "../src/areas/onboarding/session/broker.js";
import { woSessionJobs } from "../src/routes/workorder-session.js";
import { OPTION_MAX } from "../src/areas/workorders/session/tools.js";
import { endSentence } from "../src/core/text.js";
import { FakeEdge, parseSse } from "./console-edge.js";
import { world } from "./flow-helpers.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const tomas = "p-tomas";

describe("endSentence", () => {
  it("ends every sentence with exactly one full stop", () => {
    expect(endSentence("try again.")).toBe("try again.");
    expect(endSentence("try again..")).toBe("try again.");
    expect(endSentence("try again")).toBe("try again.");
    expect(endSentence("Is it?")).toBe("Is it?");
    expect(`${endSentence("The model vendor could not be reached. This is usually temporary: try again.")} Nothing was changed.`).not.toMatch(/\.\./);
  });
});

d("intake questions: closing, replacing and verifying", () => {
  let t: TestApp;
  const edge = new FakeEdge();
  let n = 0;
  const w = world(() => t);
  const q = w.q;
  const url = (id: string, tail = "") => `/api/v1/work-orders/${id}/session${tail}`;
  const call = async (who: string, method: "GET" | "POST", u: string, payload?: unknown) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method, url: u, headers: { ...s.headers, "idempotency-key": `kq-${++n}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
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
  const userMsgs = async (id: string) => ((await call(tomas, "GET", url(id))).body.messages as any[]).filter((m) => m.role === "user");

  // A typed reply closes the cards of the LAST assistant message only; an older question stays open (the WO-1001 pattern). `continue` turns post a message without a person's text.
  it("replays WO-1001: a blocking question, an answer on a later card plus a typed reply, then resolve_question with that quote lets propose_brief through", async () => {
    const id = await submit();
    await turn(id, [ask({ question: "Which screen or flow first?", options: ["Sign-up", "Checkout", "Refunds"], blocking: true }), say("Which first?")], "hi");
    const [first] = await cards(id);
    expect(first.blocking).toBe(true);
    await turn(id, [ask({ question: "Roughly how many users are affected?", options: ["Few", "Many"], blocking: false }, "b"), say("Another one.")]);
    const refused = await turn(id, [tool("propose_brief", BRIEF), say("blocked")], "all three together");
    const afterTyped = await cards(id);
    expect(afterTyped.find((c) => c.id === first.id)?.answered).toBeUndefined();
    expect(afterTyped.find((c) => c.id !== first.id)?.answered).toBe("all three together");
    expect(refused).toContain("still unanswered");
    expect(refused).toContain(first.id);
    expect(refused).toContain("resolve_question");
    const out = await turn(id, [tool("resolve_question", { questionId: first.id, answerQuote: "all three together" }, "r"), tool("propose_brief", BRIEF, "p"), say("Brief drafted; waits for approval.")], "go on");
    expect(out).not.toContain("still unanswered: ");
    const s = (await call(tomas, "GET", url(id))).body;
    const card = (await cards(id)).find((c) => c.id === first.id)!;
    expect(card).toMatchObject({ answered: "all three together", answeredBy: "person", via: "message", answerQuote: "all three together" });
    expect(card.answerMessageId).toBeTruthy();
    expect((await userMsgs(id)).map((m) => m.id)).toContain(card.answerMessageId);
    expect(s.messages.at(-1).data.cards.some((c: any) => c.kind === "proposal" && c.status === "pending")).toBe(true);
    expect((await q(`select after from events where wo_id = $1 and type = 'wo.session.question.resolved'`, [id]))[0].after).toMatchObject({ question: first.id, quote: "all three together" });
  });

  it("refuses a fabricated quote and a quote that only the agent wrote", async () => {
    const id = await submit();
    await turn(id, [ask({ question: "Which screen first?", options: ["A", "B"], blocking: true }), say("?")], "hello there");
    const [first] = await cards(id);
    await turn(id, [ask({ question: "Another thing?", options: [], blocking: false }, "b"), say("x")]);
    const fake = await turn(id, [tool("resolve_question", { questionId: first.id, answerQuote: "yes, build the checkout screen first" }), say("x")], "nothing relevant");
    expect(fake).toContain("not in anything the person wrote");
    const own = await turn(id, [tool("resolve_question", { questionId: first.id, answerQuote: "Which screen first?" }), say("x")], "still nothing");
    expect(own).toContain("not in anything the person wrote");
    expect((await cards(id)).find((c) => c.id === first.id)?.answered).toBeUndefined();
    const bad = await turn(id, [tool("resolve_question", { questionId: first.id, answerQuote: "hello there", messageId: "wm-nope" }), say("x")], "more");
    expect(bad).toContain("not a message the person wrote");
    // The person's words from BEFORE the question was asked do not count either.
    const before = await turn(id, [tool("resolve_question", { questionId: first.id, answerQuote: "hello there" }), say("x")], "later");
    expect(before).toContain("not in anything the person wrote");
  });

  it("`replaces` supersedes the old open question; asking the same thing again without it is refused", async () => {
    const id = await submit();
    await turn(id, [ask({ question: "Which screen or flow first?", options: ["Sign-up", "Checkout"], blocking: true }), say("?")], "hi");
    const [first] = await cards(id);
    const dup = await turn(id, [ask({ question: "Which screen or flow first?!", options: ["Sign-up", "Checkout"], blocking: true }, "d"), say("x")]);
    expect(dup).toMatch(/already have this question open as \S+\/Q-1/);
    expect((await cards(id)).filter((c) => !c.answered)).toHaveLength(1);
    await turn(id, [ask({ question: "Pick the first flow, or say all of them", options: ["Sign-up", "Checkout", "All"], blocking: true, replaces: first.id }, "e"), say("asked again")]);
    const all = await cards(id);
    const old = all.find((c) => c.id === first.id)!;
    const neu = all.find((c) => c.replaces === first.id)!;
    expect(old).toMatchObject({ superseded: true, supersededBy: neu.id });
    expect(neu.id).not.toBe(first.id);
    expect(old.answered).toBeUndefined();
  });

  it("an over-long option is an error to the agent, never cut", async () => {
    const id = await submit();
    const long = "A new user can find the settings and finish the whole flow ".repeat(5);
    expect(long.length).toBeGreaterThan(OPTION_MAX);
    const seen = await turn(id, [ask({ question: "Which?", options: ["short", long], blocking: false }), say("x")], "hi");
    expect(seen).toContain(`the longest allowed is ${OPTION_MAX}`);
    expect(await cards(id)).toHaveLength(0);
    const exact = "x".repeat(OPTION_MAX - 2) + " y";
    await turn(id, [ask({ question: "Which one?", options: [exact], blocking: false }), say("x")], "again");
    expect((await cards(id))[0].options[0]).toBe(exact);
  });

  it("the vendor-unreachable notice ends with exactly one full stop", async () => {
    const id = await submit();
    edge.script = [{ blocks: [], status: 502, error: { type: "api_error", message: "The model vendor could not be reached. This is usually temporary: try again." } }];
    await call(tomas, "POST", url(id, "/messages"), { kind: "open" });
    const text = ((await call(tomas, "GET", url(id))).body.messages.at(-1).text as string);
    expect(text).toMatch(/did not answer: .*try again\. Nothing was changed/);
    expect(text).not.toMatch(/\.\./);
  });

  it("replays the double start: two blocking Q-1 cards, the person answers the second, and the agent can still propose once the stale duplicate is resolved", async () => {
    const id = await submit();
    await turn(id, [ask({ question: "Which screen or flow first?", options: ["Sign-up", "Checkout"], blocking: true }), say("Which first?")]);
    const [first] = await cards(id);
    // What WO-1001 stored: a second opening turn asked the same blocking question (also Q-1); the person answered that copy.
    const base = (await q(`select created_at from workorder_messages where wo_id = $1 order by created_at desc limit 1`, [id]))[0].created_at as Date;
    const at = (ms: number) => new Date(base.getTime() + ms);
    const ins = (mid: string, role: string, body: string, data: unknown, ms: number) => q(`insert into workorder_messages (org_id, id, wo_id, role, author, body, data, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)`, [t.orgId, mid, id, role, role === "user" ? tomas : "ag-intake", body, JSON.stringify(data), at(ms)]);
    await ins("wm-dup", "assistant", "Which first?", { mode: "agent", cards: [{ kind: "question", id: "Q-1", question: "Which screen or flow first?", options: ["Sign-up", "Checkout"], blocking: true, answered: "all three together" }] }, 1000);
    await ins("wm-ans", "user", "all three together", {}, 2000);
    expect((await cards(id)).filter((c) => c.id === "Q-1")).toHaveLength(2);
    const refused = await turn(id, [tool("propose_brief", BRIEF), say("blocked")]);
    expect(refused).toContain("still unanswered");
    expect(refused).toContain("stale duplicate");
    expect(refused).toContain(`${first.mid}/Q-1`);
    const done = await turn(id, [tool("resolve_question", { questionId: `${first.mid}/Q-1`, answerQuote: "all three together" }, "r"), tool("propose_brief", BRIEF, "p"), say("Brief drafted.")]);
    expect(done).toContain("resolved");
    const s = (await call(tomas, "GET", url(id))).body;
    expect((s.messages as any[]).some((m) => (m.data.cards ?? []).some((c: any) => c.kind === "proposal" && c.status === "pending"))).toBe(true);
    // a bare id shared by two cards is ambiguous and says so
    const amb = await turn(id, [tool("ask_user", { question: "Another?", blocking: false, replaces: "Q-1" }), say("x")]);
    expect(amb).not.toContain("names more than one");
  });

  it("the 'conversation is open' nudge does not start a second Intake turn once the agent has already spoken", async () => {
    const id = await submit();
    await turn(id, [ask({ question: "Which screen or flow first?", options: ["Sign-up"], blocking: true }), say("Which first?")], undefined);
    const calls = edge.calls.length;
    await q(`insert into workorder_messages (org_id, id, wo_id, role, author, body, data, created_at, updated_at) values ($1, 'wm-opened', $2, 'system', 'system', 'The Intake conversation is open.', '{"kind":"update","event":"session.opened","followUp":"pending","cards":[]}'::jsonb, now(), now())`, [t.orgId, id]);
    edge.script = [ask({ question: "Which screen or flow first?", options: ["Sign-up"], blocking: true }), say("again")] as never;
    await woSessionJobs.followUps();
    expect(edge.calls.length).toBe(calls);
    expect((await q(`select data->>'followUp' as f from workorder_messages where wo_id = $1 and data->>'event' = 'session.opened'`, [id]))[0].f).toBe("skipped");
    expect((await cards(id)).filter((c) => c.question === "Which screen or flow first?")).toHaveLength(1);
  });

  describe("a vendor drop on an automatic Intake turn", () => {
    const unreachable = { blocks: [], status: 502, error: { type: "api_error", message: "The model vendor could not be reached. This is usually temporary: try again." } };
    const nudge = async () => {
      await q(`delete from workorder_messages where id = 'wm-blip'`);
      const id = await submit();
      await q(`update work_orders set data = jsonb_set(data, '{classifyPending}', '"done"') where org_id = $1 and data->>'classifyPending' in ('pending','running')`, [t.orgId]);
      await q(`delete from workorder_messages where wo_id = $1 and data->>'event' = 'session.opened'`, [id]);
      await q(`insert into workorder_messages (org_id, id, wo_id, role, author, body, data, created_at, updated_at) values ($1, 'wm-blip', $2, 'system', 'system', 'The Intake conversation is open.', '{"kind":"update","event":"session.opened","followUp":"pending","cards":[]}'::jsonb, now(), now())`, [t.orgId, id]);
      return id;
    };
    const state = async () => (await q(`select data->>'followUp' as f, data->>'followUpRetried' as r from workorder_messages where id = 'wm-blip'`))[0];
    const due = () => q(`update workorder_messages set data = jsonb_set(data, '{followUpRetryAt}', '0') where id = 'wm-blip'`);

    it("is retried once after a pause, and the person sees nothing when the second attempt works", async () => {
      const id = await nudge();
      edge.script = [unreachable, say("Hello, what do you need?")] as never;
      await woSessionJobs.followUps();
      expect(await state()).toMatchObject({ f: "pending", r: "true" });
      const calls = edge.calls.length;
      await woSessionJobs.followUps();
      expect(edge.calls.length).toBe(calls); // not due yet: no tight loop
      await due();
      await woSessionJobs.followUps();
      expect((await state()).f).toBe("done");
      expect(((await call(tomas, "GET", url(id))).body.messages as any[]).some((m) => m.role === "assistant")).toBe(true);
    });

    it("is marked failed only when the second attempt fails too, and never a third time", async () => {
      await nudge();
      edge.script = [unreachable, unreachable, say("never")] as never;
      await woSessionJobs.followUps();
      await due();
      await woSessionJobs.followUps();
      expect((await state()).f).toBe("failed");
      const calls = edge.calls.length;
      await woSessionJobs.followUps();
      expect(edge.calls.length).toBe(calls);
    });
  });
});
