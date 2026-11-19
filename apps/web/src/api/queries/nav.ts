/** Typed reads for this slice of /api/v1. Keys come from ../keys (`qk`). */
import { usePrefs } from "../../lib/prefs";
import type { NavBadge } from "../types";
import { useMe } from "./session";
import { useHome } from "./work";

/** Nav badges for the left nav, from GET /home. Empty until home loads. */
export function useNavBadges(): Record<string, NavBadge> {
  const home = useHome();
  const me = useMe();
  const prefs = usePrefs();
  const project = prefs.project;
  // Floor, work-order and onboarding badges follow the selected project; the API gives them per project.
  const byProject = (home.data?.projectBadges ?? {}) as Record<string, Record<string, NavBadge>>;
  const b: Record<string, NavBadge> = { ...(home.data?.badges ?? {}), ...(project ? byProject[project] ?? {} : {}) };
  // The Inbox counts what waits for this person: gate and onboarding approvals, and questions addressed to them.
  // on a scoped sheet only that project's items count (like the prototype's Inbox pill)
  const scope = prefs.scopeAll ? null : prefs.project;
  const inScope = (x: { project?: string }) => !scope || x.project === scope;
  // One source with the Inbox page: the same waiting list (gates, onboarding, questions, blocked work orders), a brief-gate conversation counted once with its gate.
  type Waiting = { approvals: Array<{ wo?: string; gate?: string; repo?: string; project?: string }>; conversations: Array<{ wo: string; project?: string; gate?: { id: string } | null }> };
  const w = (home.data?.sections as { waiting?: Waiting } | undefined)?.waiting;
  const gateKeys = new Set((w?.approvals ?? []).filter((a) => !a.repo).map((a) => `${a.wo}|${a.gate}`));
  const waiting = w
    ? w.approvals.filter(inScope).length + w.conversations.filter((c) => inScope(c) && !(c.gate && gateKeys.has(`${c.wo}|${c.gate.id}`))).length
    : (home.data?.approvals?.filter(inScope).length ?? 0) + (home.data?.conversations?.filter(inScope).length ?? 0);
  delete b.inbox;
  if (waiting) b.inbox = { n: waiting, label: `${waiting} waiting for you ${scope ? `in ${me?.projects.find((p) => p.id === scope)?.name ?? "this project"}` : "in all projects"}` };
  return b;
}
