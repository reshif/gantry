import { RepoFacts } from "@gantry/domain";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureConsoleEdge, resetConsoleEdge } from "../src/areas/console/model.js";
import { configureSessionBroker, resetSessionBroker } from "../src/areas/onboarding/session/broker.js";
import { woSessionJobs } from "../src/routes/workorder-session.js";
import { FakeEdge, parseSse } from "./console-edge.js";
import { world } from "./flow-helpers.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const tomas = "p-tomas"; // engineer on payments: submits, may confirm briefs
const rui = "p-rui"; // viewer on payments: reads only
const lena = "p-lena"; // no access to payments
const asha = "p-asha"; // factory admin

d("the work-order session", () => {
  let t: TestApp;
  const edge = new FakeEdge();
  let n = 0;
  const w = world(() => t);
  const q = w.q;
  const url = (id: string, tail = "") => `/api/v1/work-orders/${id}/session${tail}`;
  const call = async (who: string, method: "GET" | "POST", u: string, payload?: unknown) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method, url: u, headers: { ...s.headers, "idempotency-key": `k-${++n}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
    const sse = String(r.headers["content-type"] ?? "").includes("text/event-stream");
    return { status: r.statusCode, body: sse ? ({} as Record<string, any>) : (r.json() as Record<string, any>), events: sse ? parseSse(r.body) : [] };
  };
  const facts = () => RepoFacts.parse({ repo: "acme/payments-api", defaultBranch: "main", headSha: "a".repeat(40), language: "TypeScript", files: ["package.json", "src/refunds.ts"], contents: { "package.json": "{}" }, secrets: { scanned: 2, complete: true, hits: [] }, protection: null });

  beforeAll(async () => {
    await edge.start();
    configureConsoleEdge({ baseUrl: edge.url });
    configureSessionBroker(async () => ({ ok: true, facts: facts() }));
    t = await startApp();
  });
  afterAll(async () => { resetConsoleEdge(); resetSessionBroker(); await edge.stop(); await t.close(); });
  beforeEach(() => edge.reset());
  afterEach(async () => { await q(`delete from stops where org_id = $1`, [t.orgId]); });

  const submit = async () => {
    const r = await w.submit(tomas);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  };
  const BRIEF = {
    goal: "Accept an Idempotency-Key header on refund requests so client retries never refund twice.", scopeIn: ["POST /refunds accepts Idempotency-Key", "Replays return the first response"], scopeOut: ["Other endpoints"],
    ac: ["A repeated key returns the original refund without a second charge", "A missing key behaves as before"], risks: ["Key storage grows"], open: ["How long are keys kept?"], estimate: "2 days", summary: "Idempotency for refunds, 2 criteria.",
  };

  describe("with the Intake Clerk", () => {
    it("never shows or feeds the model Gantry's scripted questions; an epic's children are the agent's proposal, applied on approval, and nobody is awaited after the confirm (G-01)", async () => {
      const r = await w.submit(tomas, { title: "Three Nautobot report jobs for the network team", requestedCls: "epic" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const id = r.body.id as string;
      let s = (await call(tomas, "GET", url(id))).body;
      expect(s.agent.mode).toBe("agent");
      expect(s.messages.some((m: any) => m.data?.scripted || /Intake Clerk|What is in scope/.test(m.text))).toBe(false);
      edge.script = [{ blocks: [{ type: "tool_use", id: "t1", name: "propose_brief", input: { ...BRIEF, children: ["Interfaces report: interfaces by location", "Cables report: cable inventory"] } }] }, { blocks: [{ type: "text", text: "I drafted the brief with a proposed split; it waits for your approval." }] }];
      expect((await call(tomas, "POST", url(id, "/messages"), { text: "Please draft the brief." })).status).toBe(200);
      const sent = JSON.stringify(edge.calls[0]!.body.messages);
      expect(sent).not.toMatch(/What is in scope|Scripted intake/);
      expect(sent).toContain("Please draft the brief.");
      s = (await call(tomas, "GET", url(id))).body;
      const msg = s.messages.at(-1);
      const card = msg.data.cards.find((c: any) => c.kind === "proposal");
      expect(card.changes.find((c: any) => c.field === "children").added).toEqual(["Interfaces report: interfaces by location", "Cables report: cable inventory"]);
      expect((await w.get(id)).brief.children).toEqual([]);
      const ok = await call(tomas, "POST", url(id, `/proposals/${msg.id}/${card.id}`), { decision: "approve" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const wo = await w.get(id);
      expect(wo.brief.children).toEqual(["Interfaces report: interfaces by location", "Cables report: cable inventory"]);
      expect(wo.conv.awaiting).toBe("nobody");
    });

    it("reads the work order and the repo, asks in natural language with suggestions, drafts the brief as a proposal with its diff; Approve confirms the brief through the ordinary command and passes G0+G1", async () => {
      const id = await submit();
      edge.script = [
        { blocks: [{ type: "tool_use", id: "t1", name: "get_work_order", input: {} }, { type: "tool_use", id: "t2", name: "inspect_repository", input: {} }] },
        { blocks: [{ type: "tool_use", id: "t3", name: "ask_user", input: { question: "How long should an idempotency key be remembered?", options: ["24 hours", "7 days"] } }] },
        { blocks: [{ type: "text", text: "I read the request and the repo. One thing I need from you." }] },
      ];
      const open = await call(tomas, "POST", url(id, "/messages"), { kind: "open" });
      expect(open.status).toBe(200);
      expect(open.events.map((e) => e.event)).toEqual(expect.arrayContaining(["text", "tool", "card", "done"]));
      expect(edge.calls[0]!.headers["x-gantry-purpose"]).toBe("console");
      expect(edge.calls[0]!.headers["x-gantry-model-pick"]).toBeTruthy();
      expect(edge.calls[0]!.body.max_tokens).toBe(16_000);
      expect(JSON.stringify(edge.calls[1]!.body.messages)).toContain("<untrusted>");
      let s = (await call(tomas, "GET", url(id))).body;
      expect(s.agent).toMatchObject({ mode: "agent", name: "Intake Clerk", station: "intake" });
      expect(s.messages.at(-1)).toMatchObject({ role: "assistant", author: "ag-intake" });
      expect(s.messages.at(-1).data.cards.find((c: any) => c.kind === "question")).toMatchObject({ options: ["24 hours", "7 days"] });
      expect(s.next).toMatchObject({ actor: "you" });
      expect(s.can).toMatchObject({ talk: true, confirm: true });

      // A person's free text always gets an answer, and the open question is marked answered.
      edge.script = [
        { blocks: [{ type: "tool_use", id: "t4", name: "propose_brief", input: BRIEF }] },
        { blocks: [{ type: "text", text: "Thanks. I drafted the brief; it waits for your approval. I read this as a feature." }] },
      ];
      const talk = await call(tomas, "POST", url(id, "/messages"), { text: "7 days is fine, then gimme a brief" });
      expect(talk.status).toBe(200);
      s = (await call(tomas, "GET", url(id))).body;
      const asked = s.messages.find((m: any) => m.role === "assistant" && m.data.cards?.some((c: any) => c.kind === "question"));
      expect(asked.data.cards.find((c: any) => c.kind === "question").answered).toMatch(/7 days/);
      const msg = s.messages.at(-1);
      expect(msg.text).toMatch(/waits for your approval/);
      const card = msg.data.cards.find((c: any) => c.kind === "proposal");
      expect(card).toMatchObject({ what: "brief", mode: "agent", status: "pending" });
      expect(card.changes.find((c: any) => c.field === "goal").added[0]).toMatch(/Idempotency-Key/);
      expect(card.route.length).toBeGreaterThan(2);
      expect(s.pending).toHaveLength(1);
      expect(s.next).toMatchObject({ actor: "you" });
      // The brief has not changed and the gate is still open.
      expect((await w.get(id)).gates.G0G1.status).toBe("waiting");
      expect((await q(`select 1 from brief_versions where wo_id = $1`, [id])).length).toBe(0);

      // A viewer may not approve; the proposal stays pending.
      expect((await call(rui, "POST", url(id, `/proposals/${msg.id}/${card.id}`), { decision: "approve" })).status).toBe(403);
      const ok = await call(tomas, "POST", url(id, `/proposals/${msg.id}/${card.id}`), { decision: "approve" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.msg).toMatch(/Brief confirmed/);
      const wo = await w.get(id);
      expect(wo.gates.G0G1.status).toBe("passed");
      const bv = (await q(`select body, confirmed_by from brief_versions where wo_id = $1`, [id]))[0];
      expect(bv.body.goal).toMatch(/Idempotency-Key/);
      expect(bv.confirmed_by).toBe(tomas);
      expect(bv.body.ac).toHaveLength(2);
      expect((await q(`select type from events where wo_id = $1 and type in ('wo.session.approved','gate.decision') order by seq`, [id])).map((e) => e.type)).toEqual(["gate.decision", "wo.session.approved"]);
      expect((await call(tomas, "POST", url(id, `/proposals/${msg.id}/${card.id}`), { decision: "approve" })).status).toBe(409);
      s = (await call(tomas, "GET", url(id))).body;
      expect(s.briefConfirmed).toBe(true);
      expect(s.messages.find((m: any) => m.id === msg.id).data.cards.find((c: any) => c.kind === "proposal").status).toBe("approved");
    });

    it("'Ask for changes' continues the dialogue and the older proposal is replaced; a refused brief gives every reason; Discard changes nothing", async () => {
      const id = await submit();
      edge.script = [{ blocks: [{ type: "tool_use", id: "t1", name: "propose_brief", input: BRIEF }] }, { blocks: [{ type: "text", text: "Drafted." }] }];
      await call(tomas, "POST", url(id, "/messages"), { kind: "open" });
      const first = (await call(tomas, "GET", url(id))).body.messages.at(-1);
      const c1 = first.data.cards.find((c: any) => c.kind === "proposal");
      const ch = await call(tomas, "POST", url(id, `/proposals/${first.id}/${c1.id}`), { decision: "changes", text: "Keys are kept 7 days; add that to scope." });
      expect(ch.status, JSON.stringify(ch.body)).toBe(200);
      edge.script = [
        { blocks: [{ type: "tool_use", id: "t2", name: "propose_brief", input: { goal: "too short", scopeIn: [], ac: [] } }] },
        { blocks: [{ type: "tool_use", id: "t3", name: "propose_brief", input: { ...BRIEF, scopeIn: [...BRIEF.scopeIn, "Keys are kept 7 days"] } }] },
        { blocks: [{ type: "text", text: "Revised." }] },
      ];
      await call(tomas, "POST", url(id, "/messages"), { kind: "continue" });
      expect(JSON.stringify(edge.calls.at(-1)!.body.messages)).toMatch(/at least a full sentence|Give at least one acceptance/);
      const s = (await call(tomas, "GET", url(id))).body;
      const cards = s.messages.flatMap((m: any) => (m.data.cards ?? []).filter((c: any) => c.kind === "proposal"));
      expect(cards.map((c: any) => c.status)).toEqual(["changes", "pending"]);
      const last = s.messages.at(-1);
      expect(last.data.cards.find((c: any) => c.kind === "proposal").brief.scopeIn).toContain("Keys are kept 7 days");
      const dis = await call(tomas, "POST", url(id, `/proposals/${last.id}/${last.data.cards.find((c: any) => c.kind === "proposal").id}`), { decision: "discard" });
      expect(dis.status).toBe(200);
      expect((await w.get(id)).gates.G0G1.status).toBe("waiting");
    });

    it("a reclassify proposal runs the ordinary reclassify command; a decline proposal declines through the ordinary command", async () => {
      const id = await submit();
      edge.script = [{ blocks: [{ type: "tool_use", id: "t1", name: "propose_reclassify", input: { cls: "bug", reason: "A refund replay is a defect, not a feature." } }] }, { blocks: [{ type: "text", text: "I read this as a bug." }] }];
      await call(tomas, "POST", url(id, "/messages"), { kind: "open" });
      let m = (await call(tomas, "GET", url(id))).body.messages.at(-1);
      const c = m.data.cards.find((x: any) => x.kind === "proposal");
      expect(c).toMatchObject({ what: "reclassify", cls: { id: "bug" } });
      const ok = await call(tomas, "POST", url(id, `/proposals/${m.id}/${c.id}`), { decision: "approve" });
      // Class overrides need wo.classify: an engineer does not have it; a line lead does.
      expect(ok.status).toBe(403);
      const lead = await call("p-meera", "POST", url(id, `/proposals/${m.id}/${c.id}`), { decision: "approve" });
      expect(lead.status, JSON.stringify(lead.body)).toBe(200);
      expect((await w.get(id)).cls).toBe("bug");
      edge.script = [{ blocks: [{ type: "tool_use", id: "t2", name: "propose_decline", input: { reason: "Duplicate of an open request." } }] }, { blocks: [{ type: "text", text: "This looks like a duplicate." }] }];
      await call(tomas, "POST", url(id, "/messages"), { text: "is this a duplicate?" });
      m = (await call(tomas, "GET", url(id))).body.messages.at(-1);
      const dc = m.data.cards.find((x: any) => x.kind === "proposal");
      expect((await call("p-meera", "POST", url(id, `/proposals/${m.id}/${dc.id}`), { decision: "approve" })).status).toBe(200);
      expect((await w.get(id)).bay).toBe("declined");
    });

    it("reads need project.view; talking needs the right to act on the work order; the requester always may; nothing is revealed to people without access", async () => {
      const id = await submit();
      expect((await call(lena, "GET", url(id))).status).toBe(404);
      expect((await call(lena, "POST", url(id, "/messages"), { text: "hi" })).status).toBe(404);
      const view = await call(rui, "GET", url(id));
      expect(view.status).toBe(200);
      expect(view.body.can).toMatchObject({ talk: false, confirm: false });
      expect((await call(rui, "POST", url(id, "/messages"), { text: "hi" })).status).toBe(403);
      expect((await call(tomas, "GET", url(id))).body.can.talk).toBe(true);
    });

    it("a model that is down says so in the thread and nothing changes", async () => {
      const id = await submit();
      edge.script = [{ blocks: [], status: 529, error: { type: "overloaded_error", message: "busy" } }];
      const turn = await call(tomas, "POST", url(id, "/messages"), { kind: "open" });
      expect(turn.events.map((e) => e.event)).toContain("error");
      const s = (await call(tomas, "GET", url(id))).body;
      expect(s.messages.at(-1)).toMatchObject({ role: "system" });
      expect(s.messages.at(-1).text).toMatch(/did not answer/);
      expect((await w.get(id)).gates.G0G1.status).toBe("waiting");
    });
  });

  describe("rule-based (no usable model)", () => {
    beforeEach(() => { edge.ready = { ready: false, code: "no_model_configured", reason: "No model is configured." }; });

    it("falls back to the scripted questionnaire, labelled; the old conversation shows as history; answers use the ordinary command; the brief confirms the old way", async () => {
      const id = await submit();
      let s = (await call(tomas, "GET", url(id))).body;
      expect(s.agent).toMatchObject({ mode: "rule-based", label: "Rule-based (no agent)" });
      expect(s.ruleQuestion).toMatchObject({ text: expect.any(String) });
      expect(s.messages.length).toBeGreaterThan(0);
      expect(s.messages[0].data.kind).toBe("legacy");
      const before = s.ruleQuestion.id;
      const r = await call(tomas, "POST", url(id, "/messages"), { text: "Keep it small and covered by tests." });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.mode).toBe("rule-based");
      s = (await call(tomas, "GET", url(id))).body;
      expect(s.ruleQuestion?.id).not.toBe(before);
      await w.answerAll(id);
      s = (await call(tomas, "GET", url(id))).body;
      expect(s.ruleReady).toBe(true);
      // Free text after the questionnaire is complete is still answered (and says what to do).
      const more = await call(tomas, "POST", url(id, "/messages"), { text: "gimme a brief" });
      expect(more.status).toBe(200);
      s = (await call(tomas, "GET", url(id))).body;
      expect(s.messages.at(-1).text).toMatch(/Rule-based \(no agent\)/);
      expect((await w.confirm(id)).status).toBe(200);
    });
  });

  describe("follow-ups", () => {
    it("station transitions and gate decisions post once into the session; the same scan posts nothing twice; classify asks the agent for a follow-up turn; people involved get the bell until they open it", async () => {
      const id = await submit();
      edge.script = [{ blocks: [{ type: "text", text: "Hello, I read the request." }] }];
      await call(tomas, "POST", url(id, "/messages"), { kind: "open" });
      await w.answerAll(id);
      expect((await w.confirm(id)).status).toBe(200);
      const first = await woSessionJobs.scan();
      expect(first).toBeGreaterThan(0);
      expect(await woSessionJobs.scan()).toBe(0);
      const s = (await call(tomas, "GET", url(id))).body;
      const updates = s.messages.filter((m: any) => m.data.kind === "update");
      expect(updates.some((m: any) => /Gate G0G1 approved/.test(m.text))).toBe(true);
      expect(updates.every((m: any) => m.role === "system")).toBe(true);
      const home = (await call(tomas, "GET", "/api/v1/home")).body;
      expect((home.conversations ?? home.waiting?.conversations ?? []).some((c: any) => c.wo === id)).toBe(true);
      await call(tomas, "POST", url(id, "/seen"));
      const home2 = (await call(tomas, "GET", "/api/v1/home")).body;
      expect((home2.conversations ?? home2.waiting?.conversations ?? []).some((c: any) => c.wo === id && /Gate G0G1/.test(c.question ?? ""))).toBe(false);
    });

    it("a work order at Intake with no session is opened by itself and the agent follows up once", async () => {
      const id = await submit();
      // Other work orders at Intake may be opened in the same sweep: answer by what was asked.
      edge.respond = (body) => (String(body.system).includes(`about ${id}`) && !JSON.stringify(body.messages).includes("tool_result")
        ? { blocks: [{ type: "tool_use", id: "t1", name: "propose_brief", input: BRIEF }] }
        : { blocks: [{ type: "text", text: "I read your request and drafted the brief." }] });
      // The agent classifies a new request first; the session opens once that is settled.
      await q(`update work_orders set data = jsonb_set(data, '{classifyPending}', '"done"') where org_id = $1 and data->>'classifyPending' in ('pending','running')`, [t.orgId]);
      while ((await q(`select 1 from workorder_messages where wo_id = $1`, [id])).length === 0) { if (!(await woSessionJobs.open())) break; }
      for (let i = 0; i < 6 && (await q(`select 1 from workorder_messages where wo_id = $1 and role = 'assistant'`, [id])).length === 0; i++) await woSessionJobs.followUps();
      expect(await woSessionJobs.followUps()).toBe(0);
      const s = (await call(tomas, "GET", url(id))).body;
      expect(s.messages.filter((m: any) => m.role === "assistant" && m.data.kind !== "legacy")).toHaveLength(1);
      expect(s.messages.at(-1).data.cards.some((c: any) => c.kind === "proposal")).toBe(true);
      // The follow-up never confirms anything.
      expect((await w.get(id)).gates.G0G1.status).toBe("waiting");
    });
  });

  describe("no brief on a guess (G7)", () => {
    it("refuses propose_brief while a blocking question is unanswered, and allows it once the person answers", async () => {
      const id = await submit();
      const brief = { goal: "Accept an Idempotency-Key header on refund requests.", scopeIn: ["Refund endpoint"], ac: ["A repeated key returns the first response"] };
      edge.script = [
        { blocks: [{ type: "tool_use", id: "t1", name: "ask_user", input: { question: "How long should a key be remembered?", options: ["24 hours"], blocking: true } }, { type: "tool_use", id: "t2", name: "propose_brief", input: brief }] },
        { blocks: [{ type: "text", text: "I need that answer first." }] },
      ];
      await call(tomas, "POST", url(id, "/messages"), { kind: "open" });
      let s = (await call(tomas, "GET", url(id))).body;
      let last = s.messages.at(-1);
      expect(last.data.cards.map((c: any) => c.kind)).toEqual(["question"]);
      expect(last.data.cards[0].blocking).toBe(true);
      const sent = edge.calls.at(-1)!.body as { messages: Array<{ content: unknown }> };
      const refusal = (sent.messages.at(-1)!.content as any[]).find((b: any) => b.type === "tool_result" && b.tool_use_id === "t2");
      expect(String(JSON.stringify(refusal))).toMatch(/blocking question is still unanswered/);
      edge.script = [{ blocks: [{ type: "tool_use", id: "t3", name: "propose_brief", input: brief }] }, { blocks: [{ type: "text", text: "Proposed." }] }];
      await call(tomas, "POST", url(id, "/messages"), { text: "24 hours." });
      s = (await call(tomas, "GET", url(id))).body;
      last = s.messages.at(-1);
      expect(last.data.cards.some((c: any) => c.kind === "proposal")).toBe(true);
    });
  });

  describe("the list", () => {
    it("lists work-order sessions with who waits on whom, the latest message and the station", async () => {
      const id = await submit();
      edge.script = [{ blocks: [{ type: "tool_use", id: "t1", name: "ask_user", input: { question: "Which endpoint?" } }] }, { blocks: [{ type: "text", text: "One question." }] }];
      await call(tomas, "POST", url(id, "/messages"), { kind: "open" });
      const r = await call(tomas, "GET", "/api/v1/work-order-sessions?project=payments");
      expect(r.status).toBe(200);
      const it = r.body.items.find((x: any) => x.id === id);
      expect(it).toMatchObject({ stationName: "Intake", agentName: "Intake Clerk", waitingOn: "you", started: true });
      expect(it.latest.text).toMatch(/One question/);
      expect((await call(lena, "GET", "/api/v1/work-order-sessions?project=payments")).body.items.some((x: any) => x.id === id)).toBe(false);
      expect((await call(asha, "GET", "/api/v1/work-order-sessions")).body.items.some((x: any) => x.id === id)).toBe(true);
    });
  });

  describe("who may approve a gate", () => {
    it("explains the rule, the progress and the eligible people, warns when the gate cannot pass, and Factory Admins count toward a rule the role holders alone could not satisfy", async () => {
      const id = await submit();
      await w.answerAll(id);
      expect((await w.confirm(id)).status).toBe(200);
      const wo = await w.walk(id, (x: any) => x.state === "waiting" && x.allowed.approve && x.allowed.approve.gate !== "G0G1");
      const gate = wo.allowed.approve.gate as string;
      const r = await call(asha, "GET", `/api/v1/work-orders/${id}/gates/${gate}/approvers`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.rule.text).toMatch(/^Needs \d approval/);
      expect(r.body.progress).toMatchObject({ have: 0 });
      expect(r.body.eligible.length).toBeGreaterThan(0);
      expect(r.body.eligible.every((e: any) => typeof e.why === "string" && e.name)).toBe(true);
      expect(r.body.eligible.map((e: any) => e.id)).toContain(asha); // a Factory Admin is a normal approver (owner decision 2026-11-19)
      expect(r.body.overrides.map((o: any) => o.id)).not.toContain(asha);
      expect(r.body.viewerCanOverride).toBe(false);
      expect(r.body.can.editRule).toBe(true);
      expect((await call(lena, "GET", `/api/v1/work-orders/${id}/gates/${gate}/approvers`)).status).toBe(404);
      // A rule the people holding its roles cannot satisfy once the author is excluded: saves (non-blocking), and says so.
      const proj = (await w.call(asha, "GET", "/api/v1/projects/payments")).body;
      const rule = { ...proj.approvers[gate], roles: ["engineer"], people: [], required: 1, sod: true, conditions: [] };
      const put = await w.call(asha, "PUT", `/api/v1/projects/payments/approvers/${gate}`, { value: rule });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect(put.body.warning ?? null).toBeNull(); // Factory Admins count, so the gate is reachable even with one Engineer
      const after = await call(asha, "GET", `/api/v1/work-orders/${id}/gates/${gate}/approvers`);
      expect(after.body.satisfiable).toBe(true);
      expect(after.body.warning ?? null).toBeNull();
      expect(after.body.rule.text).toMatch(/Needs 1 approval from Engineer · the author can.t approve/);
    });
  });
});
