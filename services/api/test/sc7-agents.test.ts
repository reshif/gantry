import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const ADMIN = "p-asha";

d("sc7 skill candidates", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp(); });
  afterAll(() => t.close());
  const w = world(() => t);
  const q = w.q;
  let n = 0;
  const key = (): Record<string, string> => ({ "idempotency-key": `sc7-${Date.now()}-${n++}` });
  const agent = async (id: string) => (await w.call(ADMIN, "GET", "/api/v1/agents")).body.find((a: any) => a.id === id);
  const skill = async (id: string) => (await w.call(ADMIN, "GET", "/api/v1/skills")).body.find((s: any) => s.id === id);
  const makeSkill = async (name: string, body: string) => (await w.call(ADMIN, "POST", "/api/v1/skills", { name, body, when: "always" }, key())).body.skill.id as string;
  const makeAgent = async (name: string, skills: string[]) =>
    (await w.call(ADMIN, "POST", "/api/v1/agents", { name, station: "close", model: "claude-sonnet-5-5", autonomy: "gate", stations: ["close"], budget: 2, instructions: "Close the work order.", skills }, key())).body.agent.id as string;
  const editSkill = async (id: string, patch: object, note: string) => w.call(ADMIN, "PATCH", `/api/v1/skills/${id}`, { patch, note }, { "if-match": String((await skill(id)).rev) });
  const passRun = async (ag: string, version: string) => {
    const suite = (await q(`select data->>'suite' as s from agents where id = $1`, [ag]))[0].s;
    await q(`insert into eval_runs (org_id, id, suite_id, status, score, data) values ($1,$2,$3,'completed',0.95,$4::jsonb)`, [t.orgId, `RUN-SC7-${n++}`, suite, JSON.stringify({ agent: ag, version })]);
  };
  const promote = (ag: string, v: string) => w.call(ADMIN, "POST", `/api/v1/agents/${ag}/versions/${v}/promote`);
  const live = async (ag: string) => { const a = (await q(`select live_version from agents where id = $1`, [ag]))[0]; return (await q(`select body from agent_versions where agent_id = $1 and version = $2`, [ag, a.live_version]))[0].body; };

  it("K1: two skill edits cut two candidates from the same floor; promoting both leaves the first skill's edit out", async () => {
    const s1 = await makeSkill("Sc7 first", "First v1."); const s2 = await makeSkill("Sc7 second", "Second v1.");
    const ag = await makeAgent("Sc7 Agent K1", [s1, s2]);
    expect((await editSkill(s1, { body: "First v2." }, "edit first")).status).toBe(200);
    expect((await editSkill(s2, { body: "Second v2." }, "edit second")).status).toBe(200);
    const labels = (await q(`select version, body->>'label' as label, body->'skillVersions' as sv from agent_versions where agent_id = $1 order by version`, [ag]));
    const [c1, c2] = [labels[1].label, labels[2].label];
    await passRun(ag, c1); await passRun(ag, c2);
    const p1 = await promote(ag, c1);
    const p2 = await promote(ag, c2);
    expect(p1.status).toBe(200);
    expect(p2.status, "the second candidate was cut from a floor that moved").toBe(409);
    expect(String(p2.body.msg)).toMatch(/floor moved; re-cut the candidate/);
    const body = await live(ag);
    expect(body.skillVersions, "the floor keeps the first promotion").toEqual({ [s1]: 2, [s2]: 1 });
  });

  it("K2: a skill candidate cut before an instruction change is promoted after it and takes the instruction change off the floor", async () => {
    const s1 = await makeSkill("Sc7 third", "Third v1.");
    const ag = await makeAgent("Sc7 Agent K2", [s1]);
    // the floor is 0.1.0 (first version); a skill edit cuts candidate from it
    expect((await editSkill(s1, { body: "Third v2." }, "edit")).status).toBe(200);
    // a person then edits the instructions and cuts and promotes a version with it
    expect((await w.call(ADMIN, "PATCH", `/api/v1/agents/${ag}`, { patch: { instructions: "Close the work order and write the summary." } }, { "if-match": String((await agent(ag)).rev) })).status).toBe(200);
    const cut = await w.call(ADMIN, "POST", `/api/v1/agents/${ag}/versions`, { label: "0.9.0", note: "instr" }, { "if-match": String((await agent(ag)).rev) });
    expect(cut.status, JSON.stringify(cut.body)).toBe(200);
    await passRun(ag, "0.9.0");
    expect((await promote(ag, "0.9.0")).status).toBe(200);
    expect((await live(ag)).instructions).toBe("Close the work order and write the summary.");
    const cand = (await q(`select body->>'label' as label from agent_versions where agent_id = $1 and body->'source'->>'type' = 'skill.edit'`, [ag]))[0].label;
    await passRun(ag, cand);
    const pr = await promote(ag, cand);
    expect(pr.status).toBe(409);
    expect((await live(ag)).instructions, "the instruction change stays on the floor").toBe("Close the work order and write the summary.");
  });
});
