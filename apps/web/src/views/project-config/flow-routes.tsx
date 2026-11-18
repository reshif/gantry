/** Project config > Flow > Class routes: which stations each work class travels, with a live preview on the belt. The ticks are part of the Flow draft. */
import { flowOf, type Catalog } from "@gantry/domain";
import { Btn, Field, Panel, Select, type Decision } from "../../ui/primitives";
import { MiniBelt, RouteMatrix, classOf, metricsOf, routeGatesOf, routeOf, type PView } from "../projects/kit";

/** `p` is the project as the draft would leave it, so the matrix and the preview show unsaved ticks. */
export function ClassRoutes({ p, cat, sel, onSel, decision, onToggle, onEnable, onReset }: {
  p: PView; cat: Catalog; sel: string; onSel: (id: string) => void; decision: Decision;
  onToggle: (cid: string, sid: string, travels: boolean) => void; onEnable: (cid: string, on: boolean) => void; onReset: () => void;
}) {
  const f = flowOf(cat, p);
  const m = metricsOf(p);
  const flowCls = p.flow.classes.some((c) => c.id === sel) ? sel : (p.flow.classes[0]?.id ?? "");
  const cls = classOf(cat, p, flowCls);
  const route = routeOf(cat, p, flowCls);
  const rStations = route.map((x) => cat.stations.find((y) => y.id === x)?.name ?? x).join(" → ");
  const rGates = routeGatesOf(cat, p, flowCls).map((x) => cat.gates.find((y) => y.id === x)?.label ?? x).join(", ");
  const skipped = f.stations.filter((x) => !route.includes(x.id)).map((x) => x.name);
  return (
    <Panel title="Class routes" id="flw-routes" flush>
      <div className="pcf-preview-head pcf-pad">
        <span className="kicker">{`Live preview · ${f.stations.length} stations, ${f.gates.length} gates, ${f.bays.length} bays`}</span>
        <Field label="Class" htmlFor="pcf-flow-cls">
          <Select id="pcf-flow-cls" options={p.flow.classes.map((c) => ({ value: c.id, label: c.name + (c.enabled === false ? " (off)" : "") + (c.custom ? " (custom)" : "") }))} value={flowCls} onChange={onSel} />
        </Field>
      </div>
      <div className="pcf-pad"><MiniBelt cat={cat} project={p} counts={m.byPosition} cls={flowCls} labels /></div>
      <p className="small pcf-route-t pcf-pad" aria-live="polite">
        <strong>{`${cls.name}: `}</strong>{rStations}<br />
        <span className="muted">{`Gates ${rGates || "none"}${skipped.length ? ` · skips ${skipped.join(", ")}` : ""}`}</span>
      </p>
      <p className="small muted pcf-pad">Ticked stations are on the class's route. Select a class to preview its route on the belt. Turning a class off stops the Intake agent from proposing it. Ticks are part of the draft: Review, then Save.</p>
      <RouteMatrix
        cat={cat} project={p} classes={p.flow.classes} stationsOff={f.stations.filter((x) => !x.enabled).map((x) => x.id)} decision={decision} selected={flowCls} idp="pcf-rm"
        onSelect={onSel} onToggle={onToggle} onEnable={onEnable}
      />
      <div className="pcf-pad"><Btn small kind="ghost" icon="undo" id="pcf-rm-reset" guard={decision} label="Reset routes to the template" onClick={onReset} /></div>
    </Panel>
  );
}
