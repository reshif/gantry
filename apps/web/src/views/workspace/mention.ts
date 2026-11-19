/**
 * @mention routing (agent workspace, Phase 4): "@Researcher why did you skip the API docs?" in a work order's thread opens a side thread with that
 * agent and asks the question there. The primary thread stays with the station's agent; the mentioned agent answers read-only, in the open.
 */
import type { WsAgent } from "./api";

/** The agent a message is addressed to and the question, when it starts with @ and an agent's name, id or station. */
export function mentionOf(text: string, agents: WsAgent[]): { agent: WsAgent; text: string } | null {
  const t = text.trimStart();
  if (!t.startsWith("@")) return null;
  // The longest name wins ("Spec Writer" before "Spec").
  const keys = agents.flatMap((a) => [a.name, a.id, a.stationName].map((k) => ({ a, k: k.trim() }))).filter((x) => x.k).sort((x, y) => y.k.length - x.k.length);
  for (const { a, k } of keys) {
    const re = new RegExp(`^@${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?=$|[\\s,:;.!?-])`, "i");
    const m = re.exec(t);
    if (m) return { agent: a, text: t.slice(m[0].length).replace(/^[\s,:;.!?-]+/, "").trim() };
  }
  return null;
}

/** Agents to offer while the person types "@...". */
export function mentionChoices(text: string, agents: WsAgent[]): WsAgent[] {
  const t = text.trimStart();
  if (!t.startsWith("@") || /\s/.test(t)) return [];
  const p = t.slice(1).toLowerCase();
  return agents.filter((a) => a.name.toLowerCase().startsWith(p) || a.id.toLowerCase().startsWith(p) || a.stationName.toLowerCase().startsWith(p));
}

/** A question to send once its side thread opens (the chat pane takes it). */
const pending = new Map<string, string>();
export const queueAsk = (threadId: string, text: string): void => void pending.set(threadId, text);
export function takeAsk(threadId: string): string | null {
  const t = pending.get(threadId) ?? null;
  pending.delete(threadId);
  return t;
}
