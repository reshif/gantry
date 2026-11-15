import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { EdgeClient } from "../src/edge.js";
import { handOver, runWrapper } from "../src/main.js";
import { callTool, handleRpc, LIMITS, readLog, serveStdio } from "../src/station-tools.js";
import { startFakeEdge, type FakeEdge } from "./helpers.js";

const dir = () => mkdtemp(join(tmpdir(), "gantry-station-"));
const TOKEN = "run-token-abcdef123456";
let edge: FakeEdge | undefined;
afterEach(async () => {
  await edge?.close();
  edge = undefined;
});

describe("station tools", () => {
  it("records documents, questions and assumptions, and refuses what breaks the rails", async () => {
    const d = await dir();
    expect((await callTool("write_document", { name: "research.md", markdown: "# Research\n\nFound it." }, d)).isError).toBe(false);
    expect((await callTool("write_document", { name: "research.md", markdown: "# Research v2" }, d)).isError).toBe(false);
    expect((await callTool("write_document", { name: "../etc/passwd.md", markdown: "x" }, d)).isError).toBe(true);
    expect((await callTool("write_document", { name: "a/b/c.md", markdown: "x" }, d)).isError).toBe(true);
    expect((await callTool("write_document", { name: "notes.txt", markdown: "x" }, d)).isError).toBe(true);
    expect((await callTool("write_document", { name: "big.md", markdown: "x".repeat(LIMITS.docChars + 1) }, d)).isError).toBe(true);
    expect((await callTool("ask", { question: "Which region?", why: "The retry budget differs per region.", blocking: true, askOf: "role:release_manager" }, d)).text).toContain("Finish this turn");
    expect((await callTool("ask", { question: "Which region?", why: "x" }, d)).isError).toBe(true);
    expect((await callTool("ask", { question: "Which region?", why: "Because it matters.", blocking: false, askOf: "everyone" }, d)).isError).toBe(true);
    expect((await callTool("assume", { statement: "Retries are idempotent", because: "The handler upserts by key." }, d)).isError).toBe(false);
    const log = await readLog(d);
    expect(log.documents).toEqual({ "research.md": "# Research v2" });
    expect(log.questions).toEqual([{ question: "Which region?", why: "The retry budget differs per region.", blocking: true, options: [], askOf: "role:release_manager" }]);
    expect(log.assumptions).toEqual([{ statement: "Retries are idempotent", because: "The handler upserts by key.", impact: "medium" }]);
  });

  it("speaks MCP over stdio: initialize, list, call", async () => {
    const d = await dir();
    expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, d)).toBeNull();
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: any[] = [];
    output.on("data", (b: Buffer) => b.toString().split("\n").filter(Boolean).forEach((l) => lines.push(JSON.parse(l))));
    const done = serveStdio(d, input, output);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "write_document", arguments: { name: "spec.md", markdown: "# Spec" } } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "nope" })}\n`);
    input.end();
    await done;
    expect(lines[0].result.serverInfo.name).toBe("gantry");
    expect(lines[1].result.tools.map((t: { name: string }) => t.name)).toEqual(["write_document", "ask", "assume", "propose_research_plan", "web_fetch", "spawn_scouts", "object"]);
    expect(lines[2].result.isError).toBe(false);
    expect(lines[3].error.code).toBe(-32601);
    expect((await readLog(d)).documents["spec.md"]).toBe("# Spec");
  });

  it("hands documents over as artefacts and turns a blocking question into needs_person", async () => {
    const d = await dir();
    await callTool("write_document", { name: "research.md", markdown: "# So far" }, d);
    await callTool("ask", { question: "Who owns the sync job?", why: "The fix belongs in their module.", blocking: true }, d);
    const cps: any[] = [];
    const out = await handOver({ status: "failed", usage: [], error: { code: "no_structured_output", msg: "x" } }, d, "research", async (cp) => void cps.push(cp), 3, () => undefined);
    expect(out.status).toBe("needs_person");
    expect(cps).toEqual([{ turn: 3, kind: "artefact", name: "research.md", contentType: "text/markdown; charset=utf-8", content: "# So far" }]);
    expect(out.output).toMatchObject({ documents: ["research.md"], dialogue: { questions: [{ blocking: true, askOf: "requester" }] }, summary: expect.stringContaining("waiting") });
    const failed = await handOver({ status: "failed", usage: [], error: { code: "harness_exit", msg: "x" } }, d, "research", async (cp) => void cps.push(cp), 3, () => undefined);
    expect(failed.status).toBe("failed");
    expect(cps).toHaveLength(1);
  });

  it("a stub run asked to question posts needs_person through the edge", async () => {
    edge = await startFakeEdge({ adapter: "stub", station: "research", heartbeatSeconds: 5, stub: { questions: [{ question: "Which tenant first?", why: "Rollout order changes the plan.", blocking: true }] } }, TOKEN);
    const env = { edgeUrl: edge.url, runToken: TOKEN, runId: "r1", workspace: "/workspace" };
    await runWrapper({ env, edge: new EdgeClient(env), stationDir: await dir(), log: () => undefined, onSignal: () => () => undefined });
    const cp = edge.calls.find((c) => c.path === "/run/v1/checkpoint" && c.body.name === "research.md");
    expect(cp?.body.contentType).toContain("text/markdown");
    expect(edge.calls.at(-1)!.body).toMatchObject({ status: "needs_person", output: { dialogue: { questions: [{ question: "Which tenant first?" }] } } });
  });

  it("a research plan ends the run for approval; web_fetch goes through the edge and frames the page as untrusted", async () => {
    const d = await dir();
    expect((await callTool("propose_research_plan", { questions: ["How do Nautobot jobs retry?"], hosts: ["docs.nautobot.com", "not a host"], web: true, budgetUsd: 2, why: "The repo has no retry helper." }, d)).isError).toBe(false);
    expect((await readLog(d)).plan).toEqual({ questions: ["How do Nautobot jobs retry?"], hosts: ["docs.nautobot.com"], web: true, budgetUsd: 2, why: "The repo has no retry helper." });
    const out = await handOver({ status: "succeeded", output: { summary: "" }, usage: [] }, d, "research", async () => undefined, 1, () => undefined);
    expect(out.status).toBe("needs_person");
    expect(out.output).toMatchObject({ researchPlan: { hosts: ["docs.nautobot.com"] }, summary: "research: waiting for the research plan to be approved." });

    edge = await startFakeEdge({}, TOKEN);
    process.env.GANTRY_EDGE_URL = edge.url;
    process.env.GANTRY_RUN_TOKEN = TOKEN;
    const r = await callTool("web_fetch", { url: "https://docs.nautobot.com/jobs", why: "retry guidance" }, await dir());
    const call = edge.calls.find((c) => c.path === "/run/v1/research/fetch")!;
    expect(call.body).toEqual({ url: "https://docs.nautobot.com/jobs", why: "retry guidance" });
    expect(call.auth).toBe(`Bearer ${TOKEN}`);
    // the fake edge answers {} (no ok): the tool reports it could not read the page
    expect(r.isError).toBe(true);
    expect((await callTool("web_fetch", { url: "http://x.org", why: "x y" }, d)).isError).toBe(true);
    delete process.env.GANTRY_EDGE_URL;
    delete process.env.GANTRY_RUN_TOKEN;
  });

  it("scouts and objections: rails, scout role refusals, and the hand-over", async () => {
    const d = await dir();
    expect((await callTool("spawn_scouts", { scouts: [1, 2, 3, 4, 5].map((i) => ({ question: `Sub-question ${i}`, focus: "repo" })) }, d)).isError).toBe(true);
    expect((await callTool("spawn_scouts", { scouts: [{ question: "How do jobs retry?", focus: "web" }, { question: "Which tests cover sync?", focus: "repo" }] }, d)).isError).toBe(false);
    expect((await callTool("spawn_scouts", { scouts: [{ question: "Again please", focus: "repo" }] }, d)).isError).toBe(true);
    expect((await callTool("object", { targetDoc: "research.md", reason: "short", severity: "high" }, d)).isError).toBe(true);
    for (let i = 0; i < 3; i++) expect((await callTool("object", { targetDoc: "research.md", section: "Findings", claim: "Jobs retry by default", reason: "The cited page s2 says retries must be coded explicitly.", severity: "high" }, d)).isError).toBe(false);
    expect((await callTool("object", { targetDoc: "research.md", reason: "A fourth objection is one too many here.", severity: "low" }, d)).isError).toBe(true);
    const out = await handOver({ status: "succeeded", output: {}, usage: [] }, d, "research", async () => undefined, 1, () => undefined);
    expect(out.status).toBe("needs_person");
    expect(out.output).toMatchObject({ scouts: [{ focus: "web" }, { focus: "repo" }], summary: "research: waiting for 2 scouts." });
    expect((out.output as { dialogue: { objections: unknown[] } }).dialogue.objections).toHaveLength(3);
    process.env.GANTRY_STATION_ROLE = "scout";
    const d2 = await dir();
    expect((await callTool("spawn_scouts", { scouts: [{ question: "Nested scout", focus: "repo" }] }, d2)).text).toMatch(/cannot send scouts/);
    expect((await callTool("propose_research_plan", { questions: ["q?"], hosts: [], web: false, why: "because" }, d2)).text).toMatch(/cannot propose a plan/);
    delete process.env.GANTRY_STATION_ROLE;
  });
});

