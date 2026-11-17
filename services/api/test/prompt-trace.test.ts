import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withTx } from "@gantry/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { composedParts, pinRunConfig } from "../src/areas/agents/compose.js";
import { buildManifest, encodeManifest, forHeader, manifestHash, part, RESULT_INSTRUCTION, runnerParts } from "../src/areas/agents/manifest.js";
import { configureConsoleEdge, resetConsoleEdge } from "../src/areas/console/model.js";
import { configureSessionBroker, resetSessionBroker } from "../src/areas/onboarding/session/broker.js";
import { FakeEdge } from "./console-edge.js";
import { world } from "./flow-helpers.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

describe("prompt manifest (pure)", () => {
  const layers = [{ key: "agent" as const, name: "Agent", version: 2, text: "Be careful.", hash: "a".repeat(64) }];
  const skill = { id: "sk-1", name: "Testing", version: 3, label: "3", when: "", content: "", resources: [], hash: "b".repeat(64), bytes: 9 };

  it("names every part in order with source, version, hash and size, and the hash covers all of them", () => {
    const parts = composedParts(layers, [skill]);
    expect(parts.map((p) => p.kind)).toEqual(["layer", "skill", "result_instruction", "result_schema"]);
    expect(parts[0]).toMatchObject({ name: "Agent", version: 2, sha256: "a".repeat(64), bytes: 11 });
    expect(parts[1]).toMatchObject({ name: "Testing", version: 3, source: "skill_versions sk-1", bytes: 9 });
    const base = buildManifest("run", parts, { handoff: { x: 1 } }).hash;
    expect(buildManifest("run", composedParts(layers, [{ ...skill, hash: "c".repeat(64) }])).hash).not.toBe(base); // a skill body changed
    expect(buildManifest("run", composedParts(layers, [{ ...skill, version: 4 }])).hash).not.toBe(base); // a skill version changed
    expect(buildManifest("run", composedParts([{ ...layers[0]!, hash: "d".repeat(64) }], [skill])).hash).not.toBe(base); // an agent layer changed
    expect(buildManifest("run", [...parts.slice(0, 2), part("result_instruction", "Result instruction", "x", null, "other"), parts[3]!]).hash).not.toBe(base); // the runner's result text changed
    expect(buildManifest("run", [...parts.slice(0, 3), part("result_schema", "Station result shape", "x", null, "{}")]).hash).not.toBe(base); // the result schema changed
    expect(buildManifest("run", [part("station_tools", "Station tools", "x", null, "tools text"), ...parts]).hash).not.toBe(base); // station tools text added
    expect(buildManifest("run", parts, { handoff: { x: 2 } }).hash).toBe(base); // the handoff is a size only: it is not an instruction
    expect(buildManifest("run", parts, { handoff: { x: 1 } }).handoff?.bytes).toBeGreaterThan(0);
  });

  it("keeps the same hash when a manifest is shrunk to fit a request header", () => {
    const many = Array.from({ length: 80 }, (_, i) => part("skill", `Skill number ${i} with a long name`, "skill_versions sk-x", 1, `body ${i}`));
    const m = buildManifest("turn", many);
    const h = forHeader(m);
    expect(h.hash).toBe(m.hash);
    expect(h.compact).toBe(true);
    expect(encodeManifest(m).length).toBeLessThan(12_000);
    expect(manifestHash(m.parts)).toBe(m.hash);
  });

  it("matches the text the runner appends (a drift guard between the two copies)", () => {
    const src = readFileSync(fileURLToPath(new URL("../../../runner/wrapper/src/adapters/claude.ts", import.meta.url)), "utf8");
    expect(src).toContain(RESULT_INSTRUCTION);
    expect(runnerParts().some((p) => p.kind === "result_instruction")).toBe(true);
  });
});

const d = TEST_URL ? describe : describe.skip;
const tomas = "p-tomas"; // engineer on payments
const rui = "p-rui"; // viewer on payments
const lena = "p-lena"; // no access to payments
const asha = "p-asha"; // factory admin
const EDGE = { authorization: "Bearer edge-token-for-tests" };

d("prompt records of conversational calls", () => {
  let t: TestApp;
  const edge = new FakeEdge();
  const w = world(() => t);
  const q = w.q;
  let n = 0;
  const get = async (who: string, u: string) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method: "GET", url: u, headers: s.headers });
    return { status: r.statusCode, body: r.json() as Record<string, any> };
  };
  const hex = (c: string) => c.repeat(64);

  beforeAll(async () => {
    await edge.start();
    configureConsoleEdge({ baseUrl: edge.url });
    configureSessionBroker(async () => ({ ok: false, error: "not used here" }) as never);
    t = await startApp();
  });
  afterAll(async () => {
    resetConsoleEdge();
    resetSessionBroker();
    await edge.stop();
    await t.close();
  });
  beforeEach(() => edge.reset());

  /** What the edge does after a call: report the usage with the trace reference and where the call belongs. */
  const report = async (o: { ref: string; surface: string; project?: string; woId?: string; actor?: string; turn?: string }) => {
    const r = await t.app.inject({ method: "POST", url: "/internal/v1/service-calls/usage", headers: { ...EDGE, "idempotency-key": `k-${++n}` }, payload: { purpose: "console", requestId: `req-${n}`, model: "claude-test-1", vendor: "anthropic", inputTokens: 10, outputTokens: 5, traceRef: `sha256/${o.ref}`, surface: o.surface, ...(o.project ? { project: o.project } : {}), ...(o.woId ? { woId: o.woId } : {}), ...(o.actor ? { actor: o.actor } : {}), ...(o.turn ? { turn: o.turn } : {}), promptHash: hex("9") } });
    expect(r.statusCode, r.body).toBe(200);
  };

  it("the service-call usage report keeps the trace reference, the prompt hash and where the call belongs", async () => {
    await report({ ref: hex("1"), surface: "workorder", project: "payments", woId: "WO-9", actor: tomas, turn: "t-1" });
    const rows = await q(`select trace_ref, surface, project_id, wo_id, actor_id, turn_id, prompt_hash from usage_meter where trace_ref = $1`, [`sha256/${hex("1")}`]);
    expect(rows).toEqual([{ trace_ref: `sha256/${hex("1")}`, surface: "workorder", project_id: "payments", wo_id: "WO-9", actor_id: tomas, turn_id: "t-1", prompt_hash: hex("9") }]);
  });

  it("a work-order trace is readable by people who may read the project, and by nobody else", async () => {
    edge.traces.set(hex("2"), { v: 1, kind: "service-call", request: { system: "You are the Intake Clerk." }, manifest: { hash: hex("9") } });
    await report({ ref: hex("2"), surface: "workorder", project: "payments", woId: "WO-9", actor: tomas, turn: "t-2" });
    for (const who of [tomas, rui, asha]) {
      const r = await get(who, `/api/v1/prompt-traces/${hex("2")}`);
      expect(r.status, who).toBe(200);
      expect(r.body.trace.request.system).toBe("You are the Intake Clerk.");
    }
    // no access to the project: it does not exist for them; an unknown reference answers the same
    expect((await get(lena, `/api/v1/prompt-traces/${hex("2")}`)).status).toBe(404);
    expect((await get(lena, `/api/v1/prompt-traces/${hex("e")}`)).status).toBe(404);
    expect((await get(tomas, `/api/v1/prompt-traces/${hex("e")}`)).status).toBe(404);
    expect((await get(tomas, `/api/v1/prompt-traces/not-a-hash`)).status).toBe(422);
    // the list shows the same people the same calls, and nothing to those who may not read them
    expect((await get(rui, `/api/v1/prompt-calls?wo=WO-9`)).body.calls).toHaveLength(2); // this test's call and the one reported above
    expect((await get(lena, `/api/v1/prompt-calls?wo=WO-9`)).body.calls).toHaveLength(0);
    expect((await get(lena, `/api/v1/prompt-calls?project=payments`)).body.calls).toHaveLength(0);
  });

  it("a console or explain trace belongs to the person who asked, even a factory admin cannot read another person's", async () => {
    edge.traces.set(hex("3"), { v: 1, request: { messages: [{ role: "user", content: "what is blocked?" }] } });
    await report({ ref: hex("3"), surface: "console", project: "payments", actor: tomas });
    expect((await get(tomas, `/api/v1/prompt-traces/${hex("3")}`)).status).toBe(200);
    expect((await get(asha, `/api/v1/prompt-traces/${hex("3")}`)).status).toBe(404);
    expect((await get(rui, `/api/v1/prompt-traces/${hex("3")}`)).status).toBe(404);
    // a call that belongs to no project is the asker's alone, whatever its surface says
    edge.traces.set(hex("4"), { v: 1 });
    await report({ ref: hex("4"), surface: "onboarding", actor: asha });
    expect((await get(asha, `/api/v1/prompt-traces/${hex("4")}`)).status).toBe(200);
    expect((await get(tomas, `/api/v1/prompt-traces/${hex("4")}`)).status).toBe(404);
  });

  it("says so when the trace store cannot answer, and refuses a caller that is not a signed-in person", async () => {
    await report({ ref: hex("5"), surface: "workorder", project: "payments", woId: "WO-9", actor: tomas });
    const gone = await get(tomas, `/api/v1/prompt-traces/${hex("5")}`); // recorded, but the edge has no object
    expect(gone.status).toBe(404);
    const anon = await t.app.inject({ method: "GET", url: `/api/v1/prompt-traces/${hex("2")}` });
    expect([401, 403]).toContain(anon.statusCode);
  });

  it("a work-order session turn sends its prompt manifest, scope and one turn id with every model call", async () => {
    const sub = await w.submit(tomas);
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const id = sub.body.id as string;
    edge.script = [{ blocks: [{ type: "tool_use", id: "t1", name: "get_work_order", input: {} }] }, { blocks: [{ type: "text", text: "Here is where it stands." }] }];
    const s = await t.session(tomas);
    const r = await t.app.inject({ method: "POST", url: `/api/v1/work-orders/${id}/session/messages`, headers: { ...s.headers, "idempotency-key": `k-${++n}` }, payload: { kind: "open" } });
    expect(r.statusCode).toBe(200);
    expect(edge.calls.length).toBeGreaterThanOrEqual(2);
    const h = edge.calls.map((c) => c.headers);
    expect(new Set(h.map((x) => x["x-gantry-turn"])).size).toBe(1);
    expect(h[0]).toMatchObject({ "x-gantry-surface": "workorder", "x-gantry-work-order": id, "x-gantry-actor": tomas, "x-gantry-trace-project": "payments" });
    const m = JSON.parse(Buffer.from(String(h[0]!["x-gantry-manifest"]), "base64url").toString("utf8"));
    expect(m).toMatchObject({ v: 1, kind: "turn", hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(m.parts.map((p: { kind: string }) => p.kind)).toEqual(expect.arrayContaining(["system", "tools"]));
    expect(m.conversation.messages).toBeGreaterThanOrEqual(1);
    // routing is unchanged by the trace scope: the project header is the existing model-pick one
    expect(h[0]!["x-gantry-project"]).toBe("payments");
  });

  it("the instruction hash of a pinned run covers skills and the runner's text, not only the layers", async () => {
    const pin = async () => withTx(t.db.app, (tx) => pinRunConfig(tx, { orgId: t.orgId, agentId: "ag-build", agentVersion: 1, projectId: "payments", repoId: "payments-api" }));
    const a = (await pin())!;
    expect(a.manifest.hash).not.toBe(a.composed.hash);
    expect(a.manifest.parts.map((p) => p.kind)).toEqual(expect.arrayContaining(["layer", "result_instruction", "result_schema"]));
    const skill = a.manifest.parts.find((p) => p.kind === "skill");
    expect(skill, "the build agent has a skill attached in the seed").toBeTruthy();
    const sid = a.skills[0]!.id;
    await q(`insert into skill_versions (org_id, skill_id, version, body, published_at) values ($1,$2,99,$3::jsonb,now())`, [t.orgId, sid, JSON.stringify({ body: "A changed skill body." })]);
    await q(`update skills set live_version = 99 where org_id = $1 and id = $2`, [t.orgId, sid]);
    const b = (await pin())!;
    expect(b.composed.hash).toBe(a.composed.hash); // the old hash could not see this change
    expect(b.manifest.hash).not.toBe(a.manifest.hash);
    expect(b.manifest.parts.find((p) => p.kind === "skill")).toMatchObject({ version: 99, bytes: "A changed skill body.".length });
  });
});
