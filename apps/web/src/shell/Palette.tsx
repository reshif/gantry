/** Command palette (legacy openPalette): views, projects, work orders, repos, agents and actions; pins and recents. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAgents, useMe, useRepos, useWorkOrders } from "../api/queries";
import { useCanMany } from "../api/can";
import { ops } from "../api/ops";
import { canSeeRoute, ROUTES } from "../lib/routes";
import { hasCommand, runCommand } from "../lib/commands";
import { navigate, navigateProject, openRecordRoute } from "../lib/router";
import { setProject, updatePrefs, usePrefs } from "../lib/prefs";
import { Dialog } from "../ui/Overlay";
import { Icon } from "../ui/Icon";
import type { Decision } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { useRouteCtx } from "./Nav";
import { makeStopActions } from "./stopActions";
import { useOpenTraveler } from "./useTraveler";

interface Item {
  key?: string;
  kind: string;
  label: string;
  hint: string;
  guard?: Decision | undefined;
  run: () => void;
}
interface Row {
  it: Item;
  sec: string | null;
}

export function usePaletteItems(projectId: string | null): Item[] {
  const me = useMe();
  const ui = useUI();
  const ctx = useRouteCtx();
  const openTraveler = useOpenTraveler();
  const wos = useWorkOrders(projectId, { limit: 50 }).data;
  const repos = useRepos(projectId).data;
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
    for (const r of ROUTES) if (r.nav !== false && canSeeRoute(r.id, me, ctx)) items.push({ key: r.id, kind: "View", label: r.title, hint: r.project ? (cp?.name ?? "project") : "factory", run: () => r.project && cp ? navigateProject(cp.id, r.id) : navigate(r.id) });
    for (const p of me.projects) items.push({ key: `project:${p.id}`, kind: "Project", label: p.name, hint: `enter ${p.key}`, run: () => { setProject(p.id); navigateProject(p.id); } });
    const woList = Array.isArray(wos) ? wos : (wos?.items ?? []);
    for (const w of woList) {
      items.push({ key: `wo:${w.id}`, kind: "Work order", label: `${w.id} ${w.title}`, hint: `${w.repo} · ${w.state}`, run: () => openTraveler(w.id) });
      items.push({ key: `record:${w.id}`, kind: "Record", label: `${w.id} full record`, hint: w.title, run: () => { setProject(w.project); openRecordRoute(w.id); } });
    }
    for (const r of repos ?? []) items.push({ key: `repo:${r.id}`, kind: "Repo", label: r.name, hint: `${cp?.name ?? ""} · ${r.onboarding.stage}`, run: () => { if (cp) setProject(cp.id); navigate("onboarding"); } });
    if (canAgents) for (const a of agents ?? []) items.push({ key: `agent:${a.id}`, kind: "Agent", label: a.name, hint: a.model, run: () => { updatePrefs({ agent: a.id }); navigate("agents"); } });
    if (hasCommand("newWorkOrder")) items.push({ kind: "Action", label: "Submit a work order", hint: "Intake", guard: guard(3), run: () => void runCommand("newWorkOrder") });
    if (cp) {
      items.push({ kind: "Action", label: `${cp.halted ? "Resume " : "Halt "}${cp.name}`, hint: "andon", guard: guard(0), run: () => (cp.halted ? void stop.resume(cp.id) : stop.halt(cp.id)) });
      // Kill and restore are offered only to people who hold the right (resolved by the server); the dialogs ask for the reason and step-up.
      if (allowedNow(1)) items.push({ kind: "Action", label: `${cp.killed ? "Restore" : "Kill"} ${cp.name}…`, hint: "kill switch", guard: guard(1), run: () => (cp.killed ? stop.restore("project", cp.id) : stop.kill("project", cp.id)) });
    }
    if (allowedNow(2)) items.push({ kind: "Action", label: factoryKilled ? "Restore factory…" : "Kill factory…", hint: "kill switch", guard: guard(2), run: () => (factoryKilled ? stop.restore("factory", null) : stop.kill("factory", null)) });
    items.push({ kind: "Action", label: "Sign out", hint: me.person.name, run: () => void ops.signOut() });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, wos, repos, agents, canAgents, cp, factoryKilled, ctx.canAudit, checks.map((c) => c.pending + ":" + c.allowed).join("|")]);
}

export function PaletteDialog({ projectId, onClose }: { projectId: string | null; onClose: () => void }) {
  const ui = useUI();
  const prefs = usePrefs();
  const all = usePaletteItems(projectId);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const byKey = useMemo(() => {
    const m: Record<string, Item> = {};
    for (const it of all) if (it.key) m[it.key] = it;
    return m;
  }, [all]);

  const shown: Row[] = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) {
      const pinned = prefs.palettePinned.map((k) => byKey[k]).filter((x): x is Item => !!x);
      const recent = prefs.paletteRecent.filter((k) => !prefs.palettePinned.includes(k)).map((k) => byKey[k]).filter((x): x is Item => !!x).slice(0, 5);
      const rest = all.filter((it) => (it.kind === "View" || it.kind === "Action") && !pinned.includes(it) && !recent.includes(it));
      return [...pinned.map((it) => ({ it, sec: "Pinned" })), ...recent.map((it) => ({ it, sec: "Recent" })), ...rest.map((it) => ({ it, sec: "All" }))].slice(0, 48);
    }
    return all
      .filter((it) => {
        const hay = `${it.kind} ${it.label} ${it.hint}`.toLowerCase();
        return needle.split(/\s+/).every((w) => hay.includes(w));
      })
      .slice(0, 40)
      .map((it) => ({ it, sec: null }));
  }, [q, all, byKey, prefs.palettePinned, prefs.paletteRecent]);

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
  if (!shown.length) rows.push(<li key="empty" className="palette-empty" role="presentation">No match. Try a WO id like WO-2417 or a repo name.</li>);
  let lastSec: string | null = null;
  shown.forEach((row, i) => {
    const it = row.it;
    if (row.sec && row.sec !== lastSec && !(row.sec === "All" && lastSec === null)) rows.push(<li key={`sec-${row.sec}-${i}`} className="palette-sec" role="presentation">{row.sec}</li>);
    lastSec = row.sec;
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
        <span className="pal-kind">{it.kind}</span>
        <span className="pal-label">{it.label}</span>
        <span className="pal-hint mono">{locked && it.guard ? it.guard.needs || "Not permitted" : it.hint}</span>
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
      kicker="Ctrl/Cmd K · Alt+P pins the highlighted item"
      cls="dlg-palette"
      onClose={onClose}
      body={
        <div className="palette">
          <input
            id="palette-input"
            className="palette-input"
            placeholder="Type a view, project, WO id, repo, agent or action"
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
          <ul id="palette-list" className="palette-list" role="listbox" aria-label="Results" ref={listRef}>
            {rows}
          </ul>
        </div>
      }
      actions={[{ label: "Close" }]}
    />
  );
}
