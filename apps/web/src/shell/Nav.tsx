/** Left nav (legacy renderNav): groups filtered by role, collapsible groups, icon rail, badges. */
import { useNavBadges } from "../api/queries";
import { useCan, useCanMany } from "../api/can";
import type { Me } from "../api/types";
import { NAV_GROUPS, ROUTES, ROUTE_PERMS, canSeeRoute, isProjectRoute } from "../lib/routes";
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

const GROUP_LABEL: Record<string, string> = { Project: "Project line" };

/**
 * Sidebar (prototype .side): brand, then the groups as a mono heading and a list of links. The groups, routes, badges and
 * permission filtering are the app's; only the markup is the prototype's. Under 1024px it slides over the page (`open`).
 */
export function Nav({ me, current, project, open, onNavigate }: { me: Me; current: string; project: ProjectLite | null; open: boolean; onNavigate: () => void }) {
  const prefs = usePrefs();
  const badges = useNavBadges();
  const access = useRouteAccess(me);
  const inProject = isProjectRoute(current) && !!project;
  // on factory pages the Project group is a shortcut to the last project, never a selector implying scope
  const shown = inProject ? project : (me.projects.find((p) => p.id === prefs.project) ?? null);
  return (
    <nav className={`side${open ? " open" : ""}`} id="side" aria-label="Main">
      <a className="brand" href="#home" onClick={onNavigate}>
        <BrandMark />
        <div>
          <b>Gantry</b>
          <small>{(me.org?.plant ?? me.config.orgName ?? "Software factory").toUpperCase()}</small>
        </div>
      </a>
      <div className="nav" id="nav">
        {NAV_GROUPS.map((gname) => {
          const noProj = gname === "Project" && !shown;
          const items = ROUTES.filter((r) => r.group === gname && r.nav !== false && (noProj || access.visible(r.id) || r.id === "design-system"));
          if (!items.length) return null;
          return (
            <div key={gname} role="group" aria-label={GROUP_LABEL[gname] ?? gname}>
              <h3>{GROUP_LABEL[gname] ?? gname}</h3>
              {items.map((it) => {
                const bd = badges[it.id];
                const active = current === it.id || (it.id === "work-orders" && (current === "record" || current === "changes")) || (it.id === "people" && current === "person");
                return (
                  <a key={it.id} href={hashFor(it.id, null, it.project ? shown?.id : null)} aria-current={current === it.id || active ? "page" : undefined} onClick={onNavigate}>
                    <Icon name={it.icon} />
                    <span>{it.title}</span>
                    {bd ? <span className={`cnt ${bd.kind || ""}`} title={bd.label}>{bd.text ?? String(bd.n ?? 0)}</span> : null}
                  </a>
                );
              })}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

export type ProjectLite = Me["projects"][number];
