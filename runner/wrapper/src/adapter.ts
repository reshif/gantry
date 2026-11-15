import type { Capabilities, Checkpoint, RunStatus, UsageEntry } from "./edge.js";
import type { RunEnv } from "./env.js";
import type { RunSpec } from "./spec.js";

export interface AdapterContext {
  spec: RunSpec;
  env: RunEnv;
  /** Aborted on interrupt (SIGTERM), wall-clock expiry or an edge refusal. */
  signal: AbortSignal;
  /** Reports the current turn for the heartbeat. */
  setTurn(turn: number): void;
  /** Where the station tools record (the stub writes there directly; a harness reaches it through the stdio MCP server). */
  stationDir?: string;
  /** Saves a transcript increment or artefact through the edge at a turn boundary. */
  checkpoint(cp: Checkpoint): Promise<void>;
}

export interface AdapterOutcome {
  status: RunStatus;
  output?: unknown;
  usage: UsageEntry[];
  error?: { code: string; msg: string };
}

/** Runtime adapter (spec 10.1) as seen from inside the runner. */
export interface Adapter {
  readonly name: string;
  readonly capabilities: Capabilities;
  run(ctx: AdapterContext): Promise<AdapterOutcome>;
}
