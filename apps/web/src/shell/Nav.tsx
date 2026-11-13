/** Left nav (legacy renderNav): groups filtered by role, collapsible groups, icon rail, badges. */
import { useNavBadges } from "../api/queries";
import { useCan } from "../api/can";
import type { Me } from "../api/types";
import { NAV_GROUPS, ROUTES, canSeeRoute } from "../lib/routes";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Icon } from "../ui/Icon";

export function useRouteCtx() {
  const audit = useCan("audit.view");
  return { canAudit: audit.pending ? undefined : audit.allowed };
}

export function Nav({ me, current, projectName, onNavigate }: { me: Me; current: string; projectName: string | null; onNavigate: () => void }) {
  const prefs = usePrefs();
  const badges = useNavBadges();
  const ctx = useRouteCtx();
  const rail = prefs.navRail;
  return (
    <nav className="nav" id="nav" aria-label="Main">
      <div className="nav-top">
        <button
          type="button"
          className="icon-btn nav-rail-btn"
          id="nav-rail-toggle"
          aria-pressed={rail ? "true" : "false"}
          aria-label={rail ? "Expand sidebar" : "Collapse sidebar to icons"}
          data-tip={rail ? "Expand sidebar" : "Collapse to icons"}
          onClick={() => updatePrefs({ navRail: !rail })}
        >
          <Icon name="rail" />
        </button>
      </div>
      {NAV_GROUPS.map((gname) => {
        const items = ROUTES.filter((r) => r.group === gname && r.nav !== false && canSeeRoute(r.id, me, ctx));
        if (!items.length) return null;
        const collapsed = !rail && !!prefs.navCollapsed[gname];
        const gid = `navg-${gname.toLowerCase()}`;
        const total = items.reduce((n, it) => n + (badges[it.id]?.n ?? 0), 0);
        return (
          <GroupBlock key={gname}>
            {rail ? (
              <div className="nav-group-rule" role="separator" aria-label={gname} />
            ) : (
              <button type="button" className="nav-group nav-group-btn" id={`${gid}-btn`} aria-expanded={collapsed ? "false" : "true"} aria-controls={gid} onClick={() => updatePrefs((p) => ({ navCollapsed: { ...p.navCollapsed, [gname]: !collapsed } }))}>
                <Icon name={collapsed ? "chevron" : "down"} className="nav-caret" />
                {gname === "Project" && projectName ? (
                  <span className="nav-group-name">
                    Project · <span className="nav-proj">{projectName}</span>
                  </span>
                ) : (
                  <span className="nav-group-name">{gname}</span>
                )}
                {collapsed && total ? <span className="nav-count mono">{String(total)}</span> : null}
              </button>
            )}
            <ul className="nav-list" id={gid} hidden={collapsed}>
              {items.map((it) => {
                const bd = badges[it.id];
                const active = current === it.id || (it.id === "work-orders" && current === "record");
                return (
                  <li key={it.id}>
                    <a
                      href={`#${it.id}`}
                      className={`nav-link${active ? " is-active" : ""}`}
                      aria-current={current === it.id ? "page" : undefined}
                      aria-label={rail ? it.title + (bd ? `, ${bd.label}` : "") : undefined}
                      data-tip={rail ? it.title + (bd ? ` · ${bd.label}` : "") : undefined}
                      onClick={onNavigate}
                    >
                      <Icon name={it.icon} />
                      <span className="nav-text">{it.title}</span>
                      {bd ? bd.text ? <span className={`nav-badge ${bd.kind || ""}`} title={bd.label}>{bd.text}</span> : <span className={`nav-count mono ${bd.kind || ""}`} title={bd.label}>{String(bd.n ?? 0)}</span> : null}
                    </a>
                  </li>
                );
              })}
            </ul>
          </GroupBlock>
        );
      })}
    </nav>
  );
}

function GroupBlock({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
