/**
 * Security, Emergency stop: the factory-wide kill and restore (the same dialogs as the status menu), who may do it,
 * and every stop in force right now. Lifted stops stay in the Audit ledger.
 */
import { useQuery } from "@tanstack/react-query";
import type { SecuritySettings } from "@gantry/domain";
import { api, get } from "../../api/client";
import { useCan } from "../../api/can";
import { useMe, usePeople } from "../../api/queries";
import { fmt } from "@gantry/domain";
import { makeStopActions } from "../../shell/stopActions";
import { Btn, Panel, Status, Who, type Decision } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { lockd } from "../govern/data";

interface StopRow { id: string; scope: string; mode: string; reason: string; inFlight: string | null; by: string; at: number }

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });
const SCOPE: Record<string, string> = { factory: "Whole factory", project: "Project", repo: "Repo", workorder: "Work order" };

export function StopTab({ sec, onSignIn }: { sec: SecuritySettings; onSignIn: () => void }) {
  const me = useMe();
  const ui = useUI();
  const people = usePeople().data ?? [];
  const kill = dec(useCan("kill.factory"));
  const restore = dec(useCan("restore.factory"));
  const stops = useQuery({ queryKey: ["factory", "stops"] as const, queryFn: async () => (await get<{ items: StopRow[] }>(api("stops"))).items });
  if (!me) return null;
  const killed = me.factory.killed;
  const act = makeStopActions(ui, me);
  const admins = people.filter((p) => p.status === "active" && p.roles.some((g) => g.role === "factory_admin" && g.scope === "factory")).length;
  const noSecond = sec.restoreFactoryNeedsTwo && admins < 2;
  const restoreGuard: Decision = restore.allowed && killed && noSecond ? lockd(`Only ${admins} Factory Admin: a restore needs two different Factory Admins.`, "Add a second Factory Admin") : restore;
  return (
    <div className="sec-stop">
      <Panel
        title="Emergency stop"
        tools={killed ? <Status tone="block">Stopped</Status> : <Status tone="done">Running</Status>}
      >
        <p className="muted small sec-stop-sub">Stops every project at once. Running agents are held or cancelled as you choose.</p>
        {noSecond ? (
          <div className="callout callout-warn" role="alert" id="sec-stop-warn">
            <Icon name="alert" />
            <div><strong>{`Only ${admins} Factory Admin: a restore could not be approved.`}</strong><span>{" If the factory is stopped now, nobody could lift it. Add a second Factory Admin in "}<a href="#people" className="linkish">People &amp; teams</a>.</span></div>
          </div>
        ) : null}
        <div className="sec-stop-act">
          {killed
            ? <Btn label="Restore the factory" kind="primary" icon="play" id="sec-stop-restore" guard={restoreGuard} onClick={() => act.restore("factory", null)} />
            : <Btn label="Emergency stop the factory" kind="danger" icon="halt" id="sec-stop-kill" guard={kill} onClick={() => act.kill("factory", null)} />}
        </div>
        <dl className="sec-kv">
          <div><dt>Restore</dt><dd>{sec.restoreFactoryNeedsTwo ? "Needs two different Factory Admins and a fresh sign-in." : "One Factory Admin with a fresh sign-in."}</dd></div>
          <div><dt>Kill</dt><dd>{sec.killNeedsStepUp !== false ? "Needs a fresh sign-in." : "No fresh sign-in needed."}</dd></div>
          <div><dt>Change this</dt><dd><button type="button" className="linkbtn" onClick={onSignIn}>Sign-in tab, Session lifetime</button></dd></div>
        </dl>
      </Panel>
      <Panel title="Stops in force" flush>
        <Async query={stops} what="stops" id="sec-stops">{(rows) => rows.length ? (
          <div className="table-scroll">
            <table className="table table-compact sec-table" id="sec-stops-table">
              <thead><tr>{["Scope", "Target", "Mode", "Reason", "Set by", "Set (IST)"].map((x) => <th key={x} scope="col">{x}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{SCOPE[r.scope] ?? r.scope}</td>
                    <td className="mono">{r.id.includes(":") ? r.id.split(":")[1] || "factory" : r.id}</td>
                    <td><Status tone={r.mode === "kill" ? "block" : "wait"}>{r.mode === "kill" ? "Killed" : "Halted"}</Status></td>
                    <td className="small">{r.reason || "No reason recorded"}</td>
                    <td><Who id={r.by} /></td>
                    <td className="mono nowrap">{`${fmt.istDate(r.at)} ${fmt.ist(r.at)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted small sec-stop-none">Nothing is stopped right now.</p>}</Async>
        <p className="muted small sec-stop-foot">Stops that were lifted stay in the <button type="button" className="linkbtn" onClick={() => navigate("audit")}>Audit ledger</button> under Kill.</p>
      </Panel>
    </div>
  );
}
