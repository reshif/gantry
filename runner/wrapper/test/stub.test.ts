import { afterEach, describe, expect, it } from "vitest";
import { EdgeClient } from "../src/edge.js";
import { EXIT, runWrapper } from "../src/main.js";
import { RunSpec } from "../src/spec.js";
import { stubStationResult } from "../src/adapters/stub.js";
import { startFakeEdge, type FakeEdge } from "./helpers.js";

const TOKEN = "run-token-abcdef123456";
let edge: FakeEdge | undefined;
afterEach(async () => {
  await edge?.close();
  edge = undefined;
});

const mkEnv = (url: string) => ({ edgeUrl: url, runToken: TOKEN, runId: "r1", workspace: "/workspace" });

describe("stub adapter", () => {
  const spec = (over: object = {}) => RunSpec.parse({ adapter: "stub", station: "spec", instructions: "be brief", input: { title: "Add retry to payments client" }, ...over });

  it("is deterministic and derived from the spec", () => {
    const a = stubStationResult(spec());
    const b = stubStationResult(spec());
    expect(a).toEqual(b);
    expect(a.goal).toBe("Add retry to payments client");
    expect(stubStationResult(spec({ instructions: "other" })).digest).not.toBe(a.digest);
  });

  it("covers every station in the output table with its required fields", () => {
    const need: Record<string, string[]> = {
      intake: ["class", "confidence", "rationale", "route", "clarifyingQuestions", "misses"],
      research: ["findings", "sources", "openQuestions"],
      spec: ["goal", "scope", "acceptanceCriteria"],
      design: ["designNotes", "affectedComponents", "risks"],
      plan: ["steps", "childWorkOrders"],
      build: ["commits", "filesChanged"],
      verify: ["testsRun", "criteria", "checks"],
      "review-merge": ["reviewNotes", "pullRequestDescription"],
      close: ["releaseNotes", "tag", "summary"],
    };
    for (const [station, keys] of Object.entries(need)) {
      const out = stubStationResult(spec({ station }));
      for (const k of keys) expect(out, `${station}.${k}`).toHaveProperty(k);
    }
  });
});

describe("wrapper against an HTTP edge", () => {
  it("fetches the spec, heartbeats, checkpoints and posts the result", async () => {
    edge = await startFakeEdge({ adapter: "stub", station: "build", input: "x", heartbeatSeconds: 0.05, stub: { delayMs: 200 } }, TOKEN);
    const code = await runWrapper({ env: mkEnv(edge.url), edge: new EdgeClient(mkEnv(edge.url)), log: () => undefined, onSignal: () => () => undefined });
    expect(code).toBe(EXIT.delivered);
    const paths = edge.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths[0]).toBe("GET /run/v1/spec");
    expect(paths.filter((p) => p === "POST /run/v1/heartbeat").length).toBeGreaterThanOrEqual(2);
    expect(paths).toContain("POST /run/v1/checkpoint");
    expect(paths.at(-1)).toBe("POST /run/v1/result");
    expect(edge.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    const result = edge.calls.at(-1)!.body;
    expect(result).toMatchObject({ runId: "r1", status: "succeeded", adapter: "stub" });
    expect(result.output.station).toBe("build");
    expect(result.capabilities).toEqual({ cancel: true, resume: false, mcp: false, usageDetail: false });
  });

  it("returns the stub output verbatim when the spec supplies one", async () => {
    edge = await startFakeEdge({ adapter: "stub", station: "intake", stub: { output: { class: "bug" } } }, TOKEN);
    await runWrapper({ env: mkEnv(edge.url), edge: new EdgeClient(mkEnv(edge.url)), log: () => undefined, onSignal: () => () => undefined });
    expect(edge.calls.at(-1)!.body.output).toMatchObject({ class: "bug", documents: ["intake.md"] });
  });

  it("reports a failure the spec asks for", async () => {
    edge = await startFakeEdge({ adapter: "stub", station: "intake", stub: { failWith: "boom" } }, TOKEN);
    await runWrapper({ env: mkEnv(edge.url), edge: new EdgeClient(mkEnv(edge.url)), log: () => undefined, onSignal: () => () => undefined });
    expect(edge.calls.at(-1)!.body).toMatchObject({ status: "failed", error: { code: "stub_failure", msg: "boom" } });
  });

  it("stops when the edge refuses the run token on a heartbeat, and delivers nothing", async () => {
    edge = await startFakeEdge({ adapter: "stub", station: "build", heartbeatSeconds: 0.05, stub: { delayMs: 5_000 } }, TOKEN);
    const e = edge;
    setTimeout(() => (e.heartbeatStatus = 409), 120);
    const t0 = Date.now();
    const code = await runWrapper({ env: mkEnv(edge.url), edge: new EdgeClient(mkEnv(edge.url)), log: () => undefined, onSignal: () => () => undefined });
    expect(code).toBe(EXIT.refused);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(edge.calls.some((c) => c.path === "/run/v1/result")).toBe(false);
  });

  it("enforces the wall-clock limit and reports it as a failure", async () => {
    edge = await startFakeEdge({ adapter: "stub", station: "build", limits: { turns: 5, wallClockSeconds: 1 }, stub: { delayMs: 10_000 } }, TOKEN);
    const code = await runWrapper({ env: mkEnv(edge.url), edge: new EdgeClient(mkEnv(edge.url)), log: () => undefined, onSignal: () => () => undefined });
    expect(code).toBe(EXIT.delivered);
    expect(edge.calls.at(-1)!.body).toMatchObject({ status: "failed", error: { code: "wall_clock" } });
  });

  it("reports interrupted on a signal", async () => {
    edge = await startFakeEdge({ adapter: "stub", station: "build", stub: { delayMs: 10_000 } }, TOKEN);
    let fire: (r: string) => void = () => undefined;
    const p = runWrapper({ env: mkEnv(edge.url), edge: new EdgeClient(mkEnv(edge.url)), log: () => undefined, onSignal: (h) => ((fire = h), () => undefined) });
    setTimeout(() => fire("interrupt"), 100);
    expect(await p).toBe(EXIT.delivered);
    expect(edge.calls.at(-1)!.body.status).toBe("interrupted");
  });

  it("exits 70 for an invalid spec", async () => {
    edge = await startFakeEdge({ adapter: "nope", station: "x" }, TOKEN);
    const code = await runWrapper({ env: mkEnv(edge.url), edge: new EdgeClient(mkEnv(edge.url), { retries: 0 }), log: () => undefined, onSignal: () => () => undefined });
    expect(code).toBe(EXIT.noSpec);
  });

  it("exits 71 when the spec call is refused", async () => {
    edge = await startFakeEdge({ adapter: "stub", station: "x" }, "different-token-123456");
    const code = await runWrapper({ env: mkEnv(edge.url), edge: new EdgeClient(mkEnv(edge.url), { retries: 0 }), log: () => undefined, onSignal: () => () => undefined });
    expect(code).toBe(EXIT.refused);
  });
});
