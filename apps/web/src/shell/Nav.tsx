/** Left nav (legacy renderNav): groups filtered by role, collapsible groups, icon rail, badges. */
import { useRef, useState } from "react";
import { useUI } from "../ui/overlay-context";
import { useNavBadges } from "../api/queries";
import { useCan, useCanMany } from "../api/can";
import type { Me } from "../api/types";
import { NAV_GROUPS, ROUTES, ROUTE_PERMS, canSeeRoute, isProjectRoute, routeDef } from "../lib/routes";
import { hashFor } from "../lib/router";
import { usePrefs } from "../lib/prefs";
import { Icon } from "../ui/Icon";

export function useRouteCtx() {
  const audit = useCan("audit.view");
  return { canAudit: audit.pending ? undefined : audit.allowed };
}

/**
 * Which routes the person may open. Role rules say who could ever see a route; the read permission
 * (default-deny) decides: an item is hidden until the server allows it, and while it is unresolved.
 */
export function useRouteAccess(me: Me): { visible: (id: string) => boolean; denied: (id: string) => boolean } {
  const ctx = useRouteCtx();
  const checks = useCanMany(ROUTE_PERMS.map((r) => ({ action: r.action })));
  const byId = new Map(ROUTE_PERMS.map((r, i) => [r.id, checks[i]] as const));
  return {
    visible: (id) => canSeeRoute(id, me, ctx) && (!byId.has(id) || (byId.get(id)?.pending === false && byId.get(id)?.allowed === true)),
    denied: (id) => byId.has(id) && byId.get(id)?.pending === false && byId.get(id)?.allowed === false,
  };
}

const CLOSED_KEY = "gantry.navClosed";
function readClosed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(CLOSED_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function writeClosed(gs: string[]): void {
  try {
    localStorage.setItem(CLOSED_KEY, JSON.stringify(gs));
  } catch {
    /* storage unavailable: groups just reopen after a reload */
  }
}

/**
 * Left nav: every group shows its pages, so the person always sees where they are and what else exists.
 * A group can be collapsed (remembered per browser); the group holding the current page always stays open.
 * The Project group needs a chosen project.
 */
export function Nav({ me, current, project, onNavigate }: { me: Me; current: string; project: ProjectLite | null; onNavigate: () => void }) {
  const prefs = usePrefs();
  const badges = useNavBadges();
  const access = useRouteAccess(me);
  const rail = prefs.navRail;
  const [closed, setClosedState] = useState<string[]>(readClosed);
  const toggleGroup = (g: string) => {
    const next = closed.includes(g) ? closed.filter((x) => x !== g) : [...closed, g];
    setClosedState(next);
    writeClosed(next);
  };
  const inProject = isProjectRoute(current) && !!project;
  // on factory pages the Project group is a shortcut to the last project, never a selector implying scope
  const shown = inProject ? project : (me.projects.find((p) => p.id === prefs.project) ?? null);
  const activeGroup = routeDef(current)?.group ?? null;
  const go = () => onNavigate();
  const onHeaderKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const hs = Array.from(e.currentTarget.closest("nav")?.querySelectorAll<HTMLButtonElement>(".nav-group-btn") ?? []);
    const i = hs.indexOf(e.currentTarget);
    const n = e.key === "Home" ? 0 : e.key === "End" ? hs.length - 1 : e.key === "ArrowDown" ? (i + 1) % hs.length : (i - 1 + hs.length) % hs.length;
    e.preventDefault();
    hs[n]?.focus();
  };
  return (
    <nav className="nav" id="nav" aria-label="Main">
      {NAV_GROUPS.map((gname) => {
        const isProj = gname === "Project";
        const noProj = isProj && !shown;
        const items = ROUTES.filter((r) => r.group === gname && r.nav !== false && (noProj || access.visible(r.id)));
        if (!items.length) return null;
        const expanded = !noProj && (activeGroup === gname || !closed.includes(gname));
        const gid = `navg-${gname.toLowerCase()}`;
        const total = items.reduce((n, it) => n + (badges[it.id]?.n ?? 0), 0);
        const activeG = activeGroup === gname;
        if (rail) {
          return (
            <RailGroup key={gname} gname={gname} icon={GROUP_ICON[gname] ?? "dots"} items={items} project={shown} active={activeG} disabled={noProj} current={current} onNavigate={onNavigate} onKey={onHeaderKey} />
          );
        }
        return (
          <GroupBlock key={gname}>
            {rail ? (
              <div className="nav-group-rule" role="separator" aria-label={gname} />
            ) : (
              <button
                type="button"
                className={`nav-group nav-group-btn${activeG ? " is-active-group" : ""}`}
                id={`${gid}-btn`}
                aria-expanded={expanded ? "true" : "false"}
                aria-disabled={noProj ? "true" : undefined}
                title={noProj ? "Choose a project" : undefined}
                aria-controls={gid}
                data-active-group={activeG ? "true" : undefined}
                onClick={() => { if (!noProj && activeGroup !== gname) toggleGroup(gname); }}
                onKeyDown={onHeaderKey}
              >
                <Icon name={expanded ? "down" : "chevron"} className="nav-caret" />
                <span className="nav-group-name">
                  {gname}
                  {noProj ? <span className="nav-proj">Choose a project</span> : null}
                </span>
                {!expanded && total ? <span className="nav-count mono">{String(total)}</span> : null}
              </button>
            )}
            <div id={gid} hidden={!expanded}>
              <ul className="nav-list">
                {items.map((it) => {
                  const bd = badges[it.id];
                  const active = current === it.id || (it.id === "work-orders" && current === "record");
                  return (
                    <li key={it.id}>
                      <a
                        href={hashFor(it.id, null, it.project ? shown?.id : null)}
                        className={`nav-link${active ? " is-active" : ""}`}
                        aria-current={current === it.id ? "page" : undefined}
                        aria-label={rail ? it.title + (bd ? `, ${bd.label}` : "") : undefined}
                        data-tip={rail ? it.title + (bd ? ` · ${bd.label}` : "") : undefined}
                        onClick={go}
                      >
                        <Icon name={it.icon} />
                        <span className="nav-text">{it.title}</span>
                        {bd ? bd.text ? <span className={`nav-badge ${bd.kind || ""}`} title={bd.label}>{bd.text}</span> : <span className={`nav-count mono ${bd.kind || ""}`} title={bd.label}>{String(bd.n ?? 0)}</span> : null}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          </GroupBlock>
        );
      })}
    </nav>
  );
}

export type ProjectLite = Me["projects"][number];

const GROUP_ICON: Record<string, string> = { Overview: "home", Project: "project", Agents: "agent", Connect: "plug", Govern: "shield" };

/** Icon-rail mode: one button per group; its items open in a flyout. */
function RailGroup({ gname, icon, items, project, active, disabled, current, onNavigate, onKey }: { gname: string; icon: string; items: typeof ROUTES[number][]; project: ProjectLite | null; active: boolean; disabled: boolean; current: string; onNavigate: () => void; onKey: (e: React.KeyboardEvent<HTMLButtonElement>) => void }) {
  const ui = useUI();
  const ref = useRef<HTMLButtonElement>(null);
  const label = disabled ? `${gname} (choose a project first)` : gname;
  const [isOpen, setIsOpen] = useState(false);
  const openFly = () => {
    if (disabled || !ref.current) return;
    setIsOpen(true);
    ui.popover(ref.current, (close) => <Flyout title={gname} items={items} project={project} current={current} close={() => { close(); onNavigate(); }} />, () => setIsOpen(false));
  };
  return (
    <button ref={ref} type="button" className={`nav-group nav-group-btn nav-rail-group${active ? " is-active-group" : ""}`} id={`navg-${gname.toLowerCase()}-btn`} aria-label={label} data-tip={label} aria-haspopup="menu" aria-expanded={isOpen ? "true" : "false"} aria-disabled={disabled ? "true" : undefined} data-active-group={active ? "true" : undefined} onClick={openFly} onKeyDown={onKey}>
      <Icon name={icon} />
    </button>
  );
}

function Flyout({ title, items, project, current, close }: { title: string; items: typeof ROUTES[number][]; project: ProjectLite | null; current: string; close: () => void }) {
  const onKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const as = Array.from(e.currentTarget.querySelectorAll<HTMLAnchorElement>("a"));
    const i = as.indexOf(document.activeElement as HTMLAnchorElement);
    e.preventDefault();
    as[(i + (e.key === "ArrowDown" ? 1 : -1) + as.length) % as.length]?.focus();
  };
  return (
    <div className="nav-flyout" role="menu" aria-label={title}>
      <div className="sw-sec">{title}</div>
      <ul className="plain-list" onKeyDown={onKey}>
        {items.map((it, i) => (
          <li key={it.id}>
            <a role="menuitem" className={`nav-link${current === it.id ? " is-active" : ""}`} href={hashFor(it.id, null, it.project ? project?.id : null)} aria-current={current === it.id ? "page" : undefined} autoFocus={i === 0} onClick={close}>
              <Icon name={it.icon} />
              <span className="nav-text">{it.title}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GroupBlock({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
