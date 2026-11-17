/** The one project switcher: top bar, right after the logo. Popover: portfolio, search, pinned, recent, all. */
import { useRef, useState } from "react";
import type { Me } from "../api/types";
import { isProjectRoute } from "../lib/routes";
import { hashFor } from "../lib/router";
import { togglePinnedProject, usePrefs } from "../lib/prefs";
import { Icon } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";

type ProjectLite = Me["projects"][number];

/** The one project selector, pinned at the top of the sidebar on every page. */
export function ProjectSwitcher({ me, project, current }: { me: Me; project: ProjectLite | null; current: string }) {
  const ui = useUI();
  const ref = useRef<HTMLButtonElement>(null);
  const open = () => {
    if (ref.current) ui.popover(ref.current, (close) => <SwitcherList me={me} currentId={project?.id ?? null} route={current} close={close} />);
  };
  const status = project ? (project.killed ? "killed" : project.halted ? "halted" : project.status) : null;
  const name = project ? project.name : "Choose a project";
  return (
    <button ref={ref} type="button" className="btn proj-btn" id="project-switcher" aria-haspopup="dialog" aria-label={project ? `Project ${project.name}. Switch project` : "Choose a project"} title={name.length > 28 ? name : undefined} onClick={open}>
      <Icon name="folder" />
      <span className="trunc pn-full proj-btn-name" style={{ maxWidth: 150 }}>{name}</span>
      <span className="pn-short">{project?.key ?? "All"}</span>
      {status === "killed" || status === "halted" ? <span className={`proj-btn-dot st-${status}`} role="img" aria-label={status} title={status} /> : null}
      <Icon name="down" />
    </button>
  );
}

/** Pages that keep their meaning in another project; the rest land on that project's Floor. */
const keepRoute = (r: string): string => ((r === "record" || r === "changes") ? "work-orders" : r === "conversations" ? "conversations" : r);

function SwitcherList({ me, currentId, route, close }: { me: Me; currentId: string | null; route: string; close: () => void }) {
  const prefs = usePrefs();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const byId = new Map(me.projects.map((p) => [p.id, p] as const));
  const pick = (ids: string[]) => ids.map((i) => byId.get(i)).filter((p): p is ProjectLite => !!p);
  const pinned = pick(prefs.pinnedProjects);
  const recent = pick(prefs.recentProjects).filter((p) => !prefs.pinnedProjects.includes(p.id) && p.id !== currentId).slice(0, 5);
  const match = (p: ProjectLite) => !needle || `${p.name} ${p.key}`.toLowerCase().includes(needle);
  const rest = me.projects.filter((p) => match(p));
  const LIMIT = 40;
  const row = (p: ProjectLite) => (
    <li key={p.id} className="sw-row">
      <a href={hashFor(isProjectRoute(route) ? keepRoute(route) : "floor", null, p.id)} className={`sw-link${p.id === currentId ? " is-active" : ""}`} aria-current={p.id === currentId ? "true" : undefined} onClick={close}>
        <span>{p.name}</span>
        {p.killed ? <span className="muted small">killed</span> : p.halted ? <span className="muted small">halted</span> : p.status !== "active" ? <span className="muted small">{p.status}</span> : null}
      </a>
      <button type="button" className="icon-btn icon-btn-sm" aria-label={`${prefs.pinnedProjects.includes(p.id) ? "Unpin" : "Pin"} ${p.name}`} aria-pressed={prefs.pinnedProjects.includes(p.id)} onClick={() => togglePinnedProject(p.id)}>
        <Icon name="pin" />
      </button>
    </li>
  );
  const sec = (label: string, list: ProjectLite[]) => (list.length ? <><div className="sw-sec">{label}</div><ul className="plain-list">{list.map(row)}</ul></> : null);
  return (
    <div className="sw-pop" id="project-switcher-list">
      <a href="#projects" className="sw-all" id="sw-portfolio" onClick={close}>All projects (portfolio)</a>
      <input className="input sw-search" type="search" placeholder="Find a project…" aria-label="Find a project" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {!needle ? sec("Pinned", pinned) : null}
      {!needle ? sec("Recent", recent) : null}
      {sec(needle ? "Matches" : "All projects", rest.slice(0, LIMIT))}
      {rest.length > LIMIT ? <p className="muted small">{`${rest.length - LIMIT} more. Type to narrow.`}</p> : null}
      {!rest.length ? <p className="muted small">No project matches.</p> : null}
    </div>
  );
}

