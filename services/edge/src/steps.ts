/**
 * The run timeline's steps (agent workspace, Phase 2, G10). A transcript checkpoint is stored whole in object storage, which only the edge
 * reaches; for the timeline the edge pulls out, per tool call, the tool's name and one short target (a path, a pattern, a URL, the first words
 * of a command), already secret-scanned. Nothing else of the transcript leaves the store.
 */
import { scanText } from "./secrets-scan.js";

export interface Step { turn: number; tool: string; detail: string }

const PICK = ["file_path", "path", "pattern", "url", "name", "command", "query", "description"] as const;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One stream-json transcript increment (one line per event) to at most `max` steps. */
export function stepsOf(jsonl: string, turn: number, knownKeys: string[], max = 40): Step[] {
  const out: Step[] = [];
  for (const line of jsonl.split("\n")) {
    if (out.length >= max) break;
    let ev: { type?: string; message?: { content?: unknown } };
    try {
      ev = JSON.parse(line) as typeof ev;
    } catch {
      continue;
    }
    if (ev.type !== "assistant" || !Array.isArray(ev.message?.content)) continue;
    for (const b of ev.message!.content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
      if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
      const input = b.input && typeof b.input === "object" ? b.input : {};
      const key = PICK.find((k) => typeof input[k] === "string" && (input[k] as string).trim());
      const raw = key ? String(input[key]).replace(/\s+/g, " ").trim() : "";
      const detail = clip(scanText(key === "command" ? raw.split(" ").slice(0, 6).join(" ") : raw, knownKeys).text, 120);
      out.push({ turn, tool: clip(b.name.replace(/^mcp__gantry__/, "gantry:"), 60), detail });
      if (out.length >= max) break;
    }
  }
  return out;
}
