import { fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import { useMe } from "../../api/queries";
import { Btn, LockNote, Panel } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { makeStopActions } from "../../shell/stopActions";
import { canSeeRoute } from "../../lib/routes";
import type { HomeFull } from "./data";

/** The factory kill switch and its restore steps (legacy controlPanel). The simulation controls are not ported: there is no simulation. */
export function ControlPanel({ control }: { control: NonNullable<HomeFull["control"]> }) {
  const ui = useUI();
  const me = useMe();
  const actor = useActors();
  const killD = useCan("kill.factory");
  const restoreD = useCan("restore.factory");
  if (!me) return null;
  const f = control.killed;
  const stop = makeStopActions(ui, me);
  const approvals = control.restoreApprovals;
  const need = control.restoreNeeds;
  const already = approvals.some((a) => a.by === me.person.id);
  const others = control.admins.filter((a) => !approvals.some((x) => x.by === a.id));
  const rd = restoreD.allowed && already ? { ...restoreD, allowed: false, reason: "You approved this restore already. A second Factory Admin must approve.", needs: "A different Factory Admin" } : restoreD;
  const imp = control.impact;
  return (
    <section className={`panel hm-ctl${f ? " is-killed" : ""}`} id="hm-ctl" aria-label="Factory control panel">
      <div className="panel-head">
        <h2 className="panel-title">Factory control</h2>
        <Icon name="power" className="hm-ctl-pw" />
      </div>
      <div className="panel-body hm-ctl-body">
        <LockNote decision={f ? restoreD : killD} what={f ? "Restoring the factory" : "The factory kill switch"} />
        <div className={`hm-ctl-state ${f ? "is-killed" : "is-running"}`}>
          <Icon name={f ? "st-kill" : "st-run"} />
          <div>
            <div className="hm-ctl-big">{f ? "Factory killed" : "Factory running"}</div>
            <div className="small">
              {f ? `${actor(f.by).name}, ${fmt.stamp(f.at)} · in-flight work ${f.mode === "cancel" ? "cancelled" : "held in place"}` : `${imp.projects} projects · ${imp.workOrders} work orders in flight · ${imp.running} agents running`}
            </div>
          </div>
        </div>
        {f ? (
          <>
            <p className="hm-ctl-reason"><span className="kv-k">Reason </span>{f.reason}</p>
            <div className="hm-restore">
              <div className="sub-h">{`Restore approvals ${approvals.length} of ${need}`}</div>
              <ol className="hm-restore-steps">
                {Array.from({ length: need }, (_, i) => {
                  const a = approvals[i];
                  return (
                    <li key={i} className={a ? "is-done" : ""}>
                      <span className="hm-step-n mono">{String(i + 1)}</span>
                      {a ? <span>{`${actor(a.by).name} · ${fmt.ago(a.at, Date.now())}`}</span> : <span className="muted">{i === 0 ? "First Factory Admin" : "A second, different Factory Admin"}</span>}
                    </li>
                  );
                })}
              </ol>
              {need > 1 && approvals.length && !others.length ? (
                <div className="callout callout-warn small"><Icon name="alert" /><span>No other active Factory Admin exists. Grant the role to someone in People so they can approve the restore.</span></div>
              ) : null}
              {need > 1 && others.length ? <p className="small muted">{"Can approve next: " + others.map((a) => a.name).join(", ") + "."}</p> : null}
            </div>
            <div className="hm-ctl-actions">
              <Btn label={approvals.length ? `Approve restore (${approvals.length + 1} of ${need})` : "Restore the factory"} kind="primary" icon="power" id="hm-restore" guard={rd} onClick={() => stop.restore("factory", null)} />
            </div>
          </>
        ) : (
          <>
            <dl className="titleblock hm-ctl-impact">
              <div><dt>Projects</dt><dd>{String(imp.projects)}</dd></div>
              <div><dt>In flight</dt><dd>{String(imp.workOrders)}</dd></div>
              <div><dt>Agents</dt><dd>{String(imp.running)}</dd></div>
              <div><dt>Open PRs</dt><dd>{String(imp.prs)}</dd></div>
            </dl>
            <p className="small muted">{`The factory kill stops every agent in every project, frees coding slots and refuses new submissions. It needs a reason and the phrase KILL FACTORY. ${need > 1 ? "Restoring needs two different Factory Admins." : "Restoring needs one Factory Admin."}`}</p>
            <div className="hm-ctl-actions">
              <Btn label="Kill the factory" kind="danger" icon="st-kill" id="hm-kill" guard={killD} onClick={() => stop.kill("factory", null)} />
            </div>
          </>
        )}
        <div className="hm-ctl-row">
          <span className="small"><span className="kv-k">Factory Admins </span>{control.admins.map((a) => a.name).join(", ") || "none"}</span>
          {canSeeRoute("security", me, {}) ? <a href="#security" className="linkish small" id="hm-sec-link">Restore rule in Security</a> : null}
        </div>
      </div>
    </section>
  );
}
