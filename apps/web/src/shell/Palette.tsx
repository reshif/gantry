/** Command palette (legacy openPalette): views, projects, work orders, repos, agents and actions; pins and recents. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAgents, useMe, useReposAcross, useWorkOrdersAcross } from "../api/queries";
import { useCanMany } from "../api/can";
import { ops } from "../api/ops";
import { canSeeRoute, isProjectRoute, ROUTES } from "../lib/routes";
import { hasCommand, runCommand } from "../lib/commands";
import { navigate, navigateProject, openRecordRoute, useHash } from "../lib/router";
import { applyTheme, setProject, updatePrefs, usePrefs } from "../lib/prefs";
import { Dialog } from "../ui/Overlay";
import { Icon } from "../ui/Icon";
import type { Decision } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { useRouteCtx } from "./Nav";
import { makeStopActions } from "./stopActions";

interface Item {
  key?: string;
  /** Group label shown before the hint ("Go to", "Projects", ...). */
  group: string;
  icon: string;
  label: string;
  hint: string;
  guard?: Decision | undefined;
  run: () => void;
}

interface Row {
  it: Item;
}

export function usePaletteItems(projectId: string | null): Item[] {
  const me = useMe();
  const prefs = usePrefs();
  const ui = useUI();
  const ctx = useRouteCtx();
  const loc = useHash();
  // the prototype lists work orders of every project, not only the scoped one
  const wos = useWorkOrdersAcross((me?.projects ?? []).map((p) => p.id), { limit: 50 });
  // like the prototype: the repos of every project, each opening on its own project's onboarding
  const repos = useReposAcross((me?.projects ?? []).map((p) => p.id));
  const canAgents = canSeeRoute("agents", me, ctx);
  const agents = useAgents().data;
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
    for (const r of ROUTES) if (r.nav !== false && canSeeRoute(r.id, me, ctx)) items.push({ key: r.id, group: "Go to", icon: r.icon, label: r.title, hint: r.group === "Project" ? "Project line" : r.group, run: () => r.project && cp ? navigateProject(cp.id, r.id) : navigate(r.id) });
    for (const p of me.projects) items.push({ key: `project:${p.id}`, group: "Projects", icon: "folder", label: p.name, hint: p.key, run: () => { setProject(p.id); if (isProjectRoute(loc.id)) navigateProject(p.id, loc.id); ui.toast(`Project: ${p.name}`); } });
    for (const w of wos) items.push({ key: `record:${w.id}`, group: "Work orders", icon: "record", label: `${w.id} · ${w.title}`, hint: w.state, run: () => { setProject(w.project); openRecordRoute(w.id); } });
    if (canAgents) for (const a of agents ?? []) items.push({ key: `agent:${a.id}`, group: "Agents", icon: "agent", label: a.name, hint: a.station || "agent", run: () => { navigate("agents", a.id); } });
    for (const r of repos) items.push({ key: `repo:${r.id}`, group: "Repos", icon: "branch", label: r.name, hint: r.lang, run: () => { setProject(r.projectId); navigateProject(r.projectId, "onboarding", r.id); } });
    if (hasCommand("newWorkOrder")) items.push({ group: "Actions", icon: "plus", label: "Submit a work order", hint: "", guard: guard(3), run: () => void runCommand("newWorkOrder") });
    items.push({ key: "toggle-theme", group: "Actions", icon: "moon", label: "Toggle theme", hint: "", run: () => { const dark = document.documentElement.dataset.theme === "dark" || (prefs.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches); applyTheme(dark ? "light" : "dark"); } });
    if (cp) {
      items.push({ group: "Actions", icon: "pause", label: `${cp.halted ? "Resume " : "Halt "}${cp.name}`, hint: "andon", guard: guard(0), run: () => (cp.halted ? void stop.resume(cp.id) : stop.halt(cp.id)) });
      // Kill and restore are offered only to people who hold the right (resolved by the server); the dialogs ask for the reason and step-up.
      if (allowedNow(1)) items.push({ group: "Actions", icon: "stop", label: `${cp.killed ? "Restore" : "Kill"} ${cp.name}…`, hint: "kill switch", guard: guard(1), run: () => (cp.killed ? stop.restore("project", cp.id) : stop.kill("project", cp.id)) });
    }
    if (allowedNow(2)) items.push({ group: "Actions", icon: "stop", label: factoryKilled ? "Restore factory…" : "Kill factory…", hint: "kill switch", guard: guard(2), run: () => (factoryKilled ? stop.restore("factory", null) : stop.kill("factory", null)) });
    items.push({ group: "Actions", icon: "logout", label: "Sign out", hint: "", run: () => void ops.signOut() });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, prefs.theme, loc.id, wos, repos, agents, canAgents, cp, factoryKilled, ctx.canAudit, checks.map((c) => c.pending + ":" + c.allowed).join("|")]);
}

export function PaletteDialog({ projectId, onClose }: { projectId: string | null; onClose: () => void }) {
  const ui = useUI();
  const prefs = usePrefs();
  const all = usePaletteItems(projectId);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const shown: Row[] = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hay = (it: Item) => `${it.label} ${it.group} ${it.hint}`.toLowerCase();
    const hits = all.filter((it) => !needle || needle.split(/\s+/).every((w) => hay(it).includes(w)));
    // pinned first (a kept convenience), then the prototype order; the first 40
    const pinned = hits.filter((it) => it.key && prefs.palettePinned.includes(it.key));
    return [...pinned, ...hits.filter((it) => !pinned.includes(it))].slice(0, 40).map((it) => ({ it }));
  }, [q, all, prefs.palettePinned]);

  const cur = Math.min(active, Math.max(0, shown.length - 1));
  useEffect(() => {
    listRef.current?.querySelector(`#pal-opt-${cur}`)?.scrollIntoView?.({ block: "nearest" });
  }, [cur]);

  const togglePin = (key: string) =>
    updatePrefs((p) => {
      const l = p.palettePinned.slice();
      const i = l.indexOf(key);
      if (i >= 0) l.splice(i, 1);
      else l.unshift(key);
      return { palettePinned: l.slice(0, 8) };
    });

  const runAt = (i: number) => {
    const row = shown[i];
    if (!row) return;
    const it = row.it;
    if (it.guard && !it.guard.allowed) {
      ui.toast((it.guard.needs ? `${it.guard.needs}. ` : "") + it.guard.reason, "error");
      return;
    }
    const key = it.key;
    if (key) updatePrefs((p) => ({ paletteRecent: [key, ...p.paletteRecent.filter((k) => k !== key)].slice(0, 8) }));
    onClose();
    setTimeout(it.run, 0);
  };

  const rows: ReactNode[] = [];
  if (!shown.length) rows.push(<li key="empty" className="palette-empty" role="presentation">No matches</li>);
  shown.forEach((row, i) => {
    const it = row.it;
    const locked = !!it.guard && !it.guard.allowed;
    const isPinned = !!it.key && prefs.palettePinned.includes(it.key);
    rows.push(
      <li
        key={`${it.key ?? it.label}-${i}`}
        role="option"
        id={`pal-opt-${i}`}
        className={`palette-item${i === cur ? " is-active" : ""}${locked ? " is-locked" : ""}`}
        aria-selected={i === cur ? "true" : "false"}
        aria-disabled={locked ? "true" : undefined}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest(".pal-pin")) return;
          e.preventDefault();
          setActive(i);
          runAt(i);
        }}
      >
        <Icon name={it.icon} />
        <span className="pal-label trunc">{it.label}</span>
        <span className="pal-hint mono">{locked && it.guard ? it.guard.needs || "Not permitted" : `${it.group}${it.hint ? ` · ${it.hint}` : ""}`}</span>
        {it.key ? (
          <button
            type="button"
            className={`pal-pin${isPinned ? " is-on" : ""}`}
            tabIndex={-1}
            aria-label={`${isPinned ? "Unpin " : "Pin "}${it.label}`}
            title={isPinned ? "Unpin" : "Pin to top"}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              togglePin(it.key as string);
            }}
          >
            <Icon name="pin" />
          </button>
        ) : null}
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
    } else if (e.altKey && (e.key === "p" || e.key === "P" || e.key === "π")) {
      e.preventDefault();
      const k = shown[cur]?.it.key;
      if (k) togglePin(k);
    }
  };

  return (
    <Dialog
      title="Command palette"
      cls="dlg-palette"
      actions={[]}
      onClose={onClose}
      body={
        <div className="palette">
          <input
            id="palette-input"
            className="palette-input"
            placeholder="Jump to a screen, work order, agent, repo or action…"
            autoComplete="off"
            aria-controls="palette-list"
            aria-label="Command palette"
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
          <ul id="palette-list" className="palette-list" role="listbox" aria-label="Results" ref={listRef}>
            {rows}
          </ul>
        </div>
      }
    />
  );
}
