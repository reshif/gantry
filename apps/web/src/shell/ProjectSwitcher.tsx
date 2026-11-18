/** The one project switcher: top bar, right after the burger. A prototype menu: PROJECT LINE heading, All projects, one entry per project. */
import { useRef } from "react";
import type { Me } from "../api/types";
import { isProjectRoute } from "../lib/routes";
import { navigate, navigateProject } from "../lib/router";
import { setProject, usePrefs } from "../lib/prefs";
import { Icon } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";

type ProjectLite = Me["projects"][number];

/** Pages that keep their meaning in another project; the rest land on that project's Floor. */
const keepRoute = (r: string): string => ((r === "record" || r === "changes" || r === "traveler") ? "work-orders" : r);

/** `project` is the project of the page being shown; null on factory pages, where the button reads "All projects". */
export function ProjectSwitcher({ me, project, current }: { me: Me; project: ProjectLite | null; current: string }) {
  const ui = useUI();
  const prefs = usePrefs();
  const ref = useRef<HTMLButtonElement>(null);
  const open = () => {
    if (!ref.current) return;
    // pinned projects first (a kept convenience), then the rest in the server's order
    const pinned = me.projects.filter((p) => prefs.pinnedProjects.includes(p.id));
    const ordered = [...pinned, ...me.projects.filter((p) => !prefs.pinnedProjects.includes(p.id))];
    ui.menu(ref.current, null, [
      { head: "Project line" },
      { label: "All projects", icon: "grid", sel: !project, onClick: () => { navigate("projects"); ui.toast("Showing all projects"); } },
      { sep: true },
      ...ordered.map((p) => ({
        label: `${p.name}  ·  ${p.key}`,
        icon: "folder",
        sel: p.id === project?.id,
        ...(p.killed ? { hint: "killed" } : p.halted ? { hint: "halted" } : {}),
        onClick: () => {
          setProject(p.id);
          navigateProject(p.id, isProjectRoute(current) ? keepRoute(current) : "floor");
          ui.toast(`Project: ${p.name}`);
        },
      })),
    ]);
  };
  const name = project ? project.name : "All projects";
  return (
    <button ref={ref} type="button" className="btn proj-btn" id="project-switcher" aria-haspopup="menu" aria-label={project ? `Project ${project.name}. Switch project` : "All projects. Switch project"} title={name.length > 28 ? name : undefined} onClick={open}>
      <Icon name="folder" />
      <span className="trunc pn-full proj-btn-name" style={{ maxWidth: 150 }}>{name}</span>
      <span className="pn-short">{project?.key ?? "All"}</span>
      <Icon name="down" />
    </button>
  );
}
