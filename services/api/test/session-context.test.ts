import { withTx } from "@gantry/db";
import { RepoFacts, assess, type AssessContext } from "@gantry/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureConsoleEdge, resetConsoleEdge } from "../src/areas/console/model.js";
import { applyAssessment } from "../src/areas/onboarding/apply.js";
import { configureSessionBroker, resetSessionBroker } from "../src/areas/onboarding/session/broker.js";
import { FakeEdge, parseSse } from "./console-edge.js";
import { world } from "./flow-helpers.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const tomas = "p-tomas"; // engineer on payments
const lena = "p-lena"; // project admin on identity (onboarding)
const asha = "p-asha"; // factory admin
const SHA = (c: string) => c.repeat(40).slice(0, 40);

/**
 * Every conversational surface speaks with the configured agent: its live version's instructions and its skills, composed through the same composer as a station run,
 * with the factory base and the project overlay; only the facts and the fixed rules come from code. Each turn records the tuple it ran with.
 */
d("conversational agents use their configured context", () => {
  let t: TestApp;
  const edge = new FakeEdge();
  let n = 0;
  const w = world(() => t);
  const q = w.q;
  const call = async (who: string, method: "GET" | "POST" | "PUT", u: string, payload?: unknown) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method, url: u, headers: { ...s.headers, "idempotency-key": `k-${++n}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
    const sse = String(r.headers["content-type"] ?? "").includes("text/event-stream");
    return { status: r.statusCode, body: sse ? ({} as Record<string, any>) : (r.json() as Record<string, any>), events: sse ? parseSse(r.body) : [] };
  };
  const facts = () => RepoFacts.parse({ repo: "acme/x", defaultBranch: "main", headSha: SHA("a"), language: "TypeScript", files: ["package.json", "src/index.ts"], contents: { "package.json": "{}" }, secrets: { scanned: 2, complete: true, hits: [] }, protection: null });
  const actx: AssessContext = { guidelines: [{ id: "gl-1", text: "CI", required: true }], mcp: [], requiredChecks: ["ci/test"] };

  /** Gives an agent's live version a recognisable instruction text, and one of its skills a recognisable body. */
  const mark = async (agent: string, text: string, skill?: { id: string; text: string }) => {
    await q(
      `insert into agent_versions (org_id, agent_id, version, body, model_id, published_at)
       select org_id, agent_id, (select max(version) + 1 from agent_versions where org_id = $1 and agent_id = $2), jsonb_set(body, '{instructions}', to_jsonb($3::text)), model_id, now()
         from agent_versions where org_id = $1 and agent_id = $2 and version = (select live_version from agents where org_id = $1 and id = $2)`,
      [t.orgId, agent, text],
    );
    await q(`update agents set live_version = (select max(version) from agent_versions where org_id = $1 and agent_id = $2), data = jsonb_set(data, '{promoted}', coalesce(data->'promoted', '[]'::jsonb) || to_jsonb((select max(version) from agent_versions where org_id = $1 and agent_id = $2))) where org_id = $1 and id = $2`, [t.orgId, agent]);
    if (skill) {
      await q(
        `insert into skill_versions (org_id, skill_id, version, body, published_at)
         select org_id, skill_id, (select max(version) + 1 from skill_versions where org_id = $1 and skill_id = $2), jsonb_set(body, '{body}', to_jsonb($3::text)), now()
           from skill_versions where org_id = $1 and skill_id = $2 and version = (select live_version from skills where org_id = $1 and id = $2)`,
        [t.orgId, skill.id, skill.text],
      );
      await q(`update skills set live_version = (select max(version) from skill_versions where org_id = $1 and skill_id = $2) where org_id = $1 and id = $2`, [t.orgId, skill.id]);
    }
  };
  const tuple = async (id: string) => (await q(`select * from agent_version_tuples where org_id = $1 and id = $2`, [t.orgId, id]))[0];

  beforeAll(async () => {
    await edge.start();
    configureConsoleEdge({ baseUrl: edge.url });
    configureSessionBroker(async () => ({ ok: true, facts: facts() }));
    t = await startApp({ seedAudit: true, seedEvals: true });
  });
  afterAll(async () => { resetConsoleEdge(); resetSessionBroker(); await edge.stop(); await t.close(); });
  beforeEach(() => edge.reset());

  describe("Intake interview and work-order session", () => {
    it("composes the Intake Clerk's live instructions, its skills, the factory base and the project overlay; code adds only the facts and the rails; the turn records its tuple", async () => {
      await mark("ag-intake", "INTAKE-CLERK-OWN-WORDS: interview the way this text says.", { id: "sk-intake", text: "SKILL-INTAKE-BODY: ask one thing at a time." });
      await q(`insert into instruction_versions (org_id, scope, scope_id, version, body, hash, published_at) values ($1,'base','',91,'BASE-RULES-91',$2,now())`, [t.orgId, "a".repeat(64)]);
      await q(`insert into instruction_versions (org_id, scope, scope_id, version, body, hash, published_at) values ($1,'project','payments',91,'OVERLAY-PAYMENTS-91',$2,now())`, [t.orgId, "b".repeat(64)]);
      const sub = await w.submit(tomas);
      expect(sub.status, JSON.stringify(sub.body)).toBe(200);
      const id = sub.body.id as string;
      edge.script = [{ blocks: [{ type: "text", text: "Hello, I read your request." }] }];
      const open = await call(tomas, "POST", `/api/v1/work-orders/${id}/session/messages`, { kind: "open" });
      expect(open.status).toBe(200);
      const sys = String(edge.calls[0]!.body.system);
      expect(sys).toContain("## Factory base\n\nBASE-RULES-91");
      expect(sys).toContain("## Project overlay\n\nOVERLAY-PAYMENTS-91");
      expect(sys).toContain("## Agent\n\nINTAKE-CLERK-OWN-WORDS");
      expect(sys).toContain("## Skill: ");
      expect(sys).toContain("SKILL-INTAKE-BODY");
      expect(sys).toContain(`about ${id}`);
      expect(sys.indexOf("## Agent")).toBeLessThan(sys.indexOf("## Skill:"));
      expect(sys.indexOf("## Skill:")).toBeLessThan(sys.indexOf("Fixed rules of this conversation"));
      // The interview policy is the agent's: code no longer dictates how many questions to ask.
      expect(sys).not.toContain("at most two questions");

      const s = (await call(tomas, "GET", `/api/v1/work-orders/${id}/session`)).body;
      const ctx = s.messages.at(-1).data.context;
      expect(ctx).toMatchObject({ surface: "intake", agent: "ag-intake", agentVersion: expect.any(Number) });
      expect(ctx.skillVersions["sk-intake"]).toEqual(expect.any(Number));
      expect(ctx.instructionHash).toMatch(/^[0-9a-f]{64}$/);
      expect(ctx.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(ctx.layers.map((l: any) => l.name)).toEqual(expect.arrayContaining(["Factory base", "Project overlay", "Agent"]));
      const tup = await tuple(ctx.tupleId);
      expect(tup).toMatchObject({ agent_id: "ag-intake", agent_version: ctx.agentVersion, instruction_hash: ctx.instructionHash, harness_version: "session" });
      expect(tup.skill_versions).toEqual(ctx.skillVersions);
      const ev = (await q(`select after from events where type = 'wo.session.answer' and wo_id = $1 order by seq desc limit 1`, [id]))[0].after;
      expect(ev).toMatchObject({ agent: "ag-intake", tuple: ctx.tupleId, instructionHash: ctx.instructionHash, promptHash: ctx.promptHash });
    });

    it("a later edit to the live instructions is seen by the next turn, and the tuple changes with it", async () => {
      const sub = await w.submit(tomas);
      const id = sub.body.id as string;
      edge.script = [{ blocks: [{ type: "text", text: "One." }] }];
      await call(tomas, "POST", `/api/v1/work-orders/${id}/session/messages`, { kind: "open" });
      const first = (await call(tomas, "GET", `/api/v1/work-orders/${id}/session`)).body.messages.at(-1).data.context;
      await mark("ag-intake", "INTAKE-CLERK-SECOND-TEXT");
      edge.reset();
      edge.script = [{ blocks: [{ type: "text", text: "Two." }] }];
      await call(tomas, "POST", `/api/v1/work-orders/${id}/session/messages`, { text: "ok" });
      expect(String(edge.calls[0]!.body.system)).toContain("INTAKE-CLERK-SECOND-TEXT");
      const second = (await call(tomas, "GET", `/api/v1/work-orders/${id}/session`)).body.messages.at(-1).data.context;
      expect(second.instructionHash).not.toBe(first.instructionHash);
      expect(second.tupleId).not.toBe(first.tupleId);
    });

    it("a work order whose station agent is overridden talks with that agent's instructions", async () => {
      await mark("ag-spec", "SPEC-WRITER-OWN-WORDS");
      const sub = await w.submit(tomas);
      const id = sub.body.id as string;
      await q(`update work_orders set data = jsonb_set(data, '{agentOverride}', '{"intake":"ag-spec"}') where org_id = $1 and id = $2`, [t.orgId, id]);
      edge.script = [{ blocks: [{ type: "text", text: "Spec here." }] }];
      const open = await call(tomas, "POST", `/api/v1/work-orders/${id}/session/messages`, { kind: "open" });
      expect(open.status).toBe(200);
      const sys = String(edge.calls[0]!.body.system);
      expect(sys).toContain("SPEC-WRITER-OWN-WORDS");
      expect(sys).not.toContain("INTAKE-CLERK-SECOND-TEXT");
      expect((await call(tomas, "GET", `/api/v1/work-orders/${id}/session`)).body.messages.at(-1).data.context).toMatchObject({ agent: "ag-spec" });
    });
  });

  describe("onboarding session", () => {
    it("composes the Onboarding Agent's live instructions and skills (not a hardcoded prompt) and records its tuple", async () => {
      await mark("ag-onboard", "ONBOARDING-AGENT-OWN-WORDS: author the repository scaffold this way.");
      const r = await call(lena, "POST", "/api/v1/projects/identity/repos", { name: `acme/ctx-${++n}` });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const id = r.body.repo.id as string;
      const runId = ((await q(`select data from repos where org_id = $1 and id = $2`, [t.orgId, id]))[0].data.onboarding as any).runId as string;
      await withTx(t.db.app, (tx) => applyAssessment(tx, t.orgId, { repoId: id, runId, now: new Date(), result: { kind: "ok", findings: assess(facts(), actx), language: "TypeScript", defaultBranch: "main", headSha: SHA("a") } }));
      edge.script = [{ blocks: [{ type: "text", text: "I read the repo." }] }];
      const open = await call(lena, "POST", `/api/v1/repos/${id}/onboarding/session/messages`, { kind: "open" });
      expect(open.status).toBe(200);
      const sys = String(edge.calls[0]!.body.system);
      expect(sys).toContain("## Agent\n\nONBOARDING-AGENT-OWN-WORDS");
      expect(sys).toMatch(/## Skill: /);
      expect(sys).toMatch(/Repository acme\/ctx-\d+ in project identity/);
      expect(sys).toContain("Rails you cannot cross");
      // The long authoring playbook is the agent's configuration now, not code.
      expect(sys).not.toContain("a new or empty repository usually needs a project scaffold");
      const ctx = (await call(lena, "GET", `/api/v1/repos/${id}/onboarding/session`)).body.messages.at(-1).data.context;
      expect(ctx).toMatchObject({ surface: "onboarding", agent: "ag-onboard" });
      expect(Object.keys(ctx.skillVersions).length).toBeGreaterThan(0);
      const tup = await tuple(ctx.tupleId);
      expect(tup).toMatchObject({ agent_id: "ag-onboard", instruction_hash: ctx.instructionHash });
      expect((await q(`select after from events where type = 'onboarding.session.answer' and subject->>'id' = $1 order by seq desc limit 1`, [id]))[0].after).toMatchObject({ tuple: ctx.tupleId, promptHash: ctx.promptHash });
    });
  });

  describe("console", () => {
    const ask = async (who: string, text: string) => {
      const s = await t.session(who);
      const r = await t.app.inject({ method: "POST", url: "/api/v1/console/messages", headers: s.headers, payload: { text } });
      return { status: r.statusCode, events: parseSse(r.body) };
    };

    it("lists every surface's binding; unbound, the console runs on Gantry's fixed rules and says so", async () => {
      const res = await call(asha, "GET", "/api/v1/agents/bindings");
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const b = res.body.surfaces as Array<Record<string, any>>;
      expect(b.map((s) => s.surface)).toEqual(["intake", "work_order", "onboarding", "console"]);
      expect(b.find((s) => s.surface === "intake")).toMatchObject({ agent: "ag-intake", source: "station", configurable: false });
      expect(b.find((s) => s.surface === "onboarding")).toMatchObject({ agent: "ag-onboard", source: "fixed" });
      expect(b.find((s) => s.surface === "console")).toMatchObject({ agent: null, source: "none", configurable: true });
      edge.script = [{ blocks: [{ type: "text", text: "Fine." }], stop: "end_turn" }];
      await ask(tomas, "Hello?");
      expect(String(edge.calls[0]!.body.system)).toContain("You are the Gantry console");
      expect(String(edge.calls[0]!.body.system)).not.toContain("## Agent");
    });

    it("binding is permissioned and audited; a bound agent's instructions and skills reach the console's prompt, with the tuple recorded", async () => {
      expect((await call(tomas, "PUT", "/api/v1/agents/bindings/console", { agent: "ag-review" })).status).toBe(403);
      expect((await call(asha, "PUT", "/api/v1/agents/bindings/console", { agent: "ag-nope" })).status).toBe(404);
      await mark("ag-review", "CONSOLE-AGENT-OWN-WORDS: answer as a careful reviewer.");
      const ok = await call(asha, "PUT", "/api/v1/agents/bindings/console", { agent: "ag-review" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await q(`select before, after from events where type = 'agent.binding' order by seq desc limit 1`))[0]).toMatchObject({ before: { agent: null }, after: { agent: "ag-review" } });
      expect(((await call(asha, "GET", "/api/v1/agents/bindings")).body.surfaces as any[]).find((s) => s.surface === "console")).toMatchObject({ agent: "ag-review", agentName: "Reviewer", source: "binding" });

      edge.script = [{ blocks: [{ type: "text", text: "As asked." }], stop: "end_turn" }];
      const r = await ask(tomas, "Who can approve G2 on payments?");
      expect(r.status).toBe(200);
      const sys = String(edge.calls[0]!.body.system);
      expect(sys).toContain("## Agent\n\nCONSOLE-AGENT-OWN-WORDS");
      expect(sys).toMatch(/## Skill: /);
      expect(sys).toContain("their console is read-only");
      expect(sys).toContain("<untrusted>");
      const th = (await call(tomas, "GET", "/api/v1/console/threads")).body;
      const thread = (await call(tomas, "GET", `/api/v1/console/threads/${th.items[0].id}`)).body;
      const ctx = thread.messages.at(-1).data.context;
      expect(ctx).toMatchObject({ surface: "console", agent: "ag-review" });
      expect((await tuple(ctx.tupleId)).agent_id).toBe("ag-review");

      // Unbinding returns the console to the fixed rules.
      expect((await call(asha, "PUT", "/api/v1/agents/bindings/console", { agent: null })).status).toBe(200);
      edge.reset();
      edge.script = [{ blocks: [{ type: "text", text: "Plain." }], stop: "end_turn" }];
      await ask(tomas, "Again?");
      expect(String(edge.calls[0]!.body.system)).not.toContain("CONSOLE-AGENT-OWN-WORDS");
    });
  });
});
