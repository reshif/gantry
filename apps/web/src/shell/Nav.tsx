/** Left nav (legacy renderNav): groups filtered by role, collapsible groups, icon rail, badges. */
import { useEffect, useRef, useState } from "react";
import { useNavBadges } from "../api/queries";
import { useCan, useCanMany } from "../api/can";
import type { Me } from "../api/types";
import { NAV_GROUPS, ROUTES, ROUTE_PERMS, canSeeRoute, isProjectRoute } from "../lib/routes";
import { hashFor } from "../lib/router";
import { usePrefs } from "../lib/prefs";
import { Icon } from "../ui/Icon";
import { sectionTag, toggleNavRail, toggleNavSection, useDrawerWidth, useNavRail } from "./navRail";

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

/** The Gantry mark of the blueprint prototype: a registration square with a drafting grid and a filled centre. */
export function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="var(--accent)" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="3" width="26" height="26" />
      <path d="M3 12h26M3 20h26M12 3v26M20 3v26" strokeWidth=".8" opacity=".6" />
      <circle cx="16" cy="16" r="5" fill="var(--accent)" />
    </svg>
  );
}

/**
 * True when the server says this session may submit no work and change nothing. Decided by the can-decisions
 * (wo.submit and line.halt on the first project, kill.factory), never by comparing role names; false while unresolved.
 */
export function useReadOnly(): boolean {
  const checks = useCanMany([{ action: "wo.submit" }, { action: "line.halt" }, { action: "kill.factory" }]);
  return checks.every((c) => !c.pending && !c.allowed);
}

const GROUP_LABEL: Record<string, string> = { Project: "Project line" };

/** What the rail flyout shows for the icon the pointer or focus is on. */
interface Fly { label: string; sub: string; key: string; top: number; left: number }

/**
 * Sidebar (prototype .side): brand, then the groups as a mono heading and a list of links. The groups, routes, badges and
 * permission filtering are the app's; only the markup is the prototype's. Under 1025px it slides over the page (`open`).
 * From 1025px it collapses to an icon rail: the Gantry mark is the handle (with a notch on the panel edge and "[" on the
 * keyboard), sections become ruled dividers with a mono tag, badges become a dot, and a flyout names the icon under the
 * pointer or focus. Each section can also be folded on its own (aria-expanded), and the choices are remembered.
 */
export function Nav({ me, current, project, open, onNavigate }: { me: Me; current: string; project: ProjectLite | null; open: boolean; onNavigate: () => void }) {
  const readOnly = useReadOnly();
  const prefs = usePrefs();
  const badges = useNavBadges();
  const access = useRouteAccess(me);
  const rail = useNavRail();
  const drawer = useDrawerWidth();
  const [fly, setFly] = useState<Fly | null>(null);
  const inProject = isProjectRoute(current) && !!project;
  // on factory pages the Project group is a shortcut to the last project, never a selector implying scope
  const shown = inProject ? project : (me.projects.find((p) => p.id === prefs.project) ?? null);
  const toggleLabel = rail ? "Expand navigation" : "Collapse navigation";

  const showFly = (e: { target: EventTarget | null }) => {
    const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-fly]");
    if (!el || !(rail || el.dataset.flyAlways)) return setFly(null);
    const r = el.getBoundingClientRect();
    setFly({ label: el.dataset.fly ?? "", sub: el.dataset.flySub ?? "", key: el.dataset.flyKey ?? "", top: r.top + r.height / 2, left: r.right + 10 });
  };
  // pointer, focus and Escape listening is attached to the landmark itself (a non-interactive element takes no JSX handlers)
  const navEl = useRef<HTMLElement>(null);
  const showRef = useRef(showFly);
  showRef.current = showFly;
  const flyOpen = !!fly;
  useEffect(() => {
    const el = navEl.current;
    if (!el) return;
    const over = (e: Event) => showRef.current(e);
    const leave = () => setFly(null);
    const out = (e: FocusEvent) => { if (!el.contains(e.relatedTarget as Node | null)) setFly(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && flyOpen) { setFly(null); e.stopPropagation(); } };
    el.addEventListener("mouseover", over);
    el.addEventListener("focusin", over);
    el.addEventListener("mouseleave", leave);
    el.addEventListener("focusout", out);
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("mouseover", over);
      el.removeEventListener("focusin", over);
      el.removeEventListener("mouseleave", leave);
      el.removeEventListener("focusout", out);
      el.removeEventListener("keydown", key);
    };
  }, [flyOpen]);
  const mark = <BrandMark />;
  return (
    <nav
      ref={navEl}
      className={`side${open ? " open" : ""}${rail ? " rail" : ""}`}
      id="side"
      aria-label="Primary"
    >
      <div className="brand">
        {drawer ? (
          <a className="brand-mark" href="#home" onClick={onNavigate} aria-label="Gantry home">{mark}</a>
        ) : (
          <button type="button" className="brand-mark" id="nav-rail-toggle" aria-label={toggleLabel} aria-expanded={!rail} aria-controls="nav" aria-keyshortcuts="[" data-fly={toggleLabel} data-fly-key="[" data-fly-always="1" onClick={toggleNavRail}>
            {mark}
          </button>
        )}
        <a className="brand-name" href="#home" onClick={onNavigate} tabIndex={rail ? -1 : undefined} aria-hidden={rail ? true : undefined}>
          <b>Gantry</b>
          <small>{readOnly ? "READ-ONLY SHEET" : (me.org?.plant ?? me.config.orgName ?? "Software factory").toUpperCase()}</small>
        </a>
      </div>
      {drawer ? null : (
        <button type="button" className="rail-notch" aria-hidden="true" tabIndex={-1} onClick={toggleNavRail}>
          <Icon name={rail ? "right" : "left"} />
        </button>
      )}
      <div className="nav" id="nav">
        {NAV_GROUPS.map((gname) => {
          const noProj = gname === "Project" && !shown;
          const items = ROUTES.filter((r) => r.group === gname && r.nav !== false && (noProj || access.visible(r.id) || r.id === "design-system"));
          if (!items.length) return null;
          const label = GROUP_LABEL[gname] ?? gname;
          const isActive = (it: (typeof items)[number]) => current === it.id || (it.id === "work-orders" && (current === "record" || current === "changes" || current === "traveler")) || (it.id === "people" && current === "person");
          // a folded section still shows the page you are on, so the nav never loses your place; the rail never folds
          const folded = !rail && !!prefs.navCollapsed[gname];
          const list = folded ? items.filter(isActive) : items;
          const sid = `nav-sec-${gname.toLowerCase()}`;
          return (
            <div key={gname} role="group" aria-label={label} className={`sec${folded ? " folded" : ""}`}>
              <h3>
                {rail ? (
                  <>
                    <span className="sr-only">{label}</span>
                    <span className="sec-tag" aria-hidden="true">{sectionTag(gname)}</span>
                  </>
                ) : (
                  <button type="button" className="sec-h" aria-expanded={!folded} aria-controls={sid} onClick={() => toggleNavSection(gname)}>
                    <span>{label}</span>
                    {folded ? <span className="sec-n" aria-label={`${items.length} pages`}>{items.length}</span> : null}
                    <Icon name="chevron" />
                  </button>
                )}
              </h3>
              <div id={sid} className="sec-items">
                {list.map((it) => {
                  const bd = badges[it.id];
                  const active = isActive(it);
                  const bt = bd ? (bd.text ?? String(bd.n ?? 0)) : "";
                  return (
                    <a key={it.id} href={hashFor(it.id, null, it.project ? shown?.id : null)} aria-current={active ? "page" : undefined} data-fly={it.title} data-fly-sub={bd ? (bd.label ?? bt) : ""} onClick={onNavigate}>
                      <Icon name={it.icon} />
                      <span className="lbl">{it.title}</span>
                      {bd ? <span className={`cnt ${bd.kind || ""}`} title={rail ? undefined : bd.label}>{bt}</span> : null}
                    </a>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {fly ? (
        <div className="rail-fly" id="nav-fly" aria-hidden="true" style={{ top: fly.top, left: fly.left }}>
          <b>{fly.label}</b>
          {fly.sub ? <span>{fly.sub}</span> : null}
          {fly.key ? <kbd>{fly.key}</kbd> : null}
        </div>
      ) : null}
    </nav>
  );
}

export type ProjectLite = Me["projects"][number];
