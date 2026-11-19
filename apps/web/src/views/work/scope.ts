/** The scope the shell's switcher holds: one project, or the whole factory. The eyebrow names it (`ALL LINES` or the project key) as the prototype's page header does. */
import { useMe, useProjects } from "../../api/queries";
import { usePrefs } from "../../lib/prefs";

export function useScope(): { project: string | null; kicker: string } {
  const prefs = usePrefs();
  const me = useMe();
  const list = useProjects().data ?? me?.projects; // the session lists the projects before the full read lands, so the eyebrow never lags the switcher
  // "All lines" wins: the switcher shows the whole factory whenever scopeAll is set, whatever project was chosen last
  const project = prefs.scopeAll ? null : prefs.project;
  const p = project ? (list ?? []).find((x) => x.id === project) : null;
  return { project: p ? p.id : null, kicker: p ? p.key : "All lines" };
}
