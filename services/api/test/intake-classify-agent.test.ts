import { RepoFacts } from "@gantry/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureConsoleEdge, resetConsoleEdge } from "../src/areas/console/model.js";
import { configureSessionBroker, resetSessionBroker } from "../src/areas/onboarding/session/broker.js";
import { woSessionJobs } from "../src/routes/workorder-session.js";
import { FakeEdge } from "./console-edge.js";
import { world } from "./flow-helpers.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;

d("agent-led classification at Intake (G-01)", () => {
  let t: TestApp;
  const edge = new FakeEdge();
  const w = world(() => t);
  const facts = () => RepoFacts.parse({ repo: "acme/payments-api", defaultBranch: "main", headSha: "a".repeat(40), language: "TypeScript", files: ["package.json", "AGENTS.md"], contents: { "AGENTS.md": "Security work is always a security class." }, secrets: { scanned: 2, complete: true, hits: [] }, protection: null });
  beforeAll(async () => {
    await edge.start();
    configureConsoleEdge({ baseUrl: edge.url });
    configureSessionBroker(async () => ({ ok: true, facts: facts() }));
    t = await startApp();
  });
  afterAll(async () => { resetConsoleEdge(); resetSessionBroker(); await edge.stop(); await t.close(); });
  beforeEach(async () => {
    edge.reset();
    await w.q(`update work_orders set data = jsonb_set(data, '{classifyPending}', '"done"') where org_id = $1 and data->>'classifyPending' in ('pending','running')`, [t.orgId]);
  });
  const setClass = (input: Record<string, unknown>) => (body: Record<string, unknown>) =>
    JSON.stringify(body.messages).includes("tool_result") ? { blocks: [{ type: "text" as const, text: "done" }] } : { blocks: [{ type: "tool_use" as const, id: "t1", name: "set_class", input }] };

  it("the Intake agent sets the class with its own rationale and confidence, audited as the agent's; the keyword guess was only a placeholder", async () => {
    const r = await w.submit("p-tomas", { title: "Fix the rounding bug in refunds", description: "Rotate the leaked signing credential and fix the rounding." });
    const id = r.body.id as string;
    const before = await w.get(id);
    expect(before.cls).toBe("bug");
    expect(before.clsRationale).toMatch(/^Provisional rule-based keyword match/);
    edge.respond = setClass({ cls: "security", confidence: 0.77, rationale: "A credential leak is a security matter, and AGENTS.md says so." });
    expect(await woSessionJobs.classify()).toBe(1);
    const wo = await w.get(id);
    expect(wo.cls).toBe("security");
    expect(wo.clsConfidence).toBe(0.77);
    expect(wo.clsRationale).toBe("A credential leak is a security matter, and AGENTS.md says so.");
    const [row] = await w.q(`select data from work_orders where id = $1`, [id]);
    expect(row.data.clsBy).toMatchObject({ kind: "agent", agent: "ag-intake" });
    expect(row.data.classifyPending).toBe("done");
    const ev = await w.q(`select actor, after, before from events where wo_id = $1 and type = 'wo.classify'`, [id]);
    expect(ev).toHaveLength(1);
    expect(ev[0].actor).toBe("ag-intake");
    expect(ev[0].after).toMatchObject({ initial: true, source: "agent", from: "bug", to: "security", confidence: 0.77 });
    expect(JSON.stringify(wo.conv.messages[0])).toMatch(/A credential leak/);
    // The agent read through the ordinary model path: the system prompt carries the work order, and it has the repository tools.
    const call0 = edge.calls[0]!.body as { tools: Array<{ name: string }> };
    expect(call0.tools.map((x) => x.name)).toEqual(expect.arrayContaining(["get_work_order", "read_file", "set_class"]));
    // Its cost is metered on the session, and the intake dialogue still opens afterwards (the classification note is not "a session").
    expect(await w.q(`select 1 from workorder_messages where wo_id = $1 and data->>'event' = 'agent.classified' and (data->>'costMicros') is not null`, [id])).toHaveLength(1);
    expect(await woSessionJobs.classify()).toBe(0);
    expect(await woSessionJobs.open()).toBeGreaterThan(0);
  });

  it("a class the agent names that does not exist is refused to the agent; with no class ever set, the keyword guess stays and is labelled", async () => {
    const id = (await w.submit("p-tomas", { title: "Fix the rounding bug in refunds" })).body.id as string;
    edge.respond = setClass({ cls: "made-up", confidence: 0.9, rationale: "Because." });
    await woSessionJobs.classify();
    const wo = await w.get(id);
    expect(wo.cls).toBe("bug");
    expect(wo.clsRationale).toMatch(/^Rule-based keyword match: no agent set the class/);
    expect(wo.conv.messages[0].text).toMatch(/Rule-based keyword match/);
  });

  it("a person's requested class always wins: nothing is queued and no model is called", async () => {
    const id = (await w.submit("p-tomas", { title: "Fix the rounding bug in refunds", requestedCls: "chore" })).body.id as string;
    edge.respond = setClass({ cls: "security", confidence: 0.99, rationale: "Overrule." });
    await woSessionJobs.classify();
    expect(edge.calls).toHaveLength(0);
    const wo = await w.get(id);
    expect(wo.cls).toBe("chore");
    expect(wo.clsConfidence).toBe(1);
  });

  it("a person who reclassifies while the agent works keeps their class", async () => {
    const id = (await w.submit("p-tomas", { title: "Fix the rounding bug in refunds" })).body.id as string;
    expect((await w.call("p-asha", "POST", `/api/v1/work-orders/${id}/reclassify`, { cls: "docs", reason: "It is a docs matter." })).status).toBe(200);
    edge.respond = setClass({ cls: "security", confidence: 0.9, rationale: "Agent says security." });
    await woSessionJobs.classify();
    expect((await w.get(id)).cls).toBe("docs");
  });

  it("with no usable model the keyword match stands, labelled as rule-based, and the fallback form has no canned chips and invents no model, tokens or cost", async () => {
    edge.ready = { ready: false, code: "no_model", reason: "No model vendor is connected." };
    const id = (await w.submit("p-tomas", { title: "Fix the rounding bug in refunds" })).body.id as string;
    expect(await woSessionJobs.classify()).toBe(0);
    expect(edge.calls).toHaveLength(0);
    const wo = await w.get(id);
    expect(wo.cls).toBe("bug");
    expect(wo.clsRationale).toMatch(/^Rule-based keyword match: no agent set the class \(No model vendor is connected/);
    expect(wo.conv.questions.map((x: { id: string }) => x.id)).toEqual(["scope", "ac", "extra"]);
    expect(wo.conv.questions.every((x: { chips: string[] }) => x.chips.length === 0)).toBe(true);
    expect(wo.conv.messages.every((m: { from: string; scripted?: boolean }) => m.from === "system" && m.scripted === true)).toBe(true);
    const [row] = await w.q(`select data from work_orders where id = $1`, [id]);
    expect(row.data.history.every((h: { tokens: number; cost: number }) => h.tokens === 0 && h.cost === 0)).toBe(true);
  });

  it("a claim left 'running' by a crashed API is claimed again once stale, and not before", async () => {
    const id = (await w.submit("p-tomas", { title: "Fix the rounding bug in refunds" })).body.id as string;
    const mark = (at: number) => w.q(`update work_orders set data = data || jsonb_build_object('classifyPending', 'running', 'classifyClaimedAt', $2::bigint) where id = $1`, [id, at]);
    await mark(Date.now());
    edge.respond = setClass({ cls: "security", confidence: 0.8, rationale: "Agent reads it as security." });
    expect(await woSessionJobs.classify()).toBe(0);
    expect(edge.calls).toHaveLength(0);
    await mark(Date.now() - 10 * 60_000);
    expect(await woSessionJobs.classify()).toBe(1);
    expect((await w.get(id)).cls).toBe("security");
  });

  it("eval and onboarding work orders are never queued for a metered classification", async () => {
    const r = await w.submit("p-tomas", { title: "Fix the rounding bug in refunds" });
    const id = r.body.id as string;
    await w.q(`update work_orders set source = 'eval', data = data || '{"classifyPending":"pending"}'::jsonb where id = $1`, [id]);
    edge.respond = setClass({ cls: "security", confidence: 0.9, rationale: "Should never be asked." });
    expect(await woSessionJobs.classify()).toBe(0);
    expect(edge.calls).toHaveLength(0);
    expect((await w.q(`select class, data->>'classifyPending' p from work_orders where id = $1`, [id]))[0]).toMatchObject({ class: "bug", p: "pending" });
  });

  it("a vendor drop during classification is retried once after a pause, then settles as failed", async () => {
    const id = (await w.submit("p-tomas", { title: "Fix the rounding bug in refunds" })).body.id as string;
    const down = { blocks: [], status: 502, error: { type: "api_error", message: "The model vendor could not be reached. This is usually temporary: try again." } };
    edge.script = [down, down] as never;
    const state = async () => (await w.q(`select data->>'classifyPending' p from work_orders where id = $1`, [id]))[0].p;
    const due = () => w.q(`update work_orders set data = jsonb_set(data, '{classifyRetryAt}', '0') where id = $1`, [id]);
    await woSessionJobs.classify();
    expect(await state()).toBe("pending");
    const calls = edge.calls.length;
    await woSessionJobs.classify();
    expect(edge.calls.length).toBe(calls); // not due: no tight loop
    await due();
    await woSessionJobs.classify();
    expect(await state()).toBe("failed");
    expect(edge.calls.length).toBe(calls + 1);
  });

  it("an agent that finishes without calling set_class leaves the labelled rule-based class", async () => {
    const id = (await w.submit("p-tomas", { title: "Fix the rounding bug in refunds" })).body.id as string;
    edge.respond = () => ({ blocks: [{ type: "text" as const, text: "I looked but will not decide." }] });
    expect(await woSessionJobs.classify()).toBe(0);
    const wo = await w.get(id);
    expect(wo.cls).toBe("bug");
    expect(wo.clsRationale).toMatch(/^Rule-based keyword match: no agent set the class \(The agent returned no class\./);
    const [row] = await w.q(`select data from work_orders where id = $1`, [id]);
    expect(row.data.classifyPending).toBe("rule");
  });

  it("the cost of a classification is recorded even when set_class is refused", async () => {
    const id = (await w.submit("p-tomas", { title: "Fix the rounding bug in refunds" })).body.id as string;
    edge.respond = setClass({ cls: "made-up", confidence: 0.9, rationale: "Because it is." });
    await woSessionJobs.classify();
    const rows = await w.q(`select data from workorder_messages where wo_id = $1 and data->>'event' = 'agent.classified'`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].data.costMicros).not.toBeNull();
    expect(rows[0].data.usage).toBeTruthy();
  });
});
