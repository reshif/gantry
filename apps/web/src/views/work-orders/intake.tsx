/**
 * Intake widgets shared by Work orders and Conversations (legacy workorders.js helpers): the route strip, the confidence meter,
 * the class override dialog and the classification card shown once after a submission.
 */
import { useState } from "react";
import { gateExplain, classify, classesOf, flowOf, route as routeOf, routeGates as routeGatesOf, type Catalog, type Project, type WorkOrder } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { useWorkOrder } from "../../api/queries";
import { Dialog } from "../../ui/Overlay";
import { Icon } from "../../ui/Icon";
import { Btn, Field, LockNote } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { setProject, updatePrefs } from "../../lib/prefs";
import { ClassChip, classOf, useCatalog } from "../projects/kit";

export function routeText(cat: Catalog, project: Project, cls: string): string {
  return routeOf(cat, project, cls).map((s) => { const st = cat.stations.find((x) => x.id === s); return `${st?.no ?? ""} ${st?.name ?? s}`; }).join(" → ");
}
export function skipsText(cat: Catalog, project: Project, cls: string): string {
  const r = routeOf(cat, project, cls);
  const sk = flowOf(cat, project).active.filter((s) => !r.includes(s.id)).map((s) => s.name);
  return sk.length ? `Skips ${sk.join(", ")}` : "Full route, no skips";
}

/** Route strip: stations as numbered cells, skipped ones struck through, gate diamonds between. */
export function RouteStrip({ cat, project, cls }: { cat: Catalog; project: Project; cls: string }) {
  const r = routeOf(cat, project, cls);
  const gates = routeGatesOf(cat, project, cls);
  return (
    <ol className="int-route" aria-label={`Route: ${routeText(cat, project, cls)}`}>
      {flowOf(cat, project).active.flatMap((s) => {
        const on = r.includes(s.id);
        const g = cat.gates.find((x) => x.after === s.id);
        const out = [
          <li key={s.id} className={`int-rs${on ? "" : " is-skip"}${s.custom ? " is-custom" : ""}`} title={`${s.name}${on ? "" : " (skipped)"}${s.custom ? " · custom station" : ""}`}>
            <span className="mono int-rs-no">{s.no}</span>
            <span className="int-rs-n">{s.name}</span>
          </li>,
        ];
        if (g && gates.includes(g.id)) {
          out.push(
            <li key={g.id} className={`int-rg gate-kind-${g.kind}`} title={gateExplain(g)}>
              <span className="int-rg-d" aria-hidden="true" />
              <span className="int-rg-l" title={g.label}>{g.name}</span>
            </li>,
          );
        }
        return out;
      })}
    </ol>
  );
}

export function ConfMeter({ c }: { c: number }) {
  const pct = Math.round(c * 100);
  const lvl = c >= 0.8 ? "hi" : c >= 0.65 ? "mid" : "lo";
  return (
    <span className={`int-conf int-conf-${lvl}`} role="img" aria-label={`Confidence ${pct}%`}>
      <span className="int-conf-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="mono">{`${pct}%`}</span>
      <span className="small muted">{lvl === "hi" ? "high" : lvl === "mid" ? "medium" : "low, please check"}</span>
    </span>
  );
}

/** Override dialog: class radio cards with a live route preview and a required reason. */
export function ReclassifyDialog({ woId, preset, onClose }: { woId: string; preset?: string; onClose: () => void }) {
  const ui = useUI();
  const cat = useCatalog();
  const wo = useWorkOrder(woId).data;
  const dec = useCan("wo.classify", wo ? { project: wo.project } : {});
  const [pick, setPick] = useState<string | null>(preset ?? null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const project = useProjectOf(wo?.project);
  if (!wo || !cat || !project) return null;
  const cur = pick ?? wo.cls;
  const classes = classesOf(cat, project);
  const notIntake = wo.station !== 0;
  const locked = !dec.allowed && !dec.pending;
  const submit = async () => {
    if (busy) return;
    if (cur === wo.cls) {
      setErr("Pick a different class.");
      return;
    }
    if (reason.trim().length < 5) {
      setErr("Give a reason of at least 5 characters.");
      return;
    }
    setBusy(true);
    const r = await ops.reclassify(wo.id, cur, reason.trim(), (wo as { version?: number }).version !== undefined ? { ifMatch: (wo as { version?: number }).version as number } : undefined);
    setBusy(false);
    if (!r.ok) {
      setErr(r.msg);
      return;
    }
    ui.toast(r.msg, "ok");
    onClose();
  };
  return (
    <Dialog
      title={`Change the class of ${wo.id}`}
      kicker="Intake · classification override"
      wide
      onClose={onClose}
      sub={`The Intake classifier suggested ${classOf(cat, project, wo.clsSuggested || wo.cls).name} at ${Math.round(wo.clsConfidence * 100)}%. Changing the class changes the route and restarts the open intake questions; answers you already gave are kept where they still apply. The override is audited.`}
      body={
        <div className="form-grid">
          <LockNote decision={dec.pending ? null : dec} what="The class" />
          {notIntake ? (
            <div className="callout callout-warn">
              <Icon name="alert" />
              <div>Class can only change at Intake.</div>
            </div>
          ) : null}
          <div className="radio-cards int-rc-cards">
            {classes.map((c) => (
              <label key={c.id} className="radio-card" htmlFor={`int-rc-${c.id}`}>
                <input type="radio" name="int-rc" id={`int-rc-${c.id}`} value={c.id} checked={c.id === cur} disabled={locked} onChange={() => setPick(c.id)} />
                <span className="rc-t">
                  <ClassChip cls={c} />
                  {c.id === wo.clsSuggested ? <span className="muted small"> suggested</span> : null}
                </span>
                <span className="rc-d">{`SLA ${c.slaH}h · est ${c.est}`}</span>
              </label>
            ))}
          </div>
          <div className="int-rc-prev">
            <div className="small">
              <strong>{`${classOf(cat, project, cur).name}: `}</strong>
              {`${skipsText(cat, project, cur)}. Default priority ${classOf(cat, project, cur).priority}.`}
            </div>
            <RouteStrip cat={cat} project={project} cls={cur} />
          </div>
          <Field label="Reason (required)" htmlFor="int-rc-reason">
            <textarea id="int-rc-reason" className="input" rows={2} placeholder="Why is the suggested class wrong?" disabled={locked} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="form-err" role="alert">
            {err}
          </div>
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Change class", kind: "primary", submit: true, id: "int-rc-ok", guard: dec.pending ? null : dec, onClick: () => void submit() }]}
    />
  );
}

/** The project record the flow functions need: the full project from the project read. */
import { useProject } from "../../api/queries";
function useProjectOf(id: string | null | undefined): Project | null {
  return (useProject(id).data as Project | undefined) ?? null;
}

/** What the Intake classifier decided and the route it proposes: shown once after a submission. */
export function ClassificationCard({ woId, onClose }: { woId: string; onClose: () => void }) {
  const ui = useUI();
  const cat = useCatalog();
  const wo = useWorkOrder(woId).data as (WorkOrder & { repoName?: string }) | undefined;
  const dec = useCan("wo.classify", wo ? { project: wo.project } : {});
  const project = useProjectOf(wo?.project);
  if (!wo || !cat || !project) return null;
  const c = classOf(cat, project, wo.cls);
  const alts = classify(cat, `${wo.title} ${wo.description}`, null, project).alternatives.filter((a) => a !== wo.cls);
  const open = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const openConversation = () => {
    setProject(wo.project);
    updatePrefs({ openConversation: wo.id });
    navigate("conversations");
  };
  const q = wo.conv?.questions?.length ?? 0;
  const gaps = wo.conv?.misses?.length ?? 0;
  return (
    <Dialog
      title={`${wo.id} classified as ${c.name}`}
      kicker="Intake · classification"
      sub={wo.title}
      wide
      onClose={onClose}
      body={
        <div className="int-cls">
          <div className="int-cls-top">
            <div className="int-cls-big">
              <div className="kicker">Class</div>
              <ClassChip cls={c} />
            </div>
            <div>
              <div className="kicker">Confidence</div>
              <ConfMeter c={wo.clsConfidence} />
            </div>
            <div>
              <div className="kicker">Priority · SLA</div>
              <span className="mono">{`${wo.priority} · ${c.slaH}h`}</span>
            </div>
          </div>
          <p className="int-cls-why">{wo.clsRationale}</p>
          {wo.requestedCls && wo.requestedCls !== wo.clsSuggested ? (
            <div className="callout callout-warn">
              <Icon name="swap" />
              <div>{`You asked for ${classOf(cat, project, wo.requestedCls).name}; the classifier suggested ${classOf(cat, project, wo.clsSuggested).name}. ${wo.cls === wo.requestedCls ? "Your request was kept because confidence was below 80%." : "The suggestion was used because confidence was 80% or more."}`}</div>
            </div>
          ) : null}
          {wo.clsConfidence < 0.65 ? (
            <div className="callout callout-warn">
              <Icon name="alert" />
              <div>Low confidence. Check the class before answering the questions.</div>
            </div>
          ) : null}
          <h3 className="sub-h">Proposed route</h3>
          <p className="small">{`${skipsText(cat, project, wo.cls)}.`}</p>
          <RouteStrip cat={cat} project={project} cls={wo.cls} />
          {alts.length ? (
            <div className="int-alts">
              <span className="small muted">Also possible: </span>
              {alts.map((a) => (
                <Btn key={a} label={`Use ${classOf(cat, project, a).name}`} small id={`int-alt-${a}`} guard={dec.pending ? null : dec} onClick={open(() => ui.open((close) => <ReclassifyDialog woId={wo.id} preset={a} onClose={close} />))} />
              ))}
            </div>
          ) : null}
          <h3 className="sub-h">Next</h3>
          <p className="small">{`The Intake Clerk has opened a conversation with ${q} questions${gaps ? ` and noticed ${gaps} gap${gaps > 1 ? "s" : ""}` : ""}. ${wo.id} stays at Intake until you confirm the brief (gate G0+G1).`}</p>
        </div>
      }
      actions={[
        { label: "Close", id: "int-cls-close" },
        { label: "Change class", id: "int-cls-change", guard: dec.pending ? null : dec, onClick: open(() => ui.open((close) => <ReclassifyDialog woId={wo.id} onClose={close} />)) },
        { label: "Answer intake questions", kind: "primary", submit: true, icon: "chat", id: "int-cls-open", onClick: open(openConversation) },
      ]}
    />
  );
}
