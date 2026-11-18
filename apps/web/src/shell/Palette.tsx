/** Command palette (prototype): one search box over Go to, Actions, Projects, Work orders, Agents and People, grouped, with an icon per row and a right-aligned tag. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAgents, useMe, usePeople, useWorkOrders } from "../api/queries";
import { useCanMany } from "../api/can";
import { canSeeRoute, ROUTES } from "../lib/routes";
import { navigate, navigateProject } from "../lib/router";
import { applyTheme, setProject, updatePrefs, usePrefs } from "../lib/prefs";
import { Dialog } from "../ui/Overlay";
import { CrIcon } from "../ui/cr";
import type { Decision } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { NAV_ICON, NAV_LAYOUT, useRouteCtx } from "./Nav";
import { makeStopActions } from "./stopActions";
import { useNotifications } from "./NotificationsDrawer";
import { markNotificationsRead } from "./notifRead";

const GROUPS = ["Go to", "Actions", "Projects", "Work orders", "Agents", "People"] as const;
type Group = (typeof GROUPS)[number];

interface Item {
  key?: string;
  group: Group;
  icon: string;
  label: string;
  /** Extra words the search matches (not shown). */
  keys?: string;
  /** Right-aligned small tag. */
  tag?: string;
  guard?: Decision | undefined;
  run: () => void;
}

export function usePaletteItems(projectId: string | null): Item[] {
  const me = useMe();
  const ui = useUI();
  const prefs = usePrefs();
  const ctx = useRouteCtx();
  const notif = useNotifications();
  const wos = useWorkOrders(projectId, { limit: 500 }).data;
  const canAgents = canSeeRoute("agents", me, ctx);
  const agents = useAgents().data;
  const people = usePeople().data;
  const cp = me?.projects.find((p) => p.id === projectId) ?? null;
  const factoryKilled = !!me?.factory.killed;
  const checks = useCanMany([
    { action: cp?.halted ? "line.resume" : "line.halt", project: cp?.id },
    { action: cp?.killed ? "restore.project" : "kill.project", project: cp?.id },
    { action: factoryKilled ? "restore.factory" : "kill.factory" },
    { action: "wo.submit", project: cp?.id },
  ]);
  return useMemo(() => {
    if (!me) return [];
    const items: Item[] = [];
    const stop = makeStopActions(ui, me);
    const guard = (i: number): Decision | undefined => (checks[i]?.pending ? undefined : checks[i]);
    const allowedNow = (i: number): boolean => !checks[i]?.pending && !!checks[i]?.allowed;
    // project pages need a project: the one in view, else the remembered one, else the first the person can see
    const target = cp ?? me.projects.find((p) => p.id === prefs.project) ?? me.projects[0] ?? null;
    // in the rail's order, with the rail's icons
    for (const r of NAV_LAYOUT.flatMap((g) => g.ids).map((id) => ROUTES.find((x) => x.id === id)).filter((x): x is (typeof ROUTES)[number] => !!x)) if (canSeeRoute(r.id, me, ctx)) items.push({ key: r.id, group: "Go to", icon: NAV_ICON[r.id] ?? r.icon, label: r.title, keys: r.id, run: () => (r.project ? (target ? navigateProject(target.id, r.id) : navigate("projects")) : navigate(r.id)) });
    items.push({ group: "Actions", icon: "plus", label: "Submit a work order", keys: "new submit create", guard: guard(3), run: () => navigate("console", "submit") });
    items.push({ group: "Actions", icon: "sun", label: "Toggle theme (dark / light)", keys: "theme dark light", run: () => {
      const dark = document.documentElement.getAttribute("data-theme") === "dark" || (prefs.theme === "system" && typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
      const next = dark ? "light" : "dark";
      updatePrefs({ theme: next });
      applyTheme(next);
    } });
    // The emergency stop is offered only to people who hold the right (the server decides); the dialogs ask for the reason and step-up.
    if (allowedNow(2)) items.push({ group: "Actions", icon: "stop", label: factoryKilled ? "Restore the factory…" : "Emergency stop the factory…", keys: "kill halt stop restore", guard: guard(2), run: () => (factoryKilled ? stop.restore("factory", null) : stop.kill("factory", null)) });
    items.push({ group: "Actions", icon: "bell", label: "Mark all notifications read", keys: "read", run: () => { markNotificationsRead(notif.signature); ui.toast("Marked read", "ok"); } });
    for (const p of me.projects) items.push({ key: `project:${p.id}`, group: "Projects", icon: "projects", label: p.name, keys: `${p.key} ${p.id}`, tag: p.key, run: () => { setProject(p.id); navigateProject(p.id, "project-config"); } });
    const woList = [...(Array.isArray(wos) ? wos : (wos?.items ?? []))].sort((x, y) => Number(x.state === "done") - Number(y.state === "done") || x.id.localeCompare(y.id, undefined, { numeric: true })); // open work first, then shipped, each in id order
    for (const w of woList) items.push({ key: `wo:${w.id}`, group: "Work orders", icon: "wo", label: `${w.id} · ${w.title}`, keys: `${w.repo} ${w.state}`, tag: w.project ?? projectId ?? undefined, run: () => navigate("record", w.id, w.project ?? projectId) });
    if (canAgents) for (const a of agents ?? []) items.push({ key: `agent:${a.id}`, group: "Agents", icon: "agent", label: a.name, keys: `${a.id} ${a.model}`, run: () => { navigate("agents", a.id); } });
    if (canSeeRoute("people", me, ctx)) for (const p of Array.isArray(people) ? people : []) items.push({ key: `person:${p.id}`, group: "People", icon: "people", label: p.name, keys: `${p.email} ${p.title}`, run: () => navigate("person", p.id) });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, wos, agents, people, canAgents, cp, factoryKilled, prefs.project, prefs.theme, notif.signature, ctx.canAudit, checks.map((c) => c.pending + ":" + c.allowed).join("|")]);
}

export function PaletteDialog({ projectId, onClose }: { projectId: string | null; onClose: () => void }) {
  const ui = useUI();
  const all = usePaletteItems(projectId);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = all.filter((it) => !needle || needle.split(/\s+/).every((w) => `${it.label} ${it.keys ?? ""}`.toLowerCase().includes(w)));
    // grouped in the prototype's order, 40 at most
    return GROUPS.flatMap((g) => hit.filter((it) => it.group === g)).slice(0, 40);
  }, [q, all]);

  const cur = Math.min(active, Math.max(0, shown.length - 1));
  useEffect(() => {
    listRef.current?.querySelector(`#pal-opt-${cur}`)?.scrollIntoView?.({ block: "nearest" });
  }, [cur]);

  const runAt = (i: number) => {
    const it = shown[i];
    if (!it) return;
    if (it.guard && !it.guard.allowed) {
      ui.toast((it.guard.needs ? `${it.guard.needs}. ` : "") + it.guard.reason, "error");
      return;
    }
    onClose();
    setTimeout(it.run, 0);
  };

  const rows: ReactNode[] = [];
  if (!shown.length) rows.push(<li key="empty" className="palette-empty empty" role="presentation" style={{ padding: 24 }}>No results</li>);
  let last: string | null = null;
  shown.forEach((it, i) => {
    if (it.group !== last) rows.push(<li key={`g-${it.group}`} className="pal-grp label" role="presentation">{it.group}</li>);
    last = it.group;
    const locked = !!it.guard && !it.guard.allowed;
    rows.push(
      <li
        key={`${it.key ?? it.label}-${i}`}
        role="option"
        id={`pal-opt-${i}`}
        className={`pal-it palette-item${i === cur ? " is-active" : ""}${locked ? " is-locked" : ""}`}
        aria-selected={i === cur ? "true" : "false"}
        aria-disabled={locked ? "true" : undefined}
        onMouseDown={(e) => {
          e.preventDefault();
          setActive(i);
          runAt(i);
        }}
      >
        <CrIcon name={it.icon} />
        <span className="ell pal-label">{it.label}</span>
        {locked && it.guard ? <small>{it.guard.needs || "Not permitted"}</small> : it.tag ? <small>{it.tag}</small> : null}
      </li>,
    );
  });

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(shown.length - 1, cur + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(0, cur - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(cur);
    }
  };

  return (
    <Dialog
      title="Command palette"
      cls="dlg-palette pal-cr"
      onClose={onClose}
      body={
        <div className="palette pal-in">
          <input
            id="palette-input"
            className="palette-input"
            placeholder="Jump to a screen, work order, agent, person…"
            autoComplete="off"
            aria-controls="palette-list"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-activedescendant={shown.length ? `pal-opt-${cur}` : ""}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
          <ul id="palette-list" className="palette-list pal-res" role="listbox" aria-label="Results" ref={listRef}>
            {rows}
          </ul>
          <div className="dlg-f pal-foot"><span className="dim mono">↑↓ move · Enter open · Esc close</span></div>
        </div>
      }
      actions={[]}
    />
  );
}
