/** The token drawer (prototype G.woDrawer): state, priority and class, the pipeline strip, where the work order is, and Review gate / Traveler / Open record. */
import { useEffect, useRef } from "react";
import { fmt } from "@gantry/domain";
import { Btn, IconBtn, Who } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { setProject } from "../../lib/prefs";
import { useRepoName } from "../traveler/repo";
import { beltGateLabels, tokenState } from "./conveyor";
import { openApproval } from "./Approval";
import { DrawerRoot } from "./Drawers";
import { since, useFloorCtx } from "./kit";

const TONE: Record<string, string> = { running: "info", queued: "idle", gate: "warn", blocked: "bad" };
const LABEL: Record<string, string> = { running: "Running", queued: "Queued", gate: "At a gate", blocked: "Blocked" };

export const Dr = ({ eyebrow, title, close, label, children, foot }: { eyebrow: string; title: string; close: () => void; label: string; children: React.ReactNode; foot?: React.ReactNode }) => (
  <div className="drawer-inner">
    <div className="drawer-h">
      <div>
        <div className="label">{eyebrow}</div>
        <h2>{title}</h2>
      </div>
      <IconBtn icon="x" label={label} className="drawer-close" onClick={close} />
    </div>
    <div className="drawer-b">{children}</div>
    {foot ? <div className="drawer-f">{foot}</div> : null}
  </div>
);

function Body({ woId, close }: { woId: string; close: () => void }) {
  const ctx = useFloorCtx();
  const pipeRef = useRef<HTMLDivElement | null>(null);
  /* the strip scrolls sideways; bring the current station into view so late stations are never out of reach */
  useEffect(() => {
    const cur = pipeRef.current?.querySelector<HTMLElement>(".st.cur");
    const box = pipeRef.current;
    if (cur && box) box.scrollLeft = Math.max(0, cur.offsetLeft - box.clientWidth / 2 + cur.offsetWidth / 2);
  });
  const ui = useUI();
  const w = ctx.wos.find((x) => x.id === woId);
  const repo = useRepoName(w?.project, w?.repo);
  if (!w) return <Dr eyebrow={woId} title="Work order not on this floor" close={close} label="Close work order details"><p className="muted small">It is done, or it belongs to another project.</p></Dr>;
  const state = tokenState(ctx, w);
  const gate = ctx.floor.gates.find((g) => g.wo === w.id);
  const glabel = gate ? (beltGateLabels(ctx).get(gate.gate) ?? gate.gate) : "";
  const gd = gate ? ctx.cat.gates.find((g) => g.id === gate.gate) : undefined;
  const order = ctx.project.flow.order.map((id) => ctx.cat.stations.findIndex((s) => s.id === id)).filter((i) => i >= 0);
  const cur = w.station;
  const skips = ctx.project.flow.classes.find((c) => c.id === w.cls) as { skips?: string[] } | undefined;
  const st = ctx.cat.stations[cur];
  const agent = w.history[w.history.length - 1]?.agent ?? null;
  const reason = w.blockReason || w.failReason || (w.bay ? w.bayReason : "");
  return (
    <Dr
      eyebrow={`${w.id} · ${ctx.project.name}`}
      title={w.title}
      close={close}
      label="Close work order details"
      foot={
        <>
          {gate && gd ? <Btn label="Review gate" kind="ok" id="floor-tok-review" onClick={() => openApproval(ui, ctx.project.id, w.id, gate.gate, glabel, gd.name)} /> : null}
          <Btn label="Traveler" id="floor-tok-traveler" onClick={() => { close(); setProject(w.project); navigate("traveler", w.id); }} />
          <Btn label="Open record" kind="primary" id="floor-tok-record" onClick={() => { close(); setProject(w.project); navigate("record", w.id); }} />
        </>
      }
    >
      <div className="row">
        <span className={`chip ${TONE[state]}`}>{state === "gate" && gate ? `At gate ${glabel}` : LABEL[state]}</span>
        <span className={`tag pri ${w.priority.toLowerCase()}`} title={`Priority ${w.priority}`}>{w.priority}</span>
        <span className="tag">{ctx.project.flow.classes.find((c) => c.id === w.cls)?.name ?? w.cls}</span>
      </div>
      <div className="pipe" ref={pipeRef} aria-label="Pipeline" style={{ overflowX: "auto" }}>
        {order.map((si, n) => {
          const s = ctx.cat.stations[si]!;
          const done = w.state === "done" || si < cur;
          const isC = si === cur && w.state !== "done";
          const tone = isC ? (state === "gate" ? "warn" : state === "blocked" ? "bad" : "") : "";
          return (
            <span key={s.id} style={{ display: "contents" }}>
              {n ? <span className={`ln ${done ? "done" : ""}`} /> : null}
              <span className={`st ${done ? "done" : ""}${isC ? ` cur ${tone}` : ""}`} style={skips?.skips?.includes(s.id) ? { opacity: 0.45 } : undefined}>
                <i>{done ? "✓" : n + 1}</i>
                {s.name}
              </span>
            </span>
          );
        })}
      </div>
      {reason ? <div className="banner bad"><div className="grow">{reason}</div></div> : null}
      <dl className="kv" style={{ margin: 0 }}>
        <dt>Station</dt><dd>{st?.name ?? ""}</dd>
        <dt>Agent</dt><dd>{agent ? <Who id={agent} /> : "none"}</dd>
        <dt>Requested by</dt><dd><Who id={w.requestedBy} /></dd>
        <dt>Repo</dt><dd><span className="m">{repo}</span></dd>
        <dt>Age</dt><dd>{fmt.dur(Math.max(0, ctx.now - w.createdAt))}</dd>
        <dt>Here for</dt><dd>{fmt.dur(Math.max(0, ctx.now - since(w)))}</dd>
        <dt>Cost</dt><dd className="dim">not available</dd>
      </dl>
    </Dr>
  );
}

export function TokenDrawer({ projectId, woId, close }: { projectId: string; woId: string; close: () => void }) {
  return (
    <DrawerRoot projectId={projectId}>
      <Body woId={woId} close={close} />
    </DrawerRoot>
  );
}
