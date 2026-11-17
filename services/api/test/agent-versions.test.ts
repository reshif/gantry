import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTx } from "@gantry/db";
import { loadAgentVersion, pinRunConfig, resolveSkills } from "../src/areas/agents/compose.js";
import { RESULT_TEXT, STATION_TOOLS_TEXT, systemPrompt } from "../src/areas/agents/runner-sections.js";
import { STATION_TOOLS_INSTRUCTION } from "../../../runner/wrapper/src/station-tools.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const ADMIN = "p-asha";

/** Skills are pinned by agent versions (Wave 7): a skill edit reaches a run only through a candidate version that passes the eval gate; the preview is the runner's own prompt. */
d("skills in agent versions, the eval gate and the effective preview", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t.close();
  });
  const w = world(() => t);
  const q = w.q;
  let n = 0;
  const key = (): Record<string, string> => ({ "idempotency-key": `ver-${Date.now()}-${n++}` });
  const agent = async (id: string) => (await w.call(ADMIN, "GET", "/api/v1/agents")).body.find((a: any) => a.id === id);
  const skill = async (id: string) => (await w.call(ADMIN, "GET", "/api/v1/skills")).body.find((s: any) => s.id === id);
  const makeSkill = async (name: string, body: string): Promise<string> => (await w.call(ADMIN, "POST", "/api/v1/skills", { name, body, when: "always" }, key())).body.skill.id;
  const makeAgent = async (name: string, skills: string[]): Promise<string> =>
    (await w.call(ADMIN, "POST", "/api/v1/agents", { name, station: "close", model: "claude-sonnet-5-5", autonomy: "gate", stations: ["close"], budget: 2, instructions: "Close the work order.", skills }, key())).body.agent.id;
  const editSkill = async (id: string, patch: object, note: string) => w.call(ADMIN, "PATCH", `/api/v1/skills/${id}`, { patch, note }, { "if-match": String((await skill(id)).rev) });
  const resolved = (agentId: string, version: number) =>
    withTx(t.db.admin, async (tx) => {
      const av = await loadAgentVersion(tx, t.orgId, agentId, version);
      return resolveSkills(tx, { orgId: t.orgId, agentId, body: av!.body, projectId: null });
    });
  const effective = async (id: string, query = "") => (await w.call(ADMIN, "GET", `/api/v1/agents/${id}/effective${query}`)).body;

  describe("a version pins its skills", () => {
    it("records the version of every skill in the snapshot when an agent is created and when a version is cut", async () => {
      const sk = await makeSkill("Pinned one", "Pinned body v1.");
      const ag = await makeAgent("Pin Agent", [sk]);
      const v1 = (await q(`select body from agent_versions where agent_id = $1 and version = 1`, [ag]))[0].body;
      expect(v1.skills).toEqual([sk]);
      expect(v1.skillVersions).toEqual({ [sk]: 1 });
      const cut = await w.call(ADMIN, "POST", `/api/v1/agents/${ag}/versions`, { label: "0.2.0", note: "cut" }, { "if-match": String((await agent(ag)).rev) });
      expect(cut.status, JSON.stringify(cut.body)).toBe(200);
      expect((await q(`select body from agent_versions where agent_id = $1 and version = 2`, [ag]))[0].body.skillVersions).toEqual({ [sk]: 1 });
    });

    it("keeps the old skill text for the version on the floor after the skill is edited", async () => {
      const sk = await makeSkill("Frozen text", "Frozen body v1.");
      const ag = await makeAgent("Freeze Agent", [sk]);
      const r = await editSkill(sk, { body: "Frozen body v2, with a new rule." }, "new rule");
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // the skill itself moved on, the agent version on the floor did not
      expect((await skill(sk)).body).toBe("Frozen body v2, with a new rule.");
      expect((await resolved(ag, 1)).map((s) => [s.version, s.content])).toEqual([[1, "Frozen body v1."]]);
      const pin = await withTx(t.db.admin, (tx) => pinRunConfig(tx, { orgId: t.orgId, agentId: ag, agentVersion: 1, projectId: "payments", repoId: null }));
      expect(pin!.skillVersions).toEqual({ [sk]: 1 });
    });

    it("a version from before pins existed is backfilled by the migration to what it ran with, and the stored text is untouched", async () => {
      const sk = await makeSkill("Legacy skill", "Legacy body.");
      const ag = await makeAgent("Legacy Agent", [sk]);
      // simulate a pre-pin snapshot: no skillVersions key (the immutability trigger is lifted for the setup, as the migration does)
      await q(`alter table agent_versions disable trigger agent_versions_immutable`);
      await q(`update agent_versions set body = body - 'skillVersions' where agent_id = $1`, [ag]);
      await q(`alter table agent_versions enable trigger agent_versions_immutable`);
      expect((await q(`select body from agent_versions where agent_id = $1`, [ag]))[0].body.skillVersions).toBeUndefined();
      const sql = readFileSync(fileURLToPath(new URL("../../../packages/db/migrations/0041_skill_version_pins.sql", import.meta.url)), "utf8");
      await q(sql);
      const body = (await q(`select body from agent_versions where agent_id = $1`, [ag]))[0].body;
      expect(body.skillVersions).toEqual({ [sk]: 1 });
      expect(body.instructions).toBe("Close the work order.");
      await expect(q(`update agent_versions set note = 'x' where agent_id = $1`, [ag])).rejects.toThrow(/immutable/);
    });
  });

  describe("a skill edit is a candidate, not a release", () => {
    it("cuts a candidate for the agent whose floor version has the skill, pinned to the new version, and leaves the floor alone", async () => {
      const sk = await makeSkill("Gated skill", "Gated body v1.");
      const ag = await makeAgent("Gate Agent", [sk]);
      const other = await makeAgent("Other Agent", []);
      const r = await editSkill(sk, { body: "Gated body v2." }, "tighten");
      expect(r.body.msg).toMatch(/candidate and goes live only after its eval suite passes/);
      expect(r.body.candidates).toEqual([{ agent: ag, name: "Gate Agent", version: "0.2.0", n: 2 }]);
      const a = await agent(ag);
      expect(a.versions.map((v: any) => [v.v, v.live, v.rc])).toEqual([["0.1.0", true, false], ["0.2.0", false, true]]);
      expect(a.version).toBe("0.1.0");
      expect(a.versions[1].diff).toBe("~ skillVersions (Gated skill 1.1.0)");
      const cand = (await q(`select body, note, model_id from agent_versions where agent_id = $1 and version = 2`, [ag]))[0];
      expect(cand.body).toMatchObject({ skills: [sk], skillVersions: { [sk]: 2 }, instructions: "Close the work order.", rc: true });
      expect(cand.model_id).toBe("claude-sonnet-5-5");
      expect((await resolved(ag, 1))[0]!.content).toBe("Gated body v1.");
      expect((await resolved(ag, 2))[0]!.content).toBe("Gated body v2.");
      // an unrelated agent got nothing
      expect((await agent(other)).versions).toHaveLength(1);
      // audited as an agent version caused by the skill edit
      const ev = (await w.events("agent.version")).filter((e) => e.subject.id === ag).pop()!;
      expect(ev.after).toMatchObject({ version: "0.2.0", trigger: "skill.edit", skill: sk, skillVersion: "1.1.0", from: "0.1.0" });
    });

    it("the candidate cannot go on the floor without a passing eval, and does once one has passed", async () => {
      const sk = await makeSkill("Eval skill", "Eval body v1.");
      const ag = await makeAgent("Eval Agent", [sk]);
      await editSkill(sk, { body: "Eval body v2." }, "change");
      const blocked = await w.call(ADMIN, "POST", `/api/v1/agents/${ag}/versions/0.2.0/promote`);
      expect(blocked.status).toBe(403);
      expect(JSON.stringify(blocked.body)).toMatch(/EVAL-GATE/);
      expect((await agent(ag)).version).toBe("0.1.0");
      const suite = (await agent(ag)).suite;
      await q(`insert into eval_runs (org_id, id, suite_id, status, score, data) values ($1,$2,$3,'completed',0.9,$4::jsonb)`, [t.orgId, `RUN-VER-${n++}`, suite, JSON.stringify({ agent: ag, version: "0.2.0" })]);
      const ok = await w.call(ADMIN, "POST", `/api/v1/agents/${ag}/versions/0.2.0/promote`);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await agent(ag)).version).toBe("0.2.0");
      const pin = await withTx(t.db.admin, (tx) => pinRunConfig(tx, { orgId: t.orgId, agentId: ag, agentVersion: 2, projectId: "payments", repoId: null }));
      expect(pin!.skillVersions).toEqual({ [sk]: 2 });
    });

    it("a skill attached only in the draft, a rename-free description edit and a scope change make no candidate", async () => {
      const sk = await makeSkill("Quiet skill", "Quiet body.");
      const ag = await makeAgent("Quiet Agent", []);
      await w.call(ADMIN, "PUT", `/api/v1/agents/${ag}/skills/${sk}`);
      expect((await agent(ag)).skills).toEqual([sk]);
      expect((await agent(ag)).liveSkills).toEqual([]);
      const r = await editSkill(sk, { body: "Quiet body, changed." }, "x");
      expect(r.body.candidates).toEqual([]);
      expect((await agent(ag)).versions).toHaveLength(1);
      // the next version cut from the draft picks up the latest skill version
      await w.call(ADMIN, "POST", `/api/v1/agents/${ag}/versions`, { label: "0.2.0" }, { "if-match": String((await agent(ag)).rev) });
      expect((await q(`select body from agent_versions where agent_id = $1 and version = 2`, [ag]))[0].body.skillVersions).toEqual({ [sk]: 2 });
      // description, when and resources are never sent to the model, so they need no gate
      const sk2 = await makeSkill("Described skill", "Body stays.");
      const ag2 = await makeAgent("Described Agent", [sk2]);
      const d2 = await editSkill(sk2, { desc: "A better description." }, "desc");
      expect(d2.body.candidates).toEqual([]);
      expect((await agent(ag2)).versions).toHaveLength(1);
      const sc = await w.call(ADMIN, "PUT", `/api/v1/skills/${sk2}/projects`, { projects: ["payments"] });
      expect(sc.status).toBe(200);
      expect((await agent(ag2)).versions).toHaveLength(1);
    });

    it("an agent whose draft detached the skill still gets a candidate while its live version runs it, and the candidate records its source", async () => {
      const sk = await makeSkill("Detached skill", "Detached body v1.");
      const ag = await makeAgent("Detacher", [sk]);
      await w.call(ADMIN, "DELETE", `/api/v1/agents/${ag}/skills/${sk}`);
      expect((await agent(ag)).skills).toEqual([]);
      const r = await editSkill(sk, { body: "Detached body v2." }, "after detach");
      expect(r.body.candidates).toMatchObject([{ agent: ag, version: "0.2.0" }]);
      const row = (await q(`select body, published_by from agent_versions where agent_id = $1 and version = 2`, [ag]))[0];
      expect(row.body.skillVersions).toEqual({ [sk]: 2 });
      expect(row.body.source).toMatchObject({ type: "skill.edit", skill: sk, version: "1.1.0" });
      expect(row.published_by).toBe(ADMIN);
      expect((await agent(ag)).version).toBe("0.1.0");
    });
  });

  describe("the Skills page shows live and draft", () => {
    it("liveSkills lists what the floor version runs at its pinned label; skills is the draft", async () => {
      const sk = await makeSkill("Shown skill", "Shown body.");
      const ag = await makeAgent("Shown Agent", [sk]);
      let a = await agent(ag);
      expect(a.liveSkills).toEqual([{ id: sk, version: "1.0.0" }]);
      await w.call(ADMIN, "DELETE", `/api/v1/agents/${ag}/skills/${sk}`);
      a = await agent(ag);
      expect(a.skills).toEqual([]);
      expect(a.liveSkills).toEqual([{ id: sk, version: "1.0.0" }]);
    });
  });

  describe("the effective preview is what the runner sends", () => {
    it("defaults to the live version, with every skill in full at its pinned version, then the runner's parts", async () => {
      const sk = await makeSkill("Preview skill", "Preview body, the whole text.\nSecond line.");
      const ag = await makeAgent("Preview Agent", [sk]);
      await editSkill(sk, { body: "Preview body v2." }, "v2");
      const e = await effective(ag, "?project=payments");
      expect(e).toMatchObject({ version: "0.1.0", live: true, draft: false });
      expect(e.sections.map((s: any) => s.key.split(":")[0])).toEqual(["base", "project", "agent", "skill", "station-tools", "result"]);
      expect(e.skills).toMatchObject([{ id: sk, label: "1.0.0", content: "Preview body, the whole text.\nSecond line." }]);
      expect(e.text).toContain("## Skill: Preview skill\n\nPreview body, the whole text.\nSecond line.");
      expect(e.text).not.toContain("Preview body v2.");
      expect(e.text.indexOf("## Agent")).toBeLessThan(e.text.indexOf("## Skill: Preview skill"));
      expect(e.text.indexOf("## Skill: Preview skill")).toBeLessThan(e.text.indexOf(STATION_TOOLS_TEXT));
      expect(e.text.endsWith(RESULT_TEXT)).toBe(true);
      expect(e.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(e.handoff.first).toMatch(/^Station:/);
    });

    it("the draft toggle shows the working copy: current attachments at their latest version", async () => {
      const sk = await makeSkill("Draft skill", "Draft body v1.");
      const ag = await makeAgent("Draft Agent", [sk]);
      await editSkill(sk, { body: "Draft body v2." }, "v2");
      const draft = await effective(ag, "?version=draft");
      expect(draft).toMatchObject({ version: "draft", live: false, draft: true });
      expect(draft.text).toContain("Draft body v2.");
      expect((await effective(ag)).text).toContain("Draft body v1.");
    });

    it("composes the same prompt the runner does, and the copies of the runner's texts have not drifted", () => {
      expect(STATION_TOOLS_TEXT).toBe(STATION_TOOLS_INSTRUCTION);
      const claude = readFileSync(fileURLToPath(new URL("../../../runner/wrapper/src/adapters/claude.ts", import.meta.url)), "utf8");
      expect(claude).toContain(JSON.stringify(RESULT_TEXT));
      expect(claude).toMatch(/for \(const s of spec\.skills\) parts\.push\(`## Skill: \$\{s\.name\}\\n\\n\$\{s\.content\.trim\(\)\}`\);\s+parts\.push\(STATION_TOOLS_INSTRUCTION\);\s+parts\.push\(RESULT_INSTRUCTION\);/);
      expect(systemPrompt("## Agent\n\nDo it.", [{ name: "S", content: " body " }])).toBe(`## Agent\n\nDo it.\n\n## Skill: S\n\nbody\n\n${STATION_TOOLS_INSTRUCTION}\n\n${RESULT_TEXT}`);
    });
  });
});
