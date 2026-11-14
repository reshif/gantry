import { createHash } from "node:crypto";

/** JSON with sorted keys, so the same definition always hashes the same whichever order a server lists its fields in. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface ToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

/** The hash of a tool's definition (spec 12.4): everything a model is told about the tool. A changed hash disables the server until an admin re-approves it. */
export function definitionHash(t: ToolDef): string {
  return sha256(stableStringify({ name: t.name, title: t.title, description: t.description ?? "", inputSchema: t.inputSchema ?? null, outputSchema: t.outputSchema ?? null, annotations: t.annotations ?? null }));
}

/** The server's own hint of read or write. Only a suggestion: a tool counts as read only when the server says readOnlyHint. */
export function suggestedClass(t: ToolDef): "read" | "write" {
  const a = t.annotations;
  return a && typeof a === "object" && (a as { readOnlyHint?: unknown }).readOnlyHint === true ? "read" : "write";
}

/** What the runner's `argsHash` is: the hash of the call's arguments, so the log shows that a call happened and with what, without keeping the values. */
export const argsHash = (args: unknown): string => sha256(stableStringify(args ?? {}));
