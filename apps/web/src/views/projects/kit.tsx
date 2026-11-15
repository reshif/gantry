/**
 * Shared pieces of the Projects and Project config screens (legacy shared.js and project-config.js helpers):
 * class chip, gate diamond, mini belt, health chip, a sortable data table and the catalogue query.
 * Same DOM and classes as legacy.
 */
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { flowOf, gateExplain, gateStateText, gateTitle, route as routeOf, routeGates as routeGatesOf, type Bay, type Catalog, type Gate, type Project, type Role, type Station, type WorkClass } from "@gantry/domain";
import { api } from "../../api/client";
import { get } from "../../api/client";
import { Icon } from "../../ui/Icon";
import { Empty } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { setProject as setCurrentProject } from "../../lib/prefs";

/** A project as GET /projects returns it: the legacy shape plus its version and the portfolio numbers computed server-side. */
export interface Metrics {
  wip: number;
  bays: number;
  gates: number;
  oldest: number;
  late: number;
  eff: number | null;
  effN: number;
  cov: { total: number; auto: number; share: number };
  bad: number;
  haltedRepos: number;
  byPosition: Record<string, { n: number; blocked: number }>;
  byClass: Record<string, number>;
  byGate: Record<string, number>;
  slotsUsed: number;
  onboarding: number;
  health: { id: "killed" | "halted" | "attention" | "new" | "onboarding" | "ok" | "archived"; label: string; icon: string; detail?: string };
}
export type PView = Project & { version: number; metrics?: Metrics };

export const EMPTY_METRICS: Metrics = {
  wip: 0, bays: 0, gates: 0, oldest: 0, late: 0, eff: null, effN: 0, cov: { total: 0, auto: 0, share: 0 }, bad: 0, haltedRepos: 0,
  byPosition: {}, byClass: {}, byGate: {}, slotsUsed: 0, onboarding: 0, health: { id: "ok", label: "Healthy", icon: "st-done" },
};
export const metricsOf = (p: PView): Metrics => p.metrics ?? EMPTY_METRICS;

/** The catalogue: built-in plus custom stations, gates, bays, classes, roles and actions. Refetched whenever projects change (a flow edit can append to it). */
export function useCatalog(): Catalog | null {
  const q = useQuery({ queryKey: ["projects", "catalog"], queryFn: () => get<Catalog>(api("catalog")), staleTime: 30_000 });
  return q.data ?? null;
}

export const classOf = (cat: Catalog, p: Project, id: string): WorkClass =>
  p.flow.classes.find((c) => c.id === id) ?? cat.classes.find((c) => c.id === id) ?? ({ id, name: id, skips: [], priority: "P2", slaH: 72, est: "M" } as WorkClass);
export const stationName = (cat: Catalog, id: string): string => cat.stations.find((s) => s.id === id)?.name ?? id;
export const gateLabel = (cat: Catalog, id: string): string => cat.gates.find((g) => g.id === id)?.label ?? id;
export const roleName = (cat: Catalog, id: string): string => cat.roles.find((r) => r.id === id)?.name ?? id;
export const projectRoles = (cat: Catalog): Role[] => cat.roles.filter((r) => r.level === "project");
export { flowOf, routeOf, routeGatesOf };
export type { Bay, Gate, Station, WorkClass };

/** Opens a project's screen: sets the current project, then goes to the route (legacy goProject). */
export function goProject(id: string, to: string): void {
  setCurrentProject(id);
  navigate(to);
}

/* ---------- chips ---------- */

export function ClassChip({ cls, small }: { cls: Pick<WorkClass, "id" | "name"> & Partial<WorkClass>; small?: boolean }) {
  const shape = cls.shape && /^(bar|arrow|wide)$/.test(cls.shape) ? ` cls-shape-${cls.shape}` : "";
  return (
    <span className={`cls cls-${cls.id}${cls.custom && cls.token ? ` ${cls.token}` : ""}${shape}${small ? " cls-sm" : ""}`} title={cls.name}>
      <span className="cls-mark" aria-hidden="true" />
      {cls.name}
    </span>
  );
}

export function HealthChip({ p }: { p: PView }) {
  const hl = metricsOf(p).health;
  return (
    <span className={`hk-health hk-${hl.id}`} title={hl.detail || hl.label}>
      <Icon name={hl.icon} />
      <span>{hl.label}</span>
    </span>
  );
}

/** One gate's state in a project: clear | waiting | failing | off. */
export function gateState(p: PView, gateId: string): { state: "clear" | "waiting" | "failing" | "off"; waiting: number; failing: number } {
  const cfg = p.flow.gates[gateId];
  if (cfg && !cfg.enabled && gateId !== "G0G1") return { state: "off", waiting: 0, failing: 0 };
  const waiting = metricsOf(p).byGate[gateId] ?? 0;
  return { state: waiting ? "waiting" : "clear", waiting, failing: 0 };
}

export function GateDiamond({ cat, gateId, state, count, size, onClick }: { cat: Catalog; gateId: string; state: string; count: number; size?: "sm" | "md"; onClick?: () => void }) {
  const g = cat.gates.find((x) => x.id === gateId);
  if (!g) return null;
  const label = `${gateTitle(g)}: ${gateStateText(state, count)}. ${gateExplain(g)}`;
  const inner = (
    <>
      <span className="gate-shape" aria-hidden="true">
        <span className="gate-count">{state === "waiting" ? String(count) : state === "failing" ? "!" : state === "off" ? "–" : "✓"}</span>
      </span>
      {size === "sm" ? null : <span className="gate-label mono">{g.label}</span>}
    </>
  );
  const cls = `gate gate-${state} gate-${size || "md"} gate-kind-${g.kind}`;
  return onClick ? (
    <button type="button" className={cls} aria-label={label} data-tip={label} onClick={onClick}>
      {inner}
    </button>
  ) : (
    <span className={cls} aria-label={label} data-tip={label}>
      {inner}
    </span>
  );
}

/**
 * Compact belt: one segment per station with WIP heat and blocked markers (legacy G.miniBelt).
 * `counts` are open work orders by station id, from the server; `cls` highlights a route; `stationsOff` and `gatesOff` preview a template.
 */
export function MiniBelt({ cat, project, counts, cls, labels, stationsOff, gatesOff, onStation, flowProject }: {
  cat: Catalog;
  project: PView | Project | null;
  counts?: Record<string, { n: number; blocked: number }>;
  cls?: string;
  labels?: boolean;
  stationsOff?: readonly string[];
  gatesOff?: readonly string[];
  onStation?: (id: string) => void;
  flowProject?: Project;
}) {
  const proj = (flowProject ?? project) as Project | null;
  const stations = flowOf(cat, proj).stations;
  const route = cls ? routeOf(cat, proj, cls) : null;
  const c = counts ?? {};
  const max = Math.max(1, ...stations.map((s) => c[s.id]?.n ?? 0));
  const killed = project && (project as Project).killed;
  const halted = project && (project as Project).halted;
  const aria = `${project ? `${(project as Project).name} flow: ` : "Flow: "}${stations.map((s) => `${s.name} ${c[s.id]?.n ?? 0}`).join(", ")}`;
  const nodes: ReactNode[] = [];
  stations.forEach((s, i) => {
    const off = stationsOff ? stationsOff.includes(s.id) : !!project && !s.enabled;
    const skipped = !!route && !route.includes(s.id);
    const n = c[s.id]?.n ?? 0;
    const blocked = (c[s.id]?.blocked ?? 0) > 0;
    const segCls = `mseg${off ? " is-off" : ""}${!off && !n ? " is-empty" : ""}${skipped ? " is-skipped" : ""}${blocked ? " is-blocked" : ""}${s.custom ? " is-custom" : ""}`;
    const title = `${s.no} ${s.name}${off ? " (off)" : ""}: ${n} WIP${blocked ? ", blocked work" : ""}`;
    const style = { "--heat": (n / max).toFixed(2) } as React.CSSProperties;
    const body = (
      <>
        {labels ? <span className="mseg-l">{s.name}</span> : null}
        {off || n ? <span className="mseg-n mono">{off ? "–" : String(n)}</span> : null}
        {blocked ? <span className="mseg-x" aria-hidden="true" /> : null}
      </>
    );
    nodes.push(
      onStation ? (
        <button key={`s-${s.id}`} type="button" className={segCls} style={style} title={title} onClick={() => onStation(s.id)}>
          {body}
        </button>
      ) : (
        <span key={`s-${s.id}`} className={segCls} style={style} title={title}>
          {body}
        </span>
      ),
    );
    const g = cat.gates.find((x) => x.after === s.id);
    const gcfg = g && proj ? proj.flow.gates[g.id] : null;
    if (g && !gcfg?.absent && (i < stations.length - 1 || g.id === "G6")) {
      const gOff = gatesOff ? gatesOff.includes(g.id) : !!proj && !!gcfg && !gcfg.enabled && g.id !== "G0G1";
      const waiting = project && "metrics" in (project as PView) ? ((project as PView).metrics?.byGate[g.id] ?? 0) : 0;
      const state = gOff ? "off" : waiting ? "waiting" : "clear";
      nodes.push(<span key={`g-${g.id}`} className={`mgate gate-${state}`} title={`${g.name} · ${g.label}` + (gOff ? ": off, skipped" : "") + (waiting ? `: ${waiting} waiting` : "")} />);
    }
  });
  return (
    <div className={`mbelt${labels ? " has-labels" : ""}${killed ? " is-killed" : halted ? " is-halted" : ""}`} role="img" aria-label={aria}>
      {nodes}
    </div>
  );
}

/* ---------- table ---------- */

export interface Col<R> {
  key: string;
  label: string;
  render?: (row: R) => ReactNode;
  align?: "end";
  hideSmall?: boolean;
}

/** Responsive table (legacy G.dataTable without sorting; the portfolio sorts before rendering). */
export function DataTable<R>({ id, caption, columns, rows, rowKey, empty }: { id?: string; caption?: string; columns: Col<R>[]; rows: R[]; rowKey: (r: R) => string; empty?: { title: string; text?: string } }) {
  if (!rows.length) return <Empty title={empty?.title ?? "Nothing here"} text={empty?.text ?? "No rows match."} />;
  return (
    <div className="dtable-wrap" id={id}>
      <table className="dtable">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`${c.align === "end" ? "is-end" : ""}${c.hideSmall ? " hide-sm" : ""}`.trim() || undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} data-key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.key} data-label={c.label} className={`${c.align === "end" ? "is-end" : ""}${c.hideSmall ? " hide-sm" : ""}`.trim() || undefined}>
                  {c.render ? c.render(r) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState({ id, icon, title, text, action }: { id?: string; icon?: string; title: ReactNode; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty empty-state" id={id}>
      {icon ? (
        <div className="empty-icon" aria-hidden="true">
          <Icon name={icon} />
        </div>
      ) : null}
      <div className="empty-title">{title}</div>
      {text ? <p>{text}</p> : null}
      {action ?? null}
    </div>
  );
}

/** Crumbs above the page title (legacy pageHeader crumbs). */
export function Crumbs({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((c, i) => (
        <span key={i} style={{ display: "contents" }}>
          {i ? (
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
          ) : null}
          {c.href ? <a href={c.href}>{c.label}</a> : <span>{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}

/** A result toast: the op's message, or `label` when it worked (legacy `res`). */
export function useRes(): <T extends { ok: boolean; msg: string; needs?: string }>(r: T, label?: string) => T {
  const ui = useUI();
  return (r, label) => {
    ui.toast(r.ok && label ? label : r.msg, r.ok ? "ok" : "error");
    return r;
  };
}

export const focusLater = (id: string): void => {
  setTimeout(() => document.getElementById(id)?.focus(), 40);
};

/** Number input that commits on change (legacy numInput). */
export function NumInput({ id, value, min, max, onCommit, locked, label }: { id: string; value: number; min: number; max: number; onCommit: (v: number) => void; locked?: boolean; label?: string }) {
  const ui = useUI();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      id={id}
      className="input pcf-num mono"
      min={min}
      max={max}
      value={draft ?? String(value)}
      disabled={!!locked}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        const v = parseInt(draft, 10);
        setDraft(null);
        if (Number.isNaN(v) || v < min || v > max) {
          ui.toast(`Enter a number from ${min} to ${max}.`, "error");
          return;
        }
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export interface TeamRow {
  id: string;
  name: string;
  desc?: string;
}
/** GET /api/v1/teams (the web has no teams hook of its own). */
export function useTeams(): TeamRow[] {
  const q = useQuery({ queryKey: ["teams"], queryFn: () => get<TeamRow[]>(api("teams")), staleTime: 30_000 });
  return q.data ?? [];
}

import { NOTIFY_EVENTS } from "@gantry/domain";
export const evName = (id: string): string => NOTIFY_EVENTS.find((e) => e.id === id)?.name ?? id;

import { Toggle, type Decision } from "../../ui/primitives";

/** Class route matrix: classes down, stations across, a tick where the class travels (legacy routeMatrix). */
export function RouteMatrix({ cat, project, classes, stationsOff, decision, selected, idp = "pcf-rm", onToggle, onSelect, onEnable }: {
  cat: Catalog;
  project: Project;
  classes: WorkClass[];
  stationsOff?: readonly string[];
  decision?: Decision | null;
  selected?: string;
  idp?: string;
  onToggle: (clsId: string, stationId: string, travels: boolean) => void;
  onSelect?: (clsId: string) => void;
  onEnable?: (clsId: string, on: boolean) => void;
}) {
  const locked = !!decision && !decision.allowed;
  const sts = flowOf(cat, project).stations;
  return (
    <div className="table-scroll pcf-rm-wrap" data-keep-scroll={`${idp}-scroll`}>
      <table className="table table-compact pcf-rm">
        <thead>
          <tr>
            <th scope="col">Class</th>
            {onEnable ? <th scope="col">On</th> : null}
            {sts.map((s) => (
              <th key={s.id} scope="col" className={`pcf-rm-st${s.custom ? " is-custom" : ""}`} title={s.name}>
                <span className="mono">{s.no}</span>
                <span className="pcf-rm-sn">{s.name.split(" ")[0]}</span>
              </th>
            ))}
            <th scope="col" className="num">Stops</th>
          </tr>
        </thead>
        <tbody>
          {classes.map((c) => {
            let endIdx = c.endsAfter ? sts.findIndex((x) => x.id === c.endsAfter) : 99;
            if (endIdx < 0) endIdx = 99;
            let stops = 0;
            const cells = sts.map((s, i) => {
              const off = (stationsOff ?? []).includes(s.id);
              const travels = !c.skips.includes(s.id) && i <= endIdx;
              if (travels && !off) stops++;
              const why = s.id === "intake" ? "Every class starts at Intake." : i > endIdx ? `${c.name} ends after ${stationName(cat, c.endsAfter ?? "")}.` : s.id === "close" ? "Every class ends at Close." : off ? `${s.name} is off for the whole project.` : null;
              const id = `${idp}-${c.id}-${s.id}`;
              return (
                <td key={s.id} className={`pcf-rm-cell${travels && !off ? " is-on" : ""}${why ? " is-fixed" : ""}`} data-tip={why ?? undefined}>
                  <input type="checkbox" id={id} checked={travels && !off} disabled={locked || !!why} aria-label={`${c.name} travels ${s.name}`} onChange={(e) => onToggle(c.id, s.id, e.target.checked)} />
                </td>
              );
            });
            return (
              <tr key={c.id} className={`${selected === c.id ? "is-selected" : ""}${c.enabled === false ? " is-disabled" : ""}`.trim() || undefined}>
                <th scope="row" className="pcf-rm-cls">
                  {onSelect ? (
                    <button type="button" className={`linkish pcf-rm-pick${selected === c.id ? " is-sel" : ""}`} id={`${idp}-pick-${c.id}`} aria-pressed={selected === c.id ? "true" : "false"} onClick={() => onSelect(c.id)}>
                      <ClassChip cls={c} small />
                    </button>
                  ) : (
                    <ClassChip cls={c} small />
                  )}
                </th>
                {onEnable ? (
                  <td>
                    <Toggle id={`${idp}-en-${c.id}`} checked={c.enabled !== false} onChange={(v) => onEnable(c.id, v)} decision={decision ?? null} label={`${c.name} enabled`} />
                  </td>
                ) : null}
                {cells}
                <td className="num mono">{String(stops)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
