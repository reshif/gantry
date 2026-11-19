/**
 * Security, Emergency stop: the factory-wide kill and restore (the same dialogs as the status menu), who may do it,
 * and every stop in force right now. Lifted stops stay in the Audit ledger.
 */
import type { SecuritySettings } from "@gantry/domain";
import { useCan } from "../../api/can";
import { useFactoryStops, useMe } from "../../api/queries";
import { fmt } from "@gantry/domain";
import { makeStopActions } from "../../shell/stopActions";
import { Btn, Panel, Status, Who, type Decision } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { DataTable } from "../../ui/DataTable";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });
const SCOPE: Record<string, string> = { factory: "Whole factory", project: "Project", repo: "Repo", workorder: "Work order" };

export function StopTab({ sec }: { sec: SecuritySettings }) {
  const me = useMe();
  const ui = useUI();
  const kill = dec(useCan("kill.factory"));
  const restoreD = useCan("restore.factory");
  const restore = dec(restoreD);
  const sole = restoreD.allowed && restoreD.override === true; // the server says this admin is the only one: restore with a reason, no second person
  const stops = useFactoryStops();
  if (!me) return null;
  const killed = me.factory.killed;
  const act = makeStopActions(ui, me);
  return (
    <div className="sec-stop">
      <Panel
        title="Emergency stop"
        tools={killed ? <Status tone="block">Stopped</Status> : <Status tone="done">Running</Status>}
      >
        <p className="muted small sec-stop-sub">Stops every project at once. Running agents are held or cancelled as you choose.</p>
        {sole && killed ? (
          <div className="callout callout-warn" role="note" id="sec-stop-warn">
            <Icon name="alert" />
            <div><strong>You are the only Factory Admin.</strong><span>{" You can restore the factory yourself with a reason; it is recorded in the audit as an override."}</span></div>
          </div>
        ) : null}
        <div className="sec-stop-act">
          {killed
            ? <Btn label={sole ? "Restore with a reason" : "Restore the factory"} kind="primary" icon="play" id="sec-stop-restore" guard={restore} onClick={() => act.restore("factory", null)} />
            : <Btn label="Emergency stop the factory" kind="danger" icon="halt" id="sec-stop-kill" guard={kill} onClick={() => act.kill("factory", null)} />}
        </div>
        <dl className="sec-kv">
          <div><dt>Restore</dt><dd>{sec.restoreFactoryNeedsTwo && !sole ? "Needs two different Factory Admins and a fresh sign-in." : sole ? "You are the only Factory Admin: restore with a reason (audited) and a fresh sign-in." : "One Factory Admin with a fresh sign-in."}</dd></div>
          <div><dt>Kill</dt><dd>{sec.killNeedsStepUp !== false ? "Needs a fresh sign-in." : "No fresh sign-in needed."}</dd></div>
          <div><dt>Change this</dt><dd><Btn label="Sign-in policy above" small kind="ghost" id="sec-stop-policy" onClick={() => document.getElementById("sec-policy")?.scrollIntoView({ block: "start" })} /></dd></div>
        </dl>
      </Panel>
      <Panel title="Stops in force" flush>
        <Async query={stops} what="stops" id="sec-stops">{(rows) => rows.length ? (
          <DataTable id="sec-stops-table" caption="Stops in force" rows={rows} rowKey={(r) => r.id}
            columns={[
              { key: "scope", label: "Scope", render: (r) => SCOPE[r.scope] ?? r.scope },
              { key: "target", label: "Target", render: (r) => <span className="mono">{r.id.includes(":") ? r.id.split(":")[1] || "factory" : r.id}</span> },
              { key: "mode", label: "Mode", render: (r) => <Status tone={r.mode === "kill" ? "block" : "wait"}>{r.mode === "kill" ? "Killed" : "Halted"}</Status> },
              { key: "reason", label: "Reason", render: (r) => <span className="small">{r.reason || "No reason recorded"}</span> },
              { key: "by", label: "Set by", render: (r) => <Who id={r.by} /> },
              { key: "at", label: "Set (IST)", render: (r) => <span className="mono nowrap">{`${fmt.istDate(r.at)} ${fmt.ist(r.at)}`}</span> },
            ]} />
        ) : <p className="muted small sec-stop-none">Nothing is stopped right now.</p>}</Async>
        <p className="muted small sec-stop-foot">Stops that were lifted stay in the <Btn label="Audit ledger" small kind="ghost" id="sec-stop-audit" onClick={() => navigate("audit")} /> under Kill.</p>
      </Panel>
    </div>
  );
}
