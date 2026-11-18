/** Banner for a factory or project stop, or a project halt (prototype: a `.banner bad` with the reason and a Start restore button). Null when running normally. */
import { fmt, type KillInfo } from "@gantry/domain";
import { useCan } from "../api/can";
import { useMe } from "../api/queries";
import { CrIcon } from "../ui/cr";
import { Btn } from "../ui/primitives";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { makeStopActions } from "./stopActions";

export function StopBanner({ projectId }: { projectId?: string | null }) {
  const me = useMe();
  const ui = useUI();
  const actor = useActors();
  const restoreFactory = useCan("restore.factory");
  const restoreProject = useCan("restore.project", projectId ? { project: projectId } : {});
  if (!me) return null;
  const stop = makeStopActions(ui, me);
  const f = me.factory.killed as (KillInfo & { restoreApprovals?: unknown[] }) | null;
  const p = projectId ? me.projects.find((x) => x.id === projectId) : undefined;
  if (f) {
    const approvals = f.restoreApprovals?.length ?? 0;
    return (
      <div className="banner bad stop-banner is-kill" role="alert">
        <CrIcon name="stop" />
        <div className="grow">
          <b>Factory stopped.</b>
          {` ${f.reason} Restore needs two Factory Admins. ${actor(f.by).name}, ${fmt.stamp(f.at)} · in-flight work ${f.mode === "cancel" ? "cancelled" : "held"}${approvals ? ` · restore approvals ${approvals}/2` : ""}`}
        </div>
        {!restoreFactory.pending && restoreFactory.allowed ? <Btn label="Start restore" small id="sb-restore" onClick={() => stop.restore("factory", null)} /> : null}
      </div>
    );
  }
  if (p?.killed) {
    return (
      <div className="banner bad stop-banner is-kill" role="alert">
        <CrIcon name="stop" />
        <div className="grow">
          <b>Project stopped.</b>
          {` ${p.name}: ${p.killed.reason} · ${actor(p.killed.by).name}, ${fmt.stamp(p.killed.at)} · ${p.killed.mode === "cancel" ? "work cancelled" : "work held in place"}`}
        </div>
        {!restoreProject.pending && restoreProject.allowed ? <Btn label="Start restore" small id="sb-restore-project" onClick={() => stop.restore("project", p.id)} /> : null}
      </div>
    );
  }
  if (p?.halted) {
    return (
      <div className="banner warn stop-banner is-halt" role="status">
        <CrIcon name="halt" />
        <div className="grow">
          <b>Halted.</b>
          {` ${p.name}: ${p.halted.reason} · ${actor(p.halted.by).name}, ${fmt.ist(p.halted.at)} IST`}
        </div>
      </div>
    );
  }
  return null;
}
