/**
 * The "waiting on you" bar above the drawing: how many work orders wait on a person, and the top blockers (a gate with people waiting, or a bay
 * that is asking), oldest first, each with an Open button for the place that holds them. Hovering a card lights its balloons on the drawing.
 */
import { Btn } from "../../ui/primitives";
import type { Group } from "./model";
import type { FloorModel } from "./model";
import type { LineHandlers } from "./Line";

const SHOWN = 3;

export function NeedBar({ model, h, onMore }: { model: FloorModel; h: LineHandlers; onMore: () => void }) {
  if (!model.groups.length) return null;
  const top = model.groups.slice(0, SHOWN);
  const rest = model.groups.length - top.length;
  const open = (g: Group) => {
    if (g.type === "gate" && g.gid) h.onGate(g.gid);
    else if (g.wos.length === 1 && g.wos[0]) h.onWo(g.wos[0].id);
    else if (g.sid && g.bayId) h.onBay(g.sid, g.bayId);
  };
  const goLabel = (g: Group): string => (g.type === "gate" ? "OPEN GATE" : g.wos.length === 1 && g.wos[0] ? `OPEN ${g.wos[0].id}` : "OPEN BAY");
  return (
    <section className="fp-need" id="floor-need" aria-label="Waiting on you">
      <div className="fp-need-lead">
        <b id="floor-need-n">{model.needYou}</b>
        <span>WAITING<br />ON YOU</span>
      </div>
      {top.map((g) => (
        <div key={g.key} className={`fp-ncard ${g.type}`} data-k={g.key} onMouseEnter={() => h.hover(g.wos.map((w) => w.id))} onMouseLeave={() => h.hover(null)}>
          <i className="fp-nchip" aria-hidden="true">{g.no}</i>
          <span className="t1">{g.title}</span>
          <span className="t2 mono">{g.detail}</span>
          <Btn label={goLabel(g)} small id={`floor-need-${g.no}`} aria-label={`${goLabel(g).toLowerCase()}: ${g.title}`} onClick={() => open(g)} />
        </div>
      ))}
      {rest > 0 ? (
        <div className="fp-ncard more">
          <span className="t1">{`${rest} more group${rest === 1 ? "" : "s"}`}</span>
          <Btn label="PARTS LIST" small id="floor-need-more" onClick={onMore} />
        </div>
      ) : null}
    </section>
  );
}
