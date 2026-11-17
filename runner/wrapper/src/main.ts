import { pathToFileURL } from "node:url";
import type { Adapter, AdapterOutcome } from "./adapter.js";
import { createClaudeAdapter } from "./adapters/claude.js";
import { stubAdapter } from "./adapters/stub.js";
import { EdgeClient, type Checkpoint, type RunResult } from "./edge.js";
import { readEnv, type RunEnv } from "./env.js";
import { takeToken } from "./token.js";
import { readLog, resetLog, STATION_DIR } from "./station-tools.js";
import type { RunSpec } from "./spec.js";

export interface WrapperDeps {
  env: RunEnv;
  edge: EdgeClient;
  adapters?: Record<RunSpec["adapter"], Adapter>;
  log?: (msg: string) => void;
  /** Where the station tools keep this run's documents, questions and assumptions. */
  stationDir?: string;
  /** Signals to listen for. Defaults to the process; tests pass their own. */
  onSignal?: (handler: (reason: string) => void) => () => void;
}

/** Exit codes: 0 result delivered (any status), 70 spec unavailable/invalid, 71 refused by the edge, 72 result undeliverable. */
export const EXIT = { delivered: 0, noSpec: 70, refused: 71, undelivered: 72 } as const;

function defaultSignals(handler: (reason: string) => void): () => void {
  const term = () => handler("interrupt");
  process.on("SIGTERM", term);
  process.on("SIGINT", term);
  return () => {
    process.off("SIGTERM", term);
    process.off("SIGINT", term);
  };
}

/**
 * One run: fetch spec, start heartbeats, run the adapter, post the result.
 * The heartbeat keeps going until the result is delivered. A refusal from the edge (run stopped or superseded) aborts the
 * adapter at once; the wrapper never depends on being asked nicely (spec 4.4).
 */
export async function runWrapper(deps: WrapperDeps): Promise<number> {
  const { env, edge } = deps;
  const log = deps.log ?? ((m: string) => console.error(`[wrapper] ${m}`));
  const adapters = deps.adapters ?? { stub: stubAdapter, claude: createClaudeAdapter(process.env.GANTRY_CLAUDE_BIN ? { bin: process.env.GANTRY_CLAUDE_BIN } : {}) };

  const specRes = await edge.getSpec();
  if (!specRes.ok) {
    log(`cannot get run spec: ${specRes.error.msg}`);
    return specRes.error.kind === "refused" ? EXIT.refused : EXIT.noSpec;
  }
  const spec = specRes.value;
  const adapter = adapters[spec.adapter];

  const ac = new AbortController();
  const abort = (reason: string) => {
    if (!ac.signal.aborted) ac.abort(reason);
  };
  const unsignal = (deps.onSignal ?? defaultSignals)(abort);

  let turn = 0;
  let seq = 0;
  let phase: "starting" | "working" | "finishing" = "starting";
  let refused = false;
  const beat = async () => {
    const r = await edge.heartbeat({ seq: ++seq, phase, ...(turn > 0 ? { turn } : {}) });
    if (!r.ok && r.error.kind === "refused") {
      refused = true;
      log(`heartbeat refused (${r.error.msg}); stopping`);
      abort("refused");
    }
  };
  await beat();
  const hb = setInterval(() => void beat(), spec.heartbeatSeconds * 1000);
  const wall = setTimeout(() => abort("wall_clock"), spec.limits.wallClockSeconds * 1000);
  phase = "working";

  const checkpoint = async (cp: Checkpoint) => {
    const r = await edge.checkpoint(cp);
    if (!r.ok) {
      log(`checkpoint ${cp.name} failed: ${r.error.msg}`);
      if (r.error.kind === "refused") {
        refused = true;
        abort("refused");
      }
    }
  };

  const stationDir = deps.stationDir ?? STATION_DIR;
  await resetLog(stationDir);
  let outcome: AdapterOutcome;
  try {
    outcome = await adapter.run({ spec, env, signal: ac.signal, setTurn: (t) => (turn = t), checkpoint, stationDir });
  } catch (e) {
    outcome = { status: "failed", usage: [], error: { code: "adapter_crash", msg: e instanceof Error ? e.message : String(e) } };
  }
  phase = "finishing";
  clearTimeout(wall);

  if (outcome.status === "interrupted" && ac.signal.reason === "wall_clock") {
    outcome = { ...outcome, status: "failed", error: { code: "wall_clock", msg: `wall-clock limit ${spec.limits.wallClockSeconds}s reached` } };
  }

  if (!refused && !ac.signal.aborted) outcome = await handOver(outcome, stationDir, spec.station, checkpoint, turn, log);

  let code: number = EXIT.delivered;
  if (refused) {
    // The edge no longer accepts this token: nothing more can be delivered.
    code = EXIT.refused;
  } else {
    const result: RunResult = { status: outcome.status, usage: outcome.usage, adapter: adapter.name, capabilities: adapter.capabilities };
    if (outcome.output !== undefined) result.output = outcome.output;
    if (outcome.error) result.error = outcome.error;
    const posted = await edge.result(result);
    if (!posted.ok) {
      log(`result not delivered: ${posted.error.msg}`);
      code = posted.error.kind === "refused" ? EXIT.refused : EXIT.undelivered;
    }
  }
  clearInterval(hb);
  unsignal();
  return code;
}

/**
 * What the station tools recorded goes with the result: each document as an artefact checkpoint (the edge scans and stores it, the API versions it),
 * the questions and assumptions in `output.dialogue`. A blocking question turns the run into `needs_person` (the agent was told to stop and hand over),
 * even when it ended without its result JSON. A failed run hands over nothing.
 */
export async function handOver(o: AdapterOutcome, dir: string, station: string, checkpoint: (cp: Checkpoint) => Promise<void>, turn: number, log: (m: string) => void): Promise<AdapterOutcome> {
  const rec = await readLog(dir);
  const blocking = rec.questions.some((q) => q.blocking) || !!rec.plan || !!rec.scouts?.length;
  const waiting = blocking && (o.status === "succeeded" || (o.status === "failed" && o.error?.code === "no_structured_output"));
  if (o.status !== "succeeded" && !waiting) return o;
  const names = Object.keys(rec.documents);
  for (const name of names) await checkpoint({ turn, kind: "artefact", name, contentType: "text/markdown; charset=utf-8", content: rec.documents[name]! });
  if (names.length) log(`handed over ${names.length} document(s)`);
  const base = o.output && typeof o.output === "object" && !Array.isArray(o.output) ? (o.output as Record<string, unknown>) : {};
  const output: Record<string, unknown> = { ...base, documents: names, dialogue: { questions: rec.questions, assumptions: rec.assumptions, objections: rec.objections ?? [] }, ...(rec.plan ? { researchPlan: rec.plan } : {}), ...(rec.scouts?.length ? { scouts: rec.scouts } : {}) };
  if (waiting) {
    const n = rec.questions.filter((q) => q.blocking).length;
    if (rec.scouts?.length && !n && !rec.plan) output.summary = typeof output.summary === "string" && output.summary ? output.summary : `${station}: waiting for ${rec.scouts.length} scouts.`;
    else if (typeof output.summary !== "string" || !output.summary) output.summary = rec.plan && !n ? `${station}: waiting for the research plan to be approved.` : `${station}: waiting for ${n === 1 ? "an answer" : `${n} answers`}${rec.plan ? " and the research plan" : ""} before going on.`;
    return { status: "needs_person", output, usage: o.usage };
  }
  return { ...o, output };
}

async function main(): Promise<number> {
  // First thing, before anything else starts: read the token file and unlink it. After this the token is only in this process's memory.
  const tok = await takeToken();
  if (!tok.ok) {
    console.error(`[wrapper] ${tok.error}`);
    return 2;
  }
  const env = readEnv(tok.value);
  if (!env.ok) {
    console.error(`[wrapper] bad environment: ${env.error}`);
    return 2;
  }
  // The wrapper keeps the token in memory only (RunEnv): not in its environment, not in a file, not in argv.
  return runWrapper({ env: env.value, edge: new EdgeClient(env.value) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error("[wrapper] fatal:", e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
