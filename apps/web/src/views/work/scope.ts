/** The scope the shell's switcher holds: one project, or the whole factory. The eyebrow names it (`ALL LINES` or the project key) as the prototype's page header does. */
import { useProjects } from "../../api/queries";
import { usePrefs } from "../../lib/prefs";

export function useScope(): { project: string | null; kicker: string } {
  const prefs = usePrefs();
  const list = useProjects().data;
  const project = prefs.project;
  const p = project ? (list ?? []).find((x) => x.id === project) : null;
  return { project: p ? p.id : null, kicker: p ? p.key : "All lines" };
}
