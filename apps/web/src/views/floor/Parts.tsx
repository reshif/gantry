/**
 * The Parts list (the sheet's bill of materials): every work order on the floor as a numbered part, grouped by what it needs, or flat by wait
 * or by last change. It is hidden until the Floor header's "Parts list" button opens it (URL `parts=open`, sort `psort`), so the line drawing
 * normally has the full width. A row opens the same work-order drawer a balloon does.
 */
import { useMemo } from "react";
import { Btn, IconBtn, Panel } from "../../ui/primitives";
import { classOf } from "../projects/kit";
import { bayName, gateHaveNeed, useFloorCtx } from "./kit";
import { dur, revWord, type Bal, type FloorModel } from "./model";
import type { LineHandlers } from "./Line";

export type PartsSort = "group" | "wait" | "rev";
export const PARTS_SORTS: Array<{ id: PartsSort; label: string; title: string }> = [
  { id: "group", label: "GROUP", title: "Grouped by what each part needs" },
  { id: "wait", label: "WAIT", title: "Longest wait first" },
  { id: "rev", label: "REV", title: "Most recently changed first" },
];

interface Grp {
  key: string;
  label: string;
  tone: "warn" | "bad" | "split" | "ok" | "plain";
  rows: Bal[];
}

function groupsOf(model: FloorModel): Grp[] {
  const byAge = (a: Bal, b: Bal) => (b.age ?? 0) - (a.age ?? 0);
  const out: Grp[] = [];
  const used = new Set<string>();
  const take = (rows: Bal[]): Bal[] => {
    const r = rows.filter((b) => !used.has(b.w.id)).sort(byAge);
    r.forEach((b) => used.add(b.w.id));
    return r;
  };
  for (const g of model.groups.filter((x) => x.type === "gate")) {
    const rows = take(g.wos.map((w) => model.byId.get(w.id)!).filter(Boolean));
    if (rows.length) out.push({ key: g.key, label: `NEEDS YOU · AT ${g.gid ? (model.stations.find((s) => s.gate?.g.id === g.gid)?.gate?.g.label ?? g.gid) : ""}`, tone: "warn", rows });
  }
  const parked = take(model.groups.filter((g) => g.type === "bay").flatMap((g) => g.wos.map((w) => model.byId.get(w.id)!).filter(Boolean)));
  if (parked.length) out.push({ key: "parked", label: "NEEDS YOU · PARKED", tone: "bad", rows: parked });
  const all = model.all;
  const stuck = take(all.filter((b) => b.kind === "stuck" && !b.w.bay));
  if (stuck.length) out.push({ key: "stuck", label: "STUCK", tone: "bad", rows: stuck });
  const line = take(all.filter((b) => (b.kind === "run" || b.kind === "idle") && !b.w.bay));
  if (line.length) out.push({ key: "line", label: "ON THE LINE", tone: "plain", rows: line });
  const split = take(all.filter((b) => b.kind === "split"));
  if (split.length) out.push({ key: "split", label: "SPLIT", tone: "split", rows: split });
  const bays = take(all.filter((b) => !!b.w.bay && b.w.bay !== "declined"));
  if (bays.length) out.push({ key: "bays", label: "SIDE BAYS", tone: "plain", rows: bays });
  const done = take(all.filter((b) => b.kind === "done")).slice(0, 12);
  if (done.length) out.push({ key: "done", label: "RELEASED", tone: "ok", rows: done });
  return out;
}

function Row({ b, h, max }: { b: Bal; h: LineHandlers; max: number }) {
  const ctx = useFloorCtx();
  const w = b.w;
  const st = ctx.cat.stations[w.station];
  const cls = classOf(ctx.cat, ctx.project, w.cls);
  const hn = b.gate && b.kind === "gate" ? gateHaveNeed(ctx, w, b.gate) : null;
  const late = b.age !== null && w.slaDue > 0 && ctx.now > w.slaDue;
  const open = () => h.onWo(w.id);
  const pos = b.age !== null && max > 0 ? Math.min(100, Math.round((b.age / max) * 100)) : 0;
  return (
    <li className="fp-pr-li">
      <div
        className={`fp-pr k-${b.kind}${h.hl.has(w.id) ? " hl" : ""}`}
        role="button"
        tabIndex={0}
        data-wo={w.id}
        id={`floor-part-${w.id}`}
        aria-label={`${w.id} ${w.title}, ${revWord(b, (id) => bayName(ctx.cat, id))}${b.age !== null ? `, ${dur(b.age)}` : ""}`}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
        onMouseEnter={() => h.hover([w.id])}
        onMouseLeave={() => h.hover(null)}
      >
        <span className="fp-pr-no" aria-hidden="true"><i>{b.n}</i></span>
        <span className="fp-pr-d">
          <span className="fp-pr-t">{w.title}</span>
          <span className="fp-pr-s mono">{`${w.id} · ${cls.name}${hn ? ` · ${hn.have}/${hn.need}` : ""}`}</span>
        </span>
        <span className="fp-pr-n mono">{st?.no ?? ""}</span>
        <span className="fp-pr-w">
          <span className={`mono fp-pr-tm${late ? " late" : ""}`}>{b.age === null ? "done" : dur(b.age)}</span>
          {b.age !== null ? <span className="fp-wb" aria-hidden="true"><i style={{ left: `${pos}%` }} /></span> : null}
        </span>
      </div>
    </li>
  );
}

export function PartsList({ model, sort, onSort, onClose, h }: { model: FloorModel; sort: PartsSort; onSort: (s: PartsSort) => void; onClose: () => void; h: LineHandlers }) {
  const groups = useMemo(() => (sort === "group" ? groupsOf(model) : []), [model, sort]);
  const flat = useMemo(() => {
    if (sort === "group") return [];
    const rows = model.all.filter((b) => b.w.bay !== "declined");
    return sort === "wait"
      ? rows.sort((a, b) => (b.age ?? -1) - (a.age ?? -1))
      : rows.sort((a, b) => (a.age ?? Infinity) - (b.age ?? Infinity));
  }, [model, sort]);
  const total = model.all.filter((b) => b.w.bay !== "declined").length;
  const max = Math.max(1, ...model.all.map((b) => b.age ?? 0));
  const tools = (
    <>
      <div className="seg" role="group" aria-label="Sort the parts list">
        {PARTS_SORTS.map((s) => (
          <Btn key={s.id} label={s.label} title={s.title} id={`floor-parts-sort-${s.id}`} aria-pressed={sort === s.id} onClick={() => onSort(s.id)} />
        ))}
      </div>
      <IconBtn icon="x" label="Close the parts list" id="floor-parts-close" onClick={onClose} />
    </>
  );
  return (
    <Panel title={<>Parts list <span className="fp-meta mono">{`BOM · ${total} items`}</span></>} cls="fp-parts" tools={tools} flush id="floor-parts">
      <div className="fp-pr-head mono" aria-hidden="true"><span>NO</span><span>DESCRIPTION</span><span>STN</span><span>WAIT</span></div>
      {total === 0 ? <p className="fp-empty mono">NO PARTS · nothing on this floor yet</p> : null}
      <div className="fp-bom">
        {sort === "group"
          ? groups.map((g) => (
              <section key={g.key} className={`fp-grp ${g.tone}`} aria-label={g.label}>
                <div className="fp-gh"><b className="mono">{g.label}</b><span className="mono fp-cnt">{g.rows.length}</span></div>
                <ul className="fp-pr-list">{g.rows.map((b) => <Row key={b.w.id} b={b} h={h} max={max} />)}</ul>
              </section>
            ))
          : <ul className="fp-pr-list">{flat.map((b) => <Row key={b.w.id} b={b} h={h} max={max} />)}</ul>}
      </div>
    </Panel>
  );
}
