/** The traveler's action rows: approve or reject the waiting gate, retry, return from a bay, move to a bay, send back, reassign, reclassify, halt or resume the repo, kill or restore (legacy traveler.js actions). */
import type { ReactElement } from "react";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { useMe } from "../../api/queries";
import { Btn } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { makeStopActions } from "../../shell/stopActions";
import { useCatalog } from "../projects/kit";
import { useProjectRepos } from "../floor/kit";
import { ReclassifyDialog } from "../work-orders/intake";
import { ParkDialog, ReassignDialog, SendBackDialog } from "./Dialogs";
import { bayLabel, dec, isClosed, no, ok, stName, type TDecision, type TWo } from "./model";

export function Actions({ wo }: { wo: TWo }) {
  const ui = useUI();
  const me = useMe();
  const cat = useCatalog();
  const repos = useProjectRepos(wo.project);
  const repo = repos.find((r) => r.id === wo.repo);
  const haltResume = useCan("line.resume", { project: wo.project });
  const haltD = useCan("line.halt", { project: wo.project });
  const killD = useCan("kill.workorder", { project: wo.project });
  const restoreD = useCan("restore.workorder", { project: wo.project });
  const approveGate = useCan("gate.approve", { project: wo.project });
  if (!cat || !me) return null;
  const stops = makeStopActions(ui, me);
  const stop = wo.stop;
  const stopWhy = stop ? `${stop.reason || "Stopped"} (${stop.scope} ${stop.mode === "halt" ? "halted" : "killed"})` : "";
  const halted = stop?.mode === "halt" ? stop : null;
  const res = (r: { ok: boolean; msg: string }, kind: "ok" | "warn" = "ok") => {
    ui.toast(r.msg, r.ok ? kind : "error");
    return r.ok;
  };
  const ifm = { ifMatch: wo.version };
  const closed = isClosed(wo);
  const closedWhy = wo.state === "done" ? `${wo.id} has shipped.` : `${wo.id} is killed. Restore it first.`;
  const ap = wo.allowed.approve;
  const g = ap ? cat.gates.find((x) => x.id === ap.gate) : undefined;
  const waiting = !wo.bay && wo.state === "waiting" && !!ap && !!g;
  const stationId = cat.stations[wo.station]?.id ?? "";
  const row1: ReactElement[] = [];
  const row2: ReactElement[] = [];
  if (waiting && ap && g) {
    let dA: TDecision = ap;
    if (dA.allowed && halted) dA = no(`${halted.reason} Resume first.`);
    row1.push(
      <Btn
        key="approve"
        label={g.id === "G0G1" ? "Confirm brief" : g.id === "G6" ? "Confirm release" : `Approve ${g.label}`}
        kind="primary"
        icon={g.id === "G6" ? "rocket" : "check"}
        id="trv-approve"
        guard={dA}
        onClick={() => void (g.id === "G0G1" ? ops.confirmBrief(wo.id, undefined, ifm) : ops.approveGate(wo.id, g.id, undefined, ifm)).then((r) => res(r))}
      />,
    );
    if (!dA.allowed) row1.push(<p key="approve-why" className="small muted trv-why" id="trv-approve-why" role="note">{`${dA.reason}${dA.needs ? ` Needs: ${dA.needs}.` : ""}`}</p>);
    const dR: TDecision = g.id === "G0G1" ? (stop ? no(stopWhy) : dec(wo, "decline")) : ap;
    row1.push(
      <Btn
        key="reject"
        label={g.id === "G0G1" ? "Decline" : `Reject ${g.label}`}
        icon="x"
        id="trv-reject"
        guard={dR}
        onClick={() =>
          ui.reasonDialog({
            title: `${g.id === "G0G1" ? "Decline " : `Reject ${g.label} on `}${wo.id}`,
            kicker: `${g.label} ${g.name}`,
            ok: g.id === "G0G1" ? "Decline" : "Reject",
            kind: "danger",
            min: 5,
            sub: g.id === "G0G1" ? "The work order moves to Declined and the submitter is told why." : `The station's agent reworks ${stName(cat, stationId)} with your reason.`,
            placeholder: g.id === "G0G1" ? "Why will the factory not do this?" : "What must change before this passes?",
            onOk: async (v) => {
              const r = g.id === "G0G1" ? await ops.decline(wo.id, v, undefined, ifm) : await ops.rejectGate(wo.id, g.id, v, undefined, ifm);
              if (r.ok) ui.toast(r.msg, "ok");
              return r;
            },
          })
        }
      />,
    );
  }
  void approveGate;
  if (wo.state === "failed" || wo.state === "blocked")
    row1.push(<Btn key="retry" label={`Retry ${stName(cat, stationId)}`} kind="primary" icon="refresh" id="trv-retry" guard={stop ? no(stopWhy) : dec(wo, "sendback")} onClick={() => void ops.retry(wo.id, undefined, ifm).then((r) => res(r))} />);
  if (wo.bay) {
    let dU: TDecision = stop ? no(stopWhy) : dec(wo, "park");
    if (dU.allowed && wo.bay === "sechold" && !approveGate.allowed) dU = no(`Security hold can only be released by someone who may approve gates in this project.`);
    const back = wo.bayFrom || stationId;
    row1.push(
      <Btn
        key="unpark"
        label={`Return to ${stName(cat, back)}`}
        kind="primary"
        icon="undo"
        id="trv-unpark"
        guard={dU}
        onClick={() =>
          ui.reasonDialog({
            title: `Return ${wo.id} from ${bayLabel(cat, wo.bay)}`,
            kicker: "Bay",
            ok: "Return to belt",
            min: 3,
            placeholder: "What changed?",
            sub: `It goes back to ${stName(cat, back)}.`,
            onOk: async (v) => {
              const r = await ops.unpark(wo.id, v, undefined, ifm);
              if (r.ok) ui.toast(r.msg, "ok");
              return r;
            },
          })
        }
      />,
    );
  } else
    row2.push(<Btn key="park" label="Move to bay" icon="st-park" id="trv-park" guard={closed ? no(closedWhy) : stop ? no(stopWhy) : dec(wo, "park")} onClick={() => void ui.open((close) => <ParkDialog woId={wo.id} onClose={close} />)} />);
  const first = wo.route.indexOf(stationId) <= 0;
  row2.push(
    <Btn
      key="sendback"
      label="Send back"
      icon="undo"
      id="trv-sendback"
      guard={closed ? no(closedWhy) : stop ? no(stopWhy) : wo.bay ? no(`Return it from ${bayLabel(cat, wo.bay)} first.`) : first ? no("Already at the first station on its route.") : dec(wo, "sendback")}
      onClick={() => void ui.open((close) => <SendBackDialog woId={wo.id} onClose={close} />)}
    />,
    <Btn key="reassign" label="Reassign agent" icon="swap" id="trv-reassign" guard={closed ? no(closedWhy) : wo.bay ? no("Nobody staffs work in a bay.") : dec(wo, "reassign")} onClick={() => void ui.open((close) => <ReassignDialog woId={wo.id} onClose={close} />)} />,
    <Btn
      key="reclass"
      label="Reclassify"
      icon="tag"
      id="trv-reclass"
      guard={closed ? no(closedWhy) : wo.station !== 0 || wo.bay ? no("Class can only change at Intake. Send it back to Intake first.") : stop ? no(stopWhy) : dec(wo, "classify")}
      onClick={() => void ui.open((close) => <ReclassifyDialog woId={wo.id} onClose={close} />)}
    />,
  );
  if (repo)
    row2.push(
      repo.halted ? (
        <Btn key="repo" label={`Resume ${repo.name}`} icon="play" id="trv-resume" guard={haltResume.pending ? null : haltResume} onClick={() => void stops.resumeRepo(repo.id)} />
      ) : (
        <Btn key="repo" label="Halt repo" kind="andon" icon="halt" id="trv-halt" aria={`Halt ${repo.name} (andon)`} guard={haltD.pending ? null : haltD} onClick={() => stops.haltRepo(repo.id, wo.project)} />
      ),
    );
  row2.push(
    wo.state === "killed" ? (
      <Btn key="kill" label={`Restore ${wo.id}`} icon="power" id="trv-restore" guard={stop && stop.scope !== "wo" && stop.scope !== "workorder" ? no(`${stopWhy} Restore the ${stop.scope} first.`) : restoreD.pending ? null : restoreD} onClick={() => stops.restore("workorder", wo.id)} />
    ) : (
      <Btn key="kill" label="Kill work order" kind="danger" icon="st-kill" id="trv-kill" guard={wo.state === "done" ? no(closedWhy) : killD.pending ? null : killD} onClick={() => stops.kill("workorder", wo.id)} />
    ),
  );
  void ok;
  return (
    <div className="trv-actions">
      {row1.length ? <div className="drawer-actions">{row1}</div> : null}
      <div className="drawer-actions trv-actions-2">{row2}</div>
    </div>
  );
}
