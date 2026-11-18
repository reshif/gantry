/** Left nav (legacy renderNav): groups filtered by role, collapsible groups, icon rail, badges. */
import { useEffect, useRef, useState } from "react";
import { useNavBadges } from "../api/queries";
import { useCan, useCanMany } from "../api/can";
import type { Me } from "../api/types";
import { ROUTES, ROUTE_PERMS, canSeeRoute } from "../lib/routes";
import { hashFor } from "../lib/router";
import { usePrefs } from "../lib/prefs";
import { CrIcon } from "../ui/cr";

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

/** The Control Room sidebar: six groups, in the prototype's order. Items are the real routes; the route table still decides who sees what. */
const NAV_LAYOUT: ReadonlyArray<{ name: string; ids: readonly string[] }> = [
  { name: "Operate", ids: ["home", "inbox", "floor", "work-orders", "workspace"] },
  { name: "Portfolio", ids: ["projects", "onboarding", "project-config"] },
  { name: "Workforce", ids: ["agents", "skills", "models", "evals", "trust", "learning"] },
  { name: "Connect", ids: ["integrations", "mcp", "api", "notifications"] },
  { name: "Govern", ids: ["people", "workload", "access", "security", "audit", "system"] },
  { name: "Reference", ids: ["design-system"] },
];
const NAV_ICON: Record<string, string> = {
  home: "home", inbox: "inbox", floor: "floor", "work-orders": "wo", workspace: "agent", projects: "projects", onboarding: "git", "project-config": "system",
  agents: "agent", skills: "skill", models: "model", evals: "eval", trust: "trust", learning: "learn", integrations: "plug", mcp: "mcp", api: "key",
  notifications: "bell", people: "people", workload: "work", access: "access", security: "security", audit: "audit", system: "system", "design-system": "palette",
};

export function Nav({ me, current, project, onNavigate }: { me: Me; current: string; project: ProjectLite | null; onNavigate: () => void }) {
  const prefs = usePrefs();
  const badges = useNavBadges();
  const access = useRouteAccess(me);
  const ref = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  // On factory pages the project routes are a shortcut to the last project, never a selector implying scope.
  const shown = project ?? (me.projects.find((p) => p.id === prefs.project) ?? null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const upd = () => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 4);
    upd();
    el.addEventListener("scroll", upd);
    return () => el.removeEventListener("scroll", upd);
  }, [current]);
  useEffect(() => {
    try { ref.current?.querySelector("[aria-current=page]")?.scrollIntoView({ block: "nearest" }); } catch { /* not supported */ }
  }, [current]);
  return (
    <nav className={`rail${more ? " more" : ""}`} id="nav" aria-label="Main" ref={ref}>
      {NAV_LAYOUT.map((g) => {
        const items = g.ids.map((id) => ROUTES.find((r) => r.id === id)).filter((r): r is (typeof ROUTES)[number] => !!r && r.nav !== false && ((!!r.project && !shown) || access.visible(r.id)));
        if (!items.length) return null;
        return (
          <div key={g.name} role="group" aria-label={g.name}>
            <div className="navgrp">{g.name}</div>
            {items.map((it) => {
              const bd = badges[it.id];
              const active = current === it.id || (it.id === "work-orders" && (current === "record" || current === "changes" || current === "traveler" || current === "dossier")) || (it.id === "people" && current === "person");
              const off = !!it.project && !shown;
              return (
                <a
                  key={it.id}
                  href={off ? "#projects" : hashFor(it.id, null, it.project ? shown?.id : null)}
                  className="navlink"
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                  {...(off ? { title: "Choose a project" } : {})}
                >
                  <CrIcon name={NAV_ICON[it.id] ?? "info"} />
                  <span>{it.title}</span>
                  {bd && (bd.text || bd.n) ? <span className={`badge${bd.kind === "wait" || bd.kind === "block" || !bd.kind ? " hot" : ""}`} title={bd.label}>{bd.text ?? String(bd.n ?? 0)}</span> : null}
                </a>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

export type ProjectLite = Me["projects"][number];
