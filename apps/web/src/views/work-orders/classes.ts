/** Every class the register knows, as the prototype's CLASSES: the built-in ones, the custom ones of any project, and those on the project's own flow. */
import type { Catalog, Project, WorkClass } from "@gantry/domain";

export function allClasses(cat: Catalog, project: Pick<Project, "flow"> | null): WorkClass[] {
  const seen = new Set<string>();
  const out: WorkClass[] = [];
  for (const c of [...cat.classes, ...(project?.flow?.classes ?? [])]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}
