/**
 * The prompt manifest: the ordered list of everything a model was given, with where each part came from, which version it was, and its hash and size.
 * A run gets one (`runs.data.promptManifest`, built when the run is dispatched and again when its spec is served) and so does every conversational turn
 * (sent to the edge with the call and stored in the trace). The manifest hash is the instruction hash: it covers every part, not just the agent layers.
 * Gantry supplies the structure here; what the parts say is decided by people and agents.
 */
import { createHash } from "node:crypto";

export type PartKind = "layer" | "skill" | "station_tools" | "result_instruction" | "result_schema" | "system" | "tools" | "repo_context";

export interface ManifestPart {
  kind: PartKind;
  name: string;
  /** Where the text comes from: a table and key, or a code location for text that lives in code. */
  source: string;
  version: number | null;
  sha256: string;
  bytes: number;
}

export interface PromptManifest {
  v: 1;
  kind: "run" | "turn";
  /** Over every part in order (kind, name, version, hash). The handoff and the conversation are sizes only: they differ per call and are not instructions. */
  hash: string;
  parts: ManifestPart[];
  /** The station handoff of a run (size and hash of the JSON the agent gets as its first message). */
  handoff?: { bytes: number; sha256: string };
  /** The conversation so far for a turn. */
  conversation?: { messages: number; bytes: number };
  /** Set when parts were left out to fit a header: the hash still covers them all. */
  compact?: boolean;
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");

export function part(kind: PartKind, name: string, source: string, version: number | null, text: string): ManifestPart {
  return { kind, name, source, version, sha256: sha256(text), bytes: bytesOf(text) };
}

export const manifestHash = (parts: ManifestPart[]): string => sha256(parts.map((p) => [p.kind, p.name, p.version ?? "", p.sha256].join("\0")).join("\n"));

export function buildManifest(kind: "run" | "turn", parts: ManifestPart[], extra: { handoff?: unknown; conversation?: { messages: number; bytes: number } } = {}): PromptManifest {
  const m: PromptManifest = { v: 1, kind, hash: manifestHash(parts), parts };
  if (extra.handoff !== undefined) {
    const text = typeof extra.handoff === "string" ? extra.handoff : JSON.stringify(extra.handoff, null, 2);
    m.handoff = { bytes: bytesOf(text), sha256: sha256(text) };
  }
  if (extra.conversation) m.conversation = extra.conversation;
  return m;
}

/** What the runner appends to the system prompt after the skills (runner/wrapper/src/adapters/claude.ts); a test keeps the two copies equal. */
export const RESULT_INSTRUCTION =
  "When the work is finished, end your final message with exactly one fenced ```json block holding the station result as a single JSON object. Do not put anything after it.";

/** The station-tools text the runner adds, when its wrapper has one. Empty for a wrapper without station tools: the part is then recorded as absent, not guessed. */
export const STATION_TOOLS_INSTRUCTION = "";

/** The shape a station result is checked against (the delivery endpoint's body), as the text the manifest hashes. */
export const RESULT_SCHEMA_TEXT = JSON.stringify({ status: ["succeeded", "failed", "interrupted"], output: "any", usage: "array", error: { code: "string", msg: "string" }, adapter: "string", capabilities: "any" });

/** The parts the runner appends to every run's system prompt, in the order it appends them. */
export function runnerParts(): ManifestPart[] {
  return [
    ...(STATION_TOOLS_INSTRUCTION ? [part("station_tools", "Station tools", "runner/wrapper STATION_TOOLS_INSTRUCTION", null, STATION_TOOLS_INSTRUCTION)] : []),
    part("result_instruction", "Result instruction", "runner/wrapper/src/adapters/claude.ts RESULT_INSTRUCTION", null, RESULT_INSTRUCTION),
    part("result_schema", "Station result shape", "services/api/src/areas/internal/runs.ts ResultBody", null, RESULT_SCHEMA_TEXT),
  ];
}

const HEADER_BUDGET = 6_000;

/** A manifest small enough for a request header: the same hash, per-part rows reduced to kind, name, version and hash when it would not fit. */
export function forHeader(m: PromptManifest): PromptManifest {
  if (JSON.stringify(m).length <= HEADER_BUDGET) return m;
  const slim = m.parts.map((p) => ({ kind: p.kind, name: p.name.slice(0, 40), source: "", version: p.version, sha256: p.sha256.slice(0, 12), bytes: p.bytes }));
  const out: PromptManifest = { ...m, parts: slim, compact: true };
  return JSON.stringify(out).length <= HEADER_BUDGET ? out : { v: 1, kind: m.kind, hash: m.hash, parts: [], compact: true, ...(m.conversation ? { conversation: m.conversation } : {}) };
}

export const encodeManifest = (m: PromptManifest): string => Buffer.from(JSON.stringify(forHeader(m))).toString("base64url");
