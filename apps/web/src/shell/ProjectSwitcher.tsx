/** The one project switcher, right after the brand (prototype: a menu with a filter field, an "All projects" scope row, then one row per project with lamp, key tag and check). */
import { useRef, useState } from "react";
import type { Me } from "../api/types";
import { isProjectRoute } from "../lib/routes";
import { navigate } from "../lib/router";
import { setProject, updatePrefs, usePrefs } from "../lib/prefs";
import { CrIcon, Lamp } from "../ui/cr";
import { useUI } from "../ui/overlay-context";
import { CrMenu, MenuRow } from "./CrMenu";

type ProjectLite = Me["projects"][number];

/** Pages that keep their meaning in another project; the rest land on that project's Floor. */
const keepRoute = (r: string): string => ((r === "record" || r === "changes" || r === "traveler" || r === "dossier") ? "work-orders" : r === "conversations" ? "conversations" : r);

export function ProjectSwitcher({ me, project, current }: { me: Me; project: ProjectLite | null; current: string }) {
  const ui = useUI();
  const prefs = usePrefs();
  const ref = useRef<HTMLButtonElement>(null);
  const onProjectRoute = isProjectRoute(current);
  const all = !onProjectRoute && prefs.scopeAll;
  const name = all || !project ? "All projects" : project.name;
  const open = () => {
    if (ref.current) ui.popover(ref.current, (close) => <SwitcherList me={me} currentId={all ? null : (project?.id ?? null)} route={current} close={close} />, undefined, { cls: "pop-cr", role: "menu", label: "Projects", width: 220, align: "left" });
  };
  const status = !all && project ? (project.killed ? "killed" : project.halted ? "halted" : null) : null;
  return (
    <button ref={ref} type="button" className="pill-btn proj-sw" id="project-switcher" aria-haspopup="menu" aria-expanded="false" aria-label={`Project: ${name}. Switch project`} title={name.length > 28 ? name : undefined} onClick={open}>
      <CrIcon name="projects" />
      <span className="ell">{name}</span>
      {status ? <span className={`lamp ${status === "killed" ? "bad" : "warn"}`} role="img" aria-label={status} title={status} /> : null}
      <CrIcon name="chevd" />
    </button>
  );
}

function SwitcherList({ me, currentId, route, close }: { me: Me; currentId: string | null; route: string; close: () => void }) {
  const ui = useUI();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const onProjectRoute = isProjectRoute(route);
  const match = (label: string, key?: string) => !needle || `${label} ${key ?? ""}`.toLowerCase().includes(needle);
  const projects = me.projects.filter((p) => match(p.name, p.key));
  const showAll = match("All projects");

  const pickAll = () => {
    close();
    updatePrefs({ scopeAll: true });
    // a project page needs a project: the portfolio is its "all projects" view
    if (onProjectRoute) navigate("projects");
    ui.toast("Showing All projects", "info");
  };
  const pick = (p: ProjectLite) => {
    close();
    setProject(p.id);
    updatePrefs({ scopeAll: false });
    if (onProjectRoute) navigate(keepRoute(route), null, p.id);
    ui.toast(`Showing ${p.name}`, "info");
  };
  return (
    <CrMenu onKey={(e) => { if (e.key === "ArrowDown" && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); (e.currentTarget.querySelector(".mi") as HTMLElement | null)?.focus(); e.stopPropagation(); } }}>
      <div className="menu-hd">
        <input className="in" id="project-switcher-q" placeholder="Find project" aria-label="Find project" style={{ marginBottom: 4 }} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </div>
      <div id="project-switcher-list">
        {showAll ? <MenuRow radio icon="projects" label="All projects" checked={currentId === null} onClick={pickAll} /> : null}
        {projects.map((p) => (
          <MenuRow key={p.id} radio lead={<Lamp tone={p.killed ? "bad" : p.halted ? "warn" : "ok"} />} label={p.name} tag={p.key} checked={p.id === currentId} onClick={() => pick(p)} />
        ))}
        {!showAll && !projects.length ? <div className="mh dim">No match</div> : null}
      </div>
    </CrMenu>
  );
}
