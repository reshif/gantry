/**
 * The project scope (the prototype's `G.S.project`): every project the viewer may see ("All projects", the default) or one of them.
 * Project pages carry it in the URL (`#/p/all/floor`, `#/p/<id>/floor`); factory pages (Home, Inbox, Agents at work, Connect) read the
 * persisted choice (`prefs.scopeAll` / `prefs.project`), which the shell keeps in step with the URL. Nothing here picks a hidden project:
 * a page that needs exactly one project asks which, it never falls back to the last one.
 */
import { useMemo } from "react";
import { useMe } from "../api/queries";
import type { Me } from "../api/types";
import { useHash } from "./router";
import { usePrefs } from "./prefs";
import { ALL_PROJECTS, pickProject, supportsAll } from "./routes";

type ProjectLite = Me["projects"][number];

export { ALL_PROJECTS, supportsAll };

export interface Scope {
  /** Every project the viewer may see. */
  all: boolean;
  /** The one project in scope; null for All (or when the URL names a project the viewer cannot see). */
  projectId: string | null;
  /** The visible projects in scope: all of them, or just the picked one. */
  projects: ProjectLite[];
}

export function resolveScope(me: Me | null, hashProject: string | null, scopeAll: boolean, stored: string | null): Scope {
  const visible = me?.projects ?? [];
  if (hashProject === ALL_PROJECTS || (!hashProject && scopeAll)) return { all: true, projectId: null, projects: visible };
  const id = hashProject ?? pickProject(me, stored);
  const p = visible.find((x) => x.id === id);
  return { all: false, projectId: p?.id ?? null, projects: p ? [p] : [] };
}

export function useScope(): Scope {
  const me = useMe();
  const prefs = usePrefs();
  const loc = useHash();
  return useMemo(() => resolveScope(me ?? null, loc.project, prefs.scopeAll, prefs.project), [me, loc.project, prefs.scopeAll, prefs.project]);
}

/** The hash project token for the current choice: "all" or a project id. */
export const scopeToken = (s: Pick<Scope, "all" | "projectId">): string | null => (s.all ? ALL_PROJECTS : s.projectId);
