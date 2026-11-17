/** Typed reads for this slice of /api/v1. Keys come from ../keys (`qk`). */
import { usePrefs } from "../../lib/prefs";
import type { NavBadge } from "../types";
import { useHome } from "./work";

/** Nav badges for the left nav, from GET /home. Empty until home loads. */
export function useNavBadges(): Record<string, NavBadge> {
  const home = useHome();
  const project = usePrefs().project;
  // Floor, work-order and onboarding badges follow the selected project; the API gives them per project.
  const byProject = (home.data?.projectBadges ?? {}) as Record<string, Record<string, NavBadge>>;
  const b: Record<string, NavBadge> = { ...(home.data?.badges ?? {}), ...(project ? byProject[project] ?? {} : {}) };
  // The conversations now live in Agents at work: its item carries their badge.
  if (b.conversations && !b.workspace) b.workspace = b.conversations;
  return b;
}
