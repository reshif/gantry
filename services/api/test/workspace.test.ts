import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureConsoleEdge, resetConsoleEdge } from "../src/areas/console/model.js";
import { FakeEdge, parseSse } from "./console-edge.js";
import { world } from "./flow-helpers.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const tomas = "p-tomas"; // engineer on payments
const rui = "p-rui"; // viewer on payments
const lena = "p-lena"; // no access to payments
const asha = "p-asha"; // factory admin

/**
 * The Agent Workspace (Phase 4): one inbox over every conversation, side threads with a chosen agent (read-only, in the agent's voice), sharing
 * that never widens what someone sees, archive, search over what the person may read, export, the per-person chat cap, and the operator view.
 */
d("the agent workspace", () => {
  let t: TestApp;
  const edge = new FakeEdge();
  const w = world(() => t);
  const q = w.q;
  let n = 0;
  const call = async (who: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method, url, headers: { ...s.headers, "idempotency-key": `ws-${++n}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
    const sse = String(r.headers["content-type"] ?? "").includes("text/event-stream");
    return { status: r.statusCode, text: r.body, headers: r.headers, body: sse || !String(r.headers["content-type"] ?? "").includes("json") ? ({} as Record<string, any>) : (r.json() as Record<string, any>), events: sse ? parseSse(r.body) : [] };
  };
  const setSecurity = async (patch: Record<string, unknown>) => {
    const cur = (await q<{ version: number; body: Record<string, unknown> }>(`select version, body from security_settings where org_id = $1 and published_at is not null order by version desc limit 1`, [t.orgId]))[0]!;
    await q(`insert into security_settings (org_id, version, body, published_at) values ($1, $2, $3::jsonb, now())`, [t.orgId, cur.version + 1, JSON.stringify({ ...cur.body, ...patch })]);
  };

  beforeAll(async () => {
    await edge.start();
    configureConsoleEdge({ baseUrl: edge.url });
    t = await startApp();
  });
  afterAll(async () => { resetConsoleEdge(); await edge.stop(); await t.close(); });
  beforeEach(() => edge.reset());

  it("the inbox lists the work orders' threads a person can see, with who they wait on, and pins and archive marks are the person's own", async () => {
    const id = await w.atStation("research", "Inbox listing");
    const mine = (await call(tomas, "GET", "/api/v1/workspace/inbox")).body.items as Array<Record<string, any>>;
    const it = mine.find((x) => x.key === `wo:${id}`)!;
    expect(it).toMatchObject({ kind: "primary", scope: { kind: "work_order", id }, project: "payments", archived: null, pinned: false });
    expect((await call(lena, "GET", "/api/v1/workspace/inbox")).body.items.some((x: { key: string }) => x.key === `wo:${id}`)).toBe(false);

    expect((await call(tomas, "PATCH", `/api/v1/workspace/threads/wo:${id}`, { pinned: true, archived: true })).status).toBe(200);
    const after = (await call(tomas, "GET", "/api/v1/workspace/inbox")).body.items.find((x: { key: string }) => x.key === `wo:${id}`);
    expect(after).toMatchObject({ pinned: true, archived: "me" });
    // Another person's inbox is untouched.
    expect((await call(rui, "GET", "/api/v1/workspace/inbox")).body.items.find((x: { key: string }) => x.key === `wo:${id}`)).toMatchObject({ pinned: false, archived: null });
    // A work order's own thread keeps its name and audience.
    expect((await call(tomas, "PATCH", `/api/v1/workspace/threads/wo:${id}`, { title: "Mine" })).status).toBe(422);
    expect((await call(lena, "PATCH", `/api/v1/workspace/threads/wo:${id}`, { pinned: true })).status).toBe(404);
  });

  it("a side thread with a work order's agent answers in that agent's voice, from the work order's documents, with no way to change anything", async () => {
    const id = await w.atStation("research", "Side thread");
    await q(`insert into artefacts (org_id, id, wo_id, kind, name, content_hash, media_type, doc, station, version, body) values ($1,$2,$3,'document','research.md',$4,'text/markdown','research.md','research',1,$5)`,
      [t.orgId, `doc-${id}`, id, "a".repeat(64), "# Research\n\nThe refund job runs nightly and rounds half-up."]);
    const agents = (await call(tomas, "GET", `/api/v1/workspace/agents?wo=${id}`)).body.items as Array<{ id: string; station: string; name: string }>;
    const researcher = agents.find((a) => a.station === "research")!;
    expect(researcher).toBeTruthy();
    expect((await call(lena, "GET", `/api/v1/workspace/agents?wo=${id}`)).status).toBe(404);

    const made = await call(tomas, "POST", "/api/v1/workspace/threads", { scope: { kind: "work_order", id }, agent: researcher.id });
    expect(made.status).toBe(200);
    const tid = made.body.id as string;
    expect(made.body).toMatchObject({ visibility: "project", title: `${researcher.name} about ${id}` });

    edge.script = [{ blocks: [{ type: "text", text: "I read the refund job: it rounds half-up, nightly." }], stop: "end_turn" }];
    const r = await call(tomas, "POST", "/api/v1/console/messages", { threadId: tid, text: "Why did you say half-up?" });
    expect(r.status).toBe(200);
    expect(r.events.at(-1)).toMatchObject({ event: "done", data: { text: "I read the refund job: it rounds half-up, nightly." } });
    // The call is metered on the work order and its project, not as an anonymous console call.
    expect(edge.calls[0]!.headers).toMatchObject({ "x-gantry-surface": "workorder", "x-gantry-work-order": id, "x-gantry-trace-project": "payments" });
    const sent = edge.calls[0]!.body;
    expect(String(sent.system)).toContain(`You are ${researcher.name}`);
    expect(String(sent.system)).toContain("This is a side thread. You cannot change anything here");
    expect(String(sent.system)).toContain("rounds half-up");
    expect(String(sent.system)).toContain("<untrusted>");
    expect((sent.tools as Array<{ name: string }>).some((x) => x.name.startsWith("propose_"))).toBe(false);

    const thread = (await call(tomas, "GET", `/api/v1/console/threads/${tid}`)).body;
    expect(thread.can).toEqual({ post: true, manage: true });
    const answer = thread.messages.at(-1);
    expect(answer).toMatchObject({ role: "assistant", author: researcher.id, data: { askedBy: tomas, agent: researcher.id } });
    expect(thread.messages[0]).toMatchObject({ role: "user", author: tomas });

    // Shared with the project: Rui reads it but may not post until invited; Lena cannot see it at all.
    const asRui = await call(rui, "GET", `/api/v1/console/threads/${tid}`);
    expect(asRui.status).toBe(200);
    expect(asRui.body.can).toEqual({ post: false, manage: false });
    expect((await call(rui, "POST", "/api/v1/console/messages", { threadId: tid, text: "Me too?" })).status).toBe(403);
    expect((await call(lena, "GET", `/api/v1/console/threads/${tid}`)).status).toBe(404);
    expect((await call(lena, "GET", "/api/v1/workspace/inbox")).body.items.some((x: { key: string }) => x.key === tid)).toBe(false);
    expect((await call(rui, "GET", "/api/v1/workspace/inbox")).body.items.find((x: { key: string }) => x.key === tid)).toMatchObject({ kind: "side", agent: researcher.id, mine: false, shared: true });

    // Invitations: only the owner invites, and never someone who cannot see the project.
    expect((await call(rui, "POST", `/api/v1/workspace/threads/${tid}/members`, { person: asha })).status).toBe(403);
    expect((await call(tomas, "POST", `/api/v1/workspace/threads/${tid}/members`, { person: lena })).status).toBe(422);
    expect((await call(tomas, "POST", `/api/v1/workspace/threads/${tid}/members`, { person: rui })).status).toBe(200);
    expect((await call(rui, "GET", `/api/v1/console/threads/${tid}`)).body.can.post).toBe(true);
    expect((await q(`select type from events where subject->>'id' = $1 and type like 'thread.%' order by seq`, [tid])).map((e) => e.type)).toEqual(["thread.created", "thread.member.added"]);
    // Rui leaves.
    expect((await call(rui, "DELETE", `/api/v1/workspace/threads/${tid}/members/${rui}`)).status).toBe(200);
    expect((await call(rui, "GET", `/api/v1/console/threads/${tid}`)).body.can.post).toBe(false);

    // The owner archives it for everyone: read-only, still readable and listed as archived.
    expect((await call(tomas, "PATCH", `/api/v1/workspace/threads/${tid}`, { archived: true })).status).toBe(200);
    const blocked = await call(tomas, "POST", "/api/v1/console/messages", { threadId: tid, text: "One more" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.msg).toMatch(/archived/);
    expect((await call(rui, "GET", "/api/v1/workspace/inbox")).body.items.find((x: { key: string }) => x.key === tid)).toMatchObject({ archived: "thread" });
    expect((await call(tomas, "PATCH", `/api/v1/workspace/threads/${tid}`, { archived: false, visibility: "private" })).status).toBe(200);
    expect((await call(rui, "GET", `/api/v1/console/threads/${tid}`)).status).toBe(404);
  });

  it("search finds what people and agents wrote, only where the person may read it", async () => {
    const id = await w.atStation("research", "Searchable");
    await q(`insert into workorder_messages (org_id, id, wo_id, role, author, body) values ($1,$2,$3,'assistant','ag-intake','The ledger reconciliation uses a zanzibar-style tuple store.')`, [t.orgId, `wm-s-${id}`, id]);
    await q(`insert into artefacts (org_id, id, wo_id, kind, name, content_hash, media_type, doc, station, version, body) values ($1,$2,$3,'document','research.md',$4,'text/markdown','research.md','research',1,'Findings: zanzibar tuples are cached for five minutes.')`, [t.orgId, `doc-s-${id}`, id, "b".repeat(64)]);
    const r = await call(tomas, "GET", "/api/v1/workspace/search?q=zanzibar");
    expect(r.status).toBe(200);
    const kinds = (r.body.items as Array<{ kind: string; key: string; snippet: string }>).filter((h) => h.key === `wo:${id}`);
    expect(kinds.map((h) => h.kind).sort()).toEqual(["document", "message"]);
    expect(kinds[0]!.snippet).toMatch(/⟦zanzibar/i);
    expect((await call(tomas, "GET", "/api/v1/workspace/search?q=zanzibar&kinds=document")).body.items.every((h: { kind: string }) => h.kind === "document")).toBe(true);
    expect((await call(lena, "GET", "/api/v1/workspace/search?q=zanzibar")).body.items.filter((h: { key: string }) => h.key === `wo:${id}`)).toEqual([]);
    expect((await call(tomas, "GET", "/api/v1/workspace/search?q=z")).status).toBe(422);
  });

  it("exports a conversation as markdown or JSON for someone who may read it", async () => {
    const id = await w.atStation("research", "Export me");
    await q(`insert into workorder_messages (org_id, id, wo_id, role, author, body) values ($1,$2,$3,'user',$4,'Please keep the old API.')`, [t.orgId, `wm-e-${id}`, id, tomas]);
    const md = await call(rui, "GET", `/api/v1/workspace/threads/wo:${id}/export?format=md`);
    expect(md.status).toBe(200);
    expect(String(md.headers["content-type"])).toContain("text/markdown");
    expect(md.text).toContain("Please keep the old API.");
    expect(String(md.headers["content-disposition"])).toContain(`wo-${id}.md`);
    const js = await call(rui, "GET", `/api/v1/workspace/threads/wo:${id}/export?format=json`);
    expect(JSON.parse(js.text).messages.some((m: { text: string }) => m.text === "Please keep the old API.")).toBe(true);
    expect((await call(lena, "GET", `/api/v1/workspace/threads/wo:${id}/export`)).status).toBe(404);
  });

  it("every export is audited with its size and never its text; an unreadable thread exports nothing and audits nothing", async () => {
    const id = await w.atStation("research", "Audit export");
    await q(`insert into workorder_messages (org_id, id, wo_id, role, author, body) values ($1,$2,$3,'user',$4,'Top secret phrase zebra-9.')`, [t.orgId, `wm-a-${id}`, id, tomas]);
    const events = () => q<{ category: string; project_id: string | null; actor: string; after: Record<string, unknown>; subject: { id: string } }>(`select category, project_id, actor, after, subject from events where type = 'thread.exported' and subject->>'id' = $1 order by seq`, [`wo:${id}`]);
    expect((await call(lena, "GET", `/api/v1/workspace/threads/wo:${id}/export?format=json`)).status).toBe(404);
    expect(await events()).toEqual([]);
    expect((await call(rui, "GET", `/api/v1/workspace/threads/wo:${id}/export?format=json`)).status).toBe(200);
    expect((await call(tomas, "GET", `/api/v1/workspace/threads/wo:${id}/export?format=md`)).status).toBe(200);
    const ev = await events();
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ category: "access", actor: rui, after: { format: "json" } });
    expect(ev[1]).toMatchObject({ actor: tomas, after: { format: "md" } });
    expect(ev[0]!.project_id).toBeTruthy();
    expect(Number(ev[0]!.after.messages)).toBeGreaterThan(0);
    expect(JSON.stringify(ev)).not.toContain("zebra-9");
    // A project reader of a chat shared with the project is audited too; a person outside the project gets nothing.
    const tid = (await call(tomas, "POST", "/api/v1/workspace/threads", { scope: { kind: "project", id: (await q<{ project_id: string }>(`select project_id from work_orders where id = $1`, [id]))[0]!.project_id }, visibility: "project" })).body.id as string;
    expect((await call(rui, "GET", `/api/v1/workspace/threads/${tid}/export`)).status).toBe(200);
    expect((await call(lena, "GET", `/api/v1/workspace/threads/${tid}/export`)).status).toBe(404);
    const chat = await q<{ actor: string }>(`select actor from events where type = 'thread.exported' and subject->>'id' = $1`, [tid]);
    expect(chat.map((c) => c.actor)).toEqual([rui]);
  });

  it("the per-person chat cap stops new questions once a person's chats cost that much in 24 hours", async () => {
    await setSecurity({ chatCapUsdPerDay: 0 });
    try {
      const r = await call(tomas, "POST", "/api/v1/console/messages", { text: "Anything?" });
      expect(r.status).toBe(409);
      expect(r.body.msg).toMatch(/chat allowance/);
      expect(edge.calls).toHaveLength(0);
    } finally {
      await setSecurity({ chatCapUsdPerDay: null });
    }
    edge.script = [{ blocks: [{ type: "text", text: "Fine." }], stop: "end_turn" }];
    expect((await call(tomas, "POST", "/api/v1/console/messages", { text: "Anything?" })).status).toBe(200);
  });

  it("the operator view lists waiting and over-budget work in projects where the person can act, and chat spend per person to those who see people", async () => {
    const id = await w.atStation("research", "Operator");
    await q(`update work_orders set position = 'person', data = data || $2::jsonb where id = $1`, [id, JSON.stringify({ bayFrom: "research", waitingOn: { station: "research", questions: 2, since: Date.now() - 3_600_000 }, budgetUsd: 1 })]);
    const att = (await w.liveAttempt(id)) ?? (await q(`select id from attempts where wo_id = $1 order by created_at desc limit 1`, [id]))[0];
    const run = `run-op-${id}`;
    await q(`insert into runs (org_id, id, attempt_id, wo_id, state) values ($1,$2,$3,$4,'succeeded')`, [t.orgId, run, att!.id, id]);
    await q(`insert into run_usage (org_id, run_id, attempt_id, wo_id, model_id, cost_micros) values ($1,$2,$3,$4,'m',950000)`, [t.orgId, run, att!.id, id]);
    const r = await call(asha, "GET", "/api/v1/workspace/operator");
    expect(r.status).toBe(200);
    expect(r.body.waiting.find((x: { wo: string }) => x.wo === id)).toMatchObject({ why: "Waiting for 2 answers.", station: "research", key: `wo:${id}` });
    expect(r.body.budget.find((x: { wo: string }) => x.wo === id)).toMatchObject({ costUsd: 0.95, limitUsd: 1, why: "It has used 95% of its budget." });
    expect(r.body.canSeePeople).toBe(true);
    const viewer = await call(rui, "GET", "/api/v1/workspace/operator");
    // A viewer on Payments cannot park its work, so its work orders are not theirs to act on; chat spend per person needs people.view.
    expect(viewer.body.projects).not.toContain("payments");
    expect(viewer.body.waiting.some((x: { wo: string }) => x.wo === id)).toBe(false);
    expect(viewer.body.chats.people).toEqual([]);
  });
});
