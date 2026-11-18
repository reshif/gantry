/** Board and list views of the floor, with the shared filter bar (legacy floor.js board, list and filterBar). */
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { WO_STATES, classesOf, flowOf, fmt, gateTitle } from "@gantry/domain";
import { Avatar, Btn, Field, Select } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { updatePrefs, usePrefs } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { ClassChip, classOf } from "../projects/kit";
import { assigneeOf, gateText, isLive, projectOf, repoName, since, stationIdx, useFloorCtx, type FWo } from "./kit";
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

/** Names of the board columns cut off on each side of the scroll area, so the board can say what is out of view. */
function useOffscreenCols(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [off, setOff] = useState<{ left: string[]; right: string[] }>({ left: [], right: [] });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      const left: string[] = [];
      const right: string[] = [];
      el.querySelectorAll<HTMLElement>(".fl-lane:first-child .fl-lane-cols > .fl-col").forEach((c) => {
        const r = c.getBoundingClientRect();
        const name = c.querySelector(".fl-col-name")?.textContent ?? "";
        if (!name || !r.width) return;
        if (r.right > box.right + 2 && r.left + r.width / 2 > box.right) right.push(name);
        else if (r.left < box.left - 2 && r.right - r.width / 2 < box.left) left.push(name);
      });
      setOff((o) => (o.left.join() === left.join() && o.right.join() === right.join() ? o : { left, right }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return off;
}

/** The nearest hidden column by name, then a count: "Verify and 7 more". The full list is in the tooltip. */
const namesText = (n: string[], nearest: string) => (n.length === 1 ? nearest : `${nearest} and ${n.length - 1} more`);

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
        <ClassChip cls={classOf(ctx.cat, projectOf(ctx, w), w.cls)} small />
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const off = useOffscreenCols(scrollRef, [collapsed, swim, p.id, list.length]);
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
            <span className="fl-col-gate" title={gateTitle(g)}>
              <Icon name="diamond" />
              {g.name}
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
  const scrollBoard = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * Math.max(196, el.clientWidth - 196), behavior: "smooth" });
  };
  return (
    <div className="fl-boardwrap">
      <FilterBar withSwim />
      <div className="fl-board-tools">
        <p className="muted small">{ctx.replay ? `Board as it was at ${fmt.stamp(ctx.replay.at)}. Moves are locked in replay. ${list.length} work orders shown.` : `Drag a card by its grip or body, or use its Move button. Refused moves say why. ${list.length} work orders shown.`}</p>
        <div className="fl-board-nav">
          {off.left.length ? (
            <button type="button" className="fl-more fl-more-l" id="floor-more-left" onClick={() => scrollBoard(-1)} aria-label={`Scroll back to ${off.left.join(", ")}`} title={off.left.join(", ")}>
              <Icon name="back" />
              <span>{namesText(off.left, off.left[off.left.length - 1]!)}</span>
            </button>
          ) : null}
          {off.right.length ? (
            <button type="button" className="fl-more fl-more-r" id="floor-more-right" onClick={() => scrollBoard(1)} aria-label={`Scroll on to ${off.right.join(", ")}`} title={off.right.join(", ")}>
              <span>{namesText(off.right, off.right[0]!)}</span>
              <Icon name="chevron" />
            </button>
          ) : null}
        <button type="button" className="btn btn-ghost btn-sm" id="floor-bays-toggle" aria-expanded={collapsed ? "false" : "true"} onClick={() => updatePrefs((x) => ({ collapsedBays: !x.collapsedBays }))}>
          <Icon name={collapsed ? "chevron" : "back"} />
          <span>{collapsed ? "Show bays" : "Collapse bays"}</span>
        </button>
        </div>
      </div>
      <div className={`fl-board-frame${off.left.length ? " more-l" : ""}${off.right.length ? " more-r" : ""}`}>
      <div className="fl-board-scroll" data-keep-scroll="floor-board" ref={scrollRef}>
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
    </div>
  );
}
