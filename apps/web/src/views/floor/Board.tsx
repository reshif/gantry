/** Board and list views of the floor, with the shared filter bar (legacy floor.js board, list and filterBar). */
import { useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { WO_STATES, bayDef, classesOf, flowOf, fmt, woTotals } from "@gantry/domain";
import { Avatar, Btn, Empty, Field, Select, StateChip } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { updatePrefs, usePrefs } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { ClassChip, classOf } from "../projects/kit";
import { assigneeOf, gateText, isLive, repoName, since, stationIdx, useFloorCtx, type FWo } from "./kit";
import { useMoves, checkMove } from "./moves";

/* ---------- filters ---------- */

function useFilters() {
  const f = usePrefs().boardFilters;
  return { cls: f.cls || "all", repo: f.repo || "all", assignee: f.assignee || "all", prio: f.prio || "all" };
}

export function useApplyFilters(): (list: FWo[]) => FWo[] {
  const f = useFilters();
  return (list) => list.filter((w) => (f.cls === "all" || w.cls === f.cls) && (f.repo === "all" || w.repo === f.repo) && (f.prio === "all" || w.priority === f.prio) && (f.assignee === "all" || assigneeOf(w) === f.assignee));
}

export function FilterBar({ withSwim }: { withSwim?: boolean }) {
  const ctx = useFloorCtx();
  const prefs = usePrefs();
  const actor = useActors();
  const f = useFilters();
  const set = (k: "cls" | "repo" | "assignee" | "prio") => (v: string) => updatePrefs((p) => ({ boardFilters: { ...p.boardFilters, [k]: v } }));
  const agents: string[] = [];
  for (const w of ctx.wos) {
    const a = assigneeOf(w);
    if (a && !agents.includes(a)) agents.push(a);
  }
  const any = f.cls !== "all" || f.repo !== "all" || f.prio !== "all" || f.assignee !== "all";
  return (
    <div className="toolbar fl-toolbar">
      <div className="filters">
        <Field label="Class" htmlFor="floor-f-cls">
          <Select id="floor-f-cls" options={[{ value: "all", label: "All classes" }, ...classesOf(ctx.cat, ctx.project).map((c) => ({ value: c.id, label: c.name }))]} value={f.cls} onChange={set("cls")} />
        </Field>
        <Field label="Repo" htmlFor="floor-f-repo">
          <Select id="floor-f-repo" options={[{ value: "all", label: "All repos" }, ...ctx.repos.map((r) => ({ value: r.id, label: r.name }))]} value={f.repo} onChange={set("repo")} />
        </Field>
        <Field label="Assignee" htmlFor="floor-f-assignee">
          <Select id="floor-f-assignee" options={[{ value: "all", label: "Anyone" }, ...agents.map((a) => ({ value: a, label: actor(a).name.replace(" (agent)", "") }))]} value={f.assignee} onChange={set("assignee")} />
        </Field>
        <Field label="Priority" htmlFor="floor-f-prio">
          <Select id="floor-f-prio" options={["all", "P1", "P2", "P3"].map((x) => ({ value: x, label: x === "all" ? "Any priority" : x }))} value={f.prio} onChange={set("prio")} />
        </Field>
        {withSwim ? (
          <Field label="Swimlanes" htmlFor="floor-f-swim">
            <Select id="floor-f-swim" options={[{ value: "none", label: "None" }, { value: "repo", label: "By repo" }, { value: "class", label: "By class" }]} value={prefs.boardSwim || "none"} onChange={(v) => updatePrefs({ boardSwim: v })} />
          </Field>
        ) : null}
        {any ? <Btn label="Clear filters" small kind="ghost" icon="x" id="floor-f-clear" onClick={() => updatePrefs({ boardFilters: { cls: "all", repo: "all", assignee: "all", prio: "all" } })} /> : null}
      </div>
    </div>
  );
}

/* ---------- board ---------- */

function Card({ w, onGrip }: { w: FWo; onGrip: (e: RPointerEvent<HTMLElement>, w: FWo) => void }) {
  const ctx = useFloorCtx();
  const actor = useActors();
  const open = useOpenTraveler();
  const moves = useMoves();
  const gt = gateText(ctx, w);
  const agent = assigneeOf(w);
  const def = (WO_STATES as Record<string, { glyph: string }>)[w.state] ?? { glyph: "dots" };
  const lock = ctx.replay ? "Replay is showing the past. Go back to live to act." : null;
  return (
    <article className={`fl-card fl-card-${w.state}${w.heldByKill ? " is-held" : ""}`} data-wo={w.id} aria-label={`${w.id} ${w.title}`} onPointerDown={(e) => onGrip(e, w)}>
      <div className="fl-card-top">
        <span className="fl-grip" aria-hidden="true" title="Drag to move">
          <Icon name="grip" />
        </span>
        <Icon name={def.glyph} className="fl-card-glyph" />
        <span className="mono fl-card-id">{w.id}</span>
        <span className={`chip fl-prio prio-${w.priority}`}>{w.priority}</span>
        <button
          type="button"
          className={`icon-btn icon-btn-sm fl-card-move${lock ? " is-locked" : ""}`}
          id={`floor-move-${w.id}`}
          aria-label={`Move ${w.id} to another station or bay`}
          aria-haspopup="menu"
          aria-disabled={lock ? "true" : undefined}
          data-reason={lock ?? undefined}
          data-tip={lock ? undefined : "Move to"}
          onClick={(e) => {
            if (lock) return;
            void moves.menu(e.currentTarget, w);
          }}
        >
          <Icon name="move" />
        </button>
      </div>
      <button type="button" className="fl-card-title" id={`floor-card-${w.id}`} onClick={() => open(w.id)}>
        {w.title}
      </button>
      <div className="fl-card-meta">
        <ClassChip cls={classOf(ctx.cat, ctx.project, w.cls)} small />
        <span className="mono fl-card-repo">{repoName(ctx.repos, w.repo)}</span>
      </div>
      <div className="fl-card-foot">
        {agent ? (
          <span className="fl-card-agent">
            <Avatar id={agent} size="xs" />
            {actor(agent).name.replace(" (agent)", "")}
          </span>
        ) : (
          <span className="muted">{w.state === "killed" ? "stopped" : "no agent"}</span>
        )}
        <span className="mono muted">{w.state === "killed" ? "killed" : fmt.dur(Math.max(0, ctx.now - since(w)))}</span>
        <span className={`fl-gt fl-gt-${gt.c}`}>{gt.t}</span>
      </div>
    </article>
  );
}

interface Drag {
  wo: string;
  x: number;
  y: number;
  el: HTMLElement;
  started: boolean;
  over: string | null;
  ghost?: HTMLElement;
  dx?: number;
  dy?: number;
  seq: number;
  check?: Awaited<ReturnType<typeof checkMove>> | undefined;
}

export function Board() {
  const ctx = useFloorCtx();
  const prefs = usePrefs();
  const moves = useMoves();
  const drag = useRef<Drag | null>(null);
  const [, bump] = useState(0);
  const { cat, project: p, wos } = ctx;
  const applyFilters = useApplyFilters();
  const list = applyFilters(wos.filter((w) => w.state !== "done"));
  const swim = prefs.boardSwim || "none";
  const collapsed = !!prefs.collapsedBays;
  const fl = flowOf(cat, p);
  const lanes: Array<{ id: string; label: string | null; items: FWo[] }> =
    swim === "repo" ? ctx.repos.map((r) => ({ id: r.id, label: r.name, items: list.filter((w) => w.repo === r.id) }))
    : swim === "class" ? fl.classes.map((c) => ({ id: c.id, label: c.name, items: list.filter((w) => w.cls === c.id) })).filter((l) => l.items.length)
    : [{ id: "all", label: null, items: list }];
  const shipped7 = wos.filter((w) => w.state === "done" && !w.split && (w.doneAt ?? 0) > ctx.now - 7 * 86_400_000).length;
  const allLive = wos.filter((w) => isLive(w) && !w.bay);
  const bayCount = wos.filter((w) => w.bay && w.state !== "killed").length;
  const first = lanes[0]?.id;

  const clearOver = () => {
    document.querySelectorAll(".fl-col.is-over").forEach((x) => {
      x.classList.remove("is-over", "is-ok", "is-no");
      const hint = x.querySelector(".fl-col-why");
      if (hint) hint.textContent = "";
    });
  };
  const onMove = (ev: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.started) {
      if (Math.abs(ev.clientX - d.x) + Math.abs(ev.clientY - d.y) < 6) return;
      d.started = true;
      const r = d.el.getBoundingClientRect();
      d.dx = d.x - r.left;
      d.dy = d.y - r.top;
      const g = d.el.cloneNode(true) as HTMLElement;
      g.removeAttribute("id");
      g.querySelectorAll("[id]").forEach((x) => x.removeAttribute("id"));
      g.classList.add("fl-ghost");
      g.style.width = `${r.width}px`;
      g.setAttribute("aria-hidden", "true");
      document.body.appendChild(g);
      d.ghost = g;
      d.el.classList.add("is-dragging");
      document.body.classList.add("fl-dragging");
    }
    ev.preventDefault();
    if (d.ghost) d.ghost.style.transform = `translate(${ev.clientX - (d.dx ?? 0)}px,${ev.clientY - (d.dy ?? 0)}px)`;
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const col = under?.closest("[data-drop]") ?? null;
    const target = col ? col.getAttribute("data-drop") : null;
    if (target !== d.over) {
      clearOver();
      d.over = target;
      d.check = undefined;
      const seq = ++d.seq;
      if (col && target) {
        col.classList.add("is-over");
        const hint = col.querySelector(".fl-col-why");
        if (hint) hint.textContent = "Checking…";
        void checkMove(d.wo, target).then((c) => {
          if (drag.current !== d || d.seq !== seq) return;
          d.check = c;
          col.classList.add(c.allowed ? "is-ok" : "is-no");
          if (hint) hint.textContent = c.allowed ? c.reason : `Refused: ${c.reason}`;
        });
      }
    }
  };
  const finish = () => {
    const d = drag.current;
    drag.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    d?.ghost?.remove();
    document.body.classList.remove("fl-dragging");
    clearOver();
    d?.el.classList.remove("is-dragging");
    return d;
  };
  const onUp = () => {
    const d = finish();
    if (d?.started && d.over) {
      const w = wos.find((x) => x.id === d.wo);
      const cur = w ? (w.bay ?? cat.stations[w.station]?.id) : null;
      if (w && d.over !== cur) void moves.perform(d.wo, d.over, d.check);
    }
    bump((n) => n + 1);
  };
  const onCancel = () => {
    finish();
    bump((n) => n + 1);
  };
  const onGrip = (ev: RPointerEvent<HTMLElement>, w: FWo) => {
    if (ev.button !== 0 || ctx.replay) return;
    const t = ev.target as HTMLElement;
    if (t.closest("button") && !t.closest(".fl-grip")) return;
    if (w.state === "killed" || w.state === "done") return;
    drag.current = { wo: w.id, x: ev.clientX, y: ev.clientY, el: ev.currentTarget, started: false, over: null, seq: 0 };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  type Col = { id: string; station?: ReturnType<typeof flowOf>["stations"][number]; bay?: ReturnType<typeof flowOf>["bays"][number] };
  const cols: Col[] = fl.stations.map((s) => ({ id: s.id, station: s }));
  const bayCols: Col[] = fl.bays.map((b) => ({ id: b.id, bay: b }));

  const colHead = (c: Col): ReactNode => {
    if (c.station) {
      const conf = p.flow.stations[c.id];
      const n = allLive.filter((w) => w.station === stationIdx(cat, c.id)).length;
      const over = !!conf?.enabled && n > (conf?.wip ?? 0);
      const g = cat.gates.find((x) => x.after === c.id);
      const gcfg = g ? p.flow.gates[g.id] : undefined;
      return (
        <div className={`fl-col-h${over ? " is-over" : ""}`}>
          <span className="mono fl-st-no">{c.station.no}</span>
          <span className="fl-col-name">{c.station.name}</span>
          <span className={`mono fl-wip${over ? " is-over" : ""}`} title={over ? `Over the WIP limit of ${conf?.wip}` : `WIP limit ${conf?.wip}`}>{conf?.enabled ? `${n}/${conf.wip}` : "off"}</span>
          {over ? (
            <span className="fl-over-l">
              <Icon name="alert" />
              over limit
            </span>
          ) : null}
          {g && gcfg && !gcfg.absent && (gcfg.enabled || g.id === "G0G1") ? (
            <span className="fl-col-gate mono" title={g.name}>
              <Icon name="diamond" />
              {g.label}
            </span>
          ) : null}
        </div>
      );
    }
    return (
      <div className="fl-col-h is-bay">
        <span className="fl-col-name">{c.bay?.name}</span>
        <span className="mono fl-wip">{String(wos.filter((w) => w.bay === c.id && w.state !== "killed").length)}</span>
      </div>
    );
  };
  const column = (c: Col, items: FWo[], laneId: string): ReactNode => {
    const here = c.station ? items.filter((w) => !w.bay && w.station === stationIdx(cat, c.id)) : items.filter((w) => w.bay === c.id && w.state !== "killed");
    const conf = c.station ? p.flow.stations[c.id] : undefined;
    const overLimit = !!conf?.enabled && allLive.filter((w) => w.station === stationIdx(cat, c.id)).length > conf.wip;
    return (
      <div key={c.id} className={`fl-col${c.bay ? " is-bay" : ""}${conf && !conf.enabled ? " is-off" : ""}${overLimit ? " is-over-limit" : ""}`} data-drop={c.id} role="group" aria-label={`${c.station ? c.station.name : c.bay?.name}${laneId !== "all" ? ` in lane ${laneId}` : ""}: ${here.length}`}>
        {laneId === first ? colHead(c) : null}
        <div className="fl-col-why" aria-live="polite" />
        <div className="fl-col-cards">
          {here.map((w) => (
            <Card key={w.id} w={w} onGrip={onGrip} />
          ))}
          {c.id === "close" && laneId === first ? (
            <p className="fl-col-note">
              <Icon name="st-done" />
              {` ${shipped7} shipped in 7 days`}
            </p>
          ) : null}
          {!here.length && conf && !conf.enabled ? <p className="fl-col-note">Off in this project</p> : null}
        </div>
      </div>
    );
  };
  return (
    <div className="fl-boardwrap">
      <FilterBar withSwim />
      <div className="fl-board-tools">
        <p className="muted small">{ctx.replay ? `Board as it was at ${fmt.stamp(ctx.replay.at)}. Moves are locked in replay. ${list.length} work orders shown.` : `Drag a card by its grip or body, or use its Move button. Refused moves say why. ${list.length} work orders shown.`}</p>
        <button type="button" className="btn btn-ghost btn-sm" id="floor-bays-toggle" aria-expanded={collapsed ? "false" : "true"} onClick={() => updatePrefs((x) => ({ collapsedBays: !x.collapsedBays }))}>
          <Icon name={collapsed ? "chevron" : "back"} />
          <span>{collapsed ? "Show bays" : "Collapse bays"}</span>
        </button>
      </div>
      <div className="fl-board-scroll" data-keep-scroll="floor-board">
        <div className={`fl-board${collapsed ? " bays-collapsed" : ""}`} style={{ "--cols": cols.length + (collapsed ? 0 : bayCols.length) } as React.CSSProperties}>
          {lanes.map((lane) => (
            <div key={lane.id} className="fl-lane">
              {lane.label ? (
                <div className="fl-lane-h">
                  <span className="mono">{lane.label}</span>
                  <span className="muted small">{`${lane.items.length} work orders`}</span>
                </div>
              ) : null}
              <div className="fl-lane-cols" style={collapsed ? { gridTemplateColumns: `repeat(${cols.length}, 196px) 84px` } : undefined}>
                {cols.map((c) => column(c, lane.items, lane.id))}
                {collapsed ? (
                  lane.id === first ? (
                    <div className="fl-col fl-col-collapsed">
                      <div className="fl-col-h is-bay">
                        <span className="fl-col-name">Bays</span>
                        <span className="mono fl-wip">{String(bayCount)}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="fl-col fl-col-collapsed" />
                  )
                ) : (
                  bayCols.map((c) => column(c, lane.items, lane.id))
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- list ---------- */

type SortKey = "id" | "title" | "cls" | "repo" | "where" | "state" | "prio" | "age" | "cost";

export function ListView() {
  const ctx = useFloorCtx();
  const open = useOpenTraveler();
  const actor = useActors();
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "where", dir: 1 });
  const { cat, project: p } = ctx;
  const applyFilters = useApplyFilters();
  const rows = applyFilters(ctx.wos).slice();
  const fl = flowOf(cat, p);
  const bayIds = fl.bays.map((b) => b.id);
  const order = fl.stations.map((x) => x.id);
  const key = (w: FWo): string | number =>
    ({
      id: w.id, title: w.title.toLowerCase(), cls: w.cls, repo: w.repo,
      where: w.state === "done" ? 1000 : w.bay ? 500 + bayIds.indexOf(w.bay) : order.indexOf(cat.stations[w.station]?.id ?? ""),
      state: w.state, prio: w.priority, age: since(w), cost: woTotals(w).cost,
    })[sort.k];
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
  });
  const th = (k: SortKey, label: string, num?: boolean) => {
    const on = sort.k === k;
    return (
      <th className={num ? "num" : undefined} aria-sort={on ? (sort.dir > 0 ? "ascending" : "descending") : "none"} scope="col">
        <button type="button" className="th-sort" id={`floor-sort-${k}`} onClick={() => setSort({ k, dir: on ? (sort.dir === 1 ? -1 : 1) : 1 })}>
          {label}
          {on ? <Icon name={sort.dir > 0 ? "up" : "down"} /> : null}
        </button>
      </th>
    );
  };
  const whereText = (w: FWo) => (w.bay ? (bayDef(cat, w.bay)?.name ?? w.bay) : `${cat.stations[w.station]?.no ?? ""} ${cat.stations[w.station]?.name ?? ""}`);
  return (
    <div className="fl-listwrap">
      <FilterBar />
      <div className="table-scroll" data-keep-scroll="floor-list">
        <table className="table table-compact fl-table">
          <caption className="sr">{`Work orders in ${p.name}`}</caption>
          <thead>
            <tr>
              {th("id", "ID")}
              {th("title", "Title")}
              {th("cls", "Class")}
              {th("repo", "Repo")}
              {th("where", "Station or bay")}
              {th("state", "State")}
              <th scope="col">Gate</th>
              <th scope="col">Agent</th>
              {th("prio", "Priority")}
              {th("age", "Here for", true)}
              {th("cost", "Cost", true)}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((w) => {
                const gt = gateText(ctx, w);
                const ag = assigneeOf(w);
                return (
                  <tr key={w.id} className={`fl-tr-${w.state}`}>
                    <td>
                      <button type="button" className="linkish mono" id={`floor-row-${w.id}`} onClick={() => open(w.id)}>
                        {w.id}
                      </button>
                    </td>
                    <td className="fl-td-title">{w.title}</td>
                    <td>
                      <ClassChip cls={classOf(cat, p, w.cls)} small />
                    </td>
                    <td className="mono small">{repoName(ctx.repos, w.repo)}</td>
                    <td>{whereText(w)}</td>
                    <td>
                      <StateChip state={w.state} />
                    </td>
                    <td>{w.state === "done" ? <span className="muted">{w.split ? "split" : "shipped"}</span> : <span className={`fl-gt fl-gt-${gt.c}`}>{gt.t}</span>}</td>
                    <td className="small">{ag ? actor(ag).name.replace(" (agent)", "") : "none"}</td>
                    <td className="mono">{w.priority}</td>
                    <td className="num mono">{w.state === "done" ? "done" : fmt.dur(Math.max(0, ctx.now - since(w)))}</td>
                    <td className="num mono">{fmt.money(woTotals(w).cost)}</td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={11}>
                  <Empty title="No work orders match" text={`Clear the filters to see everything in ${p.name}.`} />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

