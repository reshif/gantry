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
import { ApproveGateDialog, RejectGateDialog } from "../record/GateDialogs";
import { ParkDialog, ReassignDialog, RedoDialog, SendBackDialog } from "./Dialogs";
import { bayLabel, dec, isClosed, no, ok, stName, type TDecision, type TWo } from "./model";

/** One action the viewer may take on a work order. `group` says where the dossier toolbar puts it; the drawer lists them in two rows. */
export interface ActionSpec {
  key: string;
  label: string;
  icon: string;
  id: string;
  kind?: string;
  guard: TDecision | null | undefined;
  onClick: () => void;
  group: "decide" | "main" | "move" | "inline" | "more";
  aria?: string;
  /** Why the control is locked, shown beside it. */
  why?: string;
}

/** The actions of a work order with their locks and handlers; both the traveler drawer and the dossier toolbar render them. */
export function useActionSpecs(wo: TWo, page = false): ActionSpec[] | null {
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
  const out: ActionSpec[] = [];
  if (waiting && ap && g) {
    let dA: TDecision = ap;
    if (dA.allowed && halted) dA = no(`${halted.reason} Resume first.`);
    out.push({
      key: "approve",
      label: page ? "Approve" : g.id === "G0G1" ? "Confirm brief" : g.id === "G6" ? "Confirm release" : `Approve ${g.label}`,
      kind: "primary",
      icon: page ? "" : g.id === "G6" ? "rocket" : "check",
      id: "trv-approve",
      guard: dA,
      group: "decide",
      ...(!dA.allowed ? { why: `${dA.reason}${dA.needs ? ` Needs: ${dA.needs}.` : ""}` } : {}),
      onClick: () => {
        const run = () => void (g.id === "G0G1" ? ops.confirmBrief(wo.id, undefined, ifm) : ops.approveGate(wo.id, g.id, ap.instance, undefined, ifm)).then((r) => res(r));
        // the work order page asks first (prototype Approve dialog: the gate's purpose and an optional note); the drawer decides in one press
        if (!page) return run();
        void ui.open((close) => <ApproveGateDialog wo={wo} gate={g} guard={dA} run={(note) => (g.id === "G0G1" ? ops.confirmBrief(wo.id, undefined, ifm) : ops.approveGate(wo.id, g.id, ap.instance, undefined, ifm, note || undefined))} onClose={close} />);
      },
    });
    const dR: TDecision = g.id === "G0G1" ? (stop ? no(stopWhy) : dec(wo, "decline")) : ap;
    out.push({
      key: "reject",
      label: page ? "Reject" : g.id === "G0G1" ? "Decline" : `Reject ${g.label}`,
      ...(page ? { kind: "danger" } : {}),
      icon: page ? "" : "x",
      id: "trv-reject",
      guard: dR,
      group: "decide",
      onClick: () => {
        if (page) return void ui.open((close) => <RejectGateDialog wo={wo} gate={g} guard={dR} run={(v) => (g.id === "G0G1" ? ops.decline(wo.id, v, undefined, ifm) : ops.rejectGate(wo.id, g.id, ap.instance, v, undefined, ifm))} onClose={close} />);
        ui.reasonDialog({
          title: `${g.id === "G0G1" ? "Decline " : `Reject ${g.label} on `}${wo.id}`,
          kicker: `${g.label} ${g.name}`,
          ok: g.id === "G0G1" ? "Decline" : "Reject",
          kind: "danger",
          min: 5,
          sub: g.id === "G0G1" ? "The work order moves to Declined and the submitter is told why." : `The station's agent reworks ${stName(cat, stationId)} with your reason.`,
          placeholder: g.id === "G0G1" ? "Why will the factory not do this?" : "What must change before this passes?",
          onOk: async (v) => {
            const r = g.id === "G0G1" ? await ops.decline(wo.id, v, undefined, ifm) : await ops.rejectGate(wo.id, g.id, ap.instance, v, undefined, ifm);
            if (r.ok) ui.toast(r.msg, "ok");
            return r;
          },
        });
      },
    });
  }
  if (waiting && ap && g && g.id !== "G0G1") {
    out.push({
      key: "changes",
      label: page ? "Request changes" : `Request changes at ${g.label}`,
      icon: page ? "" : "undo",
      id: "trv-changes",
      guard: ap,
      group: "decide",
      onClick: () =>
        ui.reasonDialog({
          title: `Request changes at ${g.label} on ${wo.id}`,
          kicker: `${g.label} ${g.name}`,
          ok: "Request changes",
          min: 8,
          sub: `The station's agent reworks ${stName(cat, stationId)} with what you ask for. Nothing is approved.`,
          placeholder: "What must change before this passes?",
          onOk: async (v) => {
            const r = await ops.rejectGate(wo.id, g.id, ap.instance, v, undefined, ifm);
            if (r.ok) ui.toast(r.msg, "ok");
            return r;
          },
        }),
    });
  }
  void approveGate;
  // A station that failed repeatedly is parked in the Needs a person bay: retrying it is what that person is there for.
  if (wo.state === "failed" || wo.state === "blocked" || (wo.bay === "person" && wo.bayCause === "failed"))
    out.push({ key: "retry", label: `Retry ${stName(cat, stationId)}`, kind: "primary", icon: "refresh", id: "trv-retry", guard: stop ? no(stopWhy) : dec(wo, "sendback"), group: "main", onClick: () => void ops.retry(wo.id, undefined, ifm).then((r) => res(r)) });
  if (wo.bay) {
    let dU: TDecision = stop ? no(stopWhy) : dec(wo, "park");
    if (dU.allowed && wo.bay === "sechold" && !approveGate.allowed) dU = no(`Security hold can only be released by someone who may approve gates in this project.`);
    const back = wo.bayFrom || stationId;
    out.push({
      key: "unpark",
      label: page ? "Resume" : `Return to ${stName(cat, back)}`,
      kind: "primary",
      icon: "undo",
      id: "trv-unpark",
      guard: dU,
      group: "main",
      onClick: () => {
        const go = async (v: string) => {
          const r = await ops.unpark(wo.id, v, undefined, ifm);
          if (r.ok) ui.toast(page ? "Resumed" : r.msg, "ok");
          return r;
        };
        if (page) {
          void go("Resumed from the work order page.").then((r) => { if (!r.ok) ui.toast(r.msg, "error"); });
          return;
        }
        ui.reasonDialog({
          title: `Return ${wo.id} from ${bayLabel(cat, wo.bay)}`,
          kicker: "Bay",
          ok: "Return to belt",
          min: 3,
          placeholder: "What changed?",
          sub: `It goes back to ${stName(cat, back)}.`,
          onOk: go,
        });
      },
    });
  } else
    out.push({ key: "park", label: page ? "Park in a bay" : "Move to bay", icon: "st-park", id: "trv-park", guard: closed ? no(closedWhy) : stop ? no(stopWhy) : dec(wo, "park"), group: "move", onClick: () => void ui.open((close) => <ParkDialog woId={wo.id} onClose={close} />) });
  const first = wo.route.indexOf(stationId) <= 0;
  out.push(
    {
      key: "sendback",
      label: "Send back",
      icon: "undo",
      id: "trv-sendback",
      guard: closed ? no(closedWhy) : stop ? no(stopWhy) : wo.bay ? no(`Return it from ${bayLabel(cat, wo.bay)} first.`) : first ? no("Already at the first station on its route.") : dec(wo, "sendback"),
      group: "move",
      onClick: () => void ui.open((close) => <SendBackDialog woId={wo.id} onClose={close} />),
    },
    {
      key: "redo",
      label: `Redo ${stName(cat, stationId)}`,
      icon: "refresh",
      id: "trv-redo",
      guard: closed ? no(closedWhy) : stop ? no(stopWhy) : wo.bay ? no(`Return it from ${bayLabel(cat, wo.bay)} first.`) : dec(wo, "sendback"),
      group: "move",
      onClick: () => void ui.open((close) => <RedoDialog woId={wo.id} onClose={close} />),
    },
    { key: "reassign", label: "Reassign agent", icon: "swap", id: "trv-reassign", guard: closed ? no(closedWhy) : wo.bay ? no("Nobody staffs work in a bay.") : dec(wo, "reassign"), group: "inline", onClick: () => void ui.open((close) => <ReassignDialog woId={wo.id} onClose={close} />) },
    {
      key: "reclass",
      label: "Reclassify",
      icon: "tag",
      id: "trv-reclass",
      guard: closed ? no(closedWhy) : wo.station !== 0 || wo.bay ? no("Class can only change at Intake. Send it back to Intake first.") : stop ? no(stopWhy) : dec(wo, "classify"),
      group: "inline",
      onClick: () => void ui.open((close) => <ReclassifyDialog woId={wo.id} onClose={close} />),
    },
  );
  if (repo)
    out.push(
      repo.halted
        ? { key: "repo", label: `Resume ${repo.name}`, icon: "play", id: "trv-resume", guard: haltResume.pending ? null : haltResume, group: "more", onClick: () => void stops.resumeRepo(repo.id) }
        : { key: "repo", label: "Halt repo", kind: "andon", icon: "halt", id: "trv-halt", aria: `Halt ${repo.name} (andon)`, guard: haltD.pending ? null : haltD, group: "more", onClick: () => stops.haltRepo(repo.id, wo.project) },
    );
  out.push(
    wo.state === "killed"
      ? { key: "kill", label: `Restore ${wo.id}`, icon: "power", id: "trv-restore", guard: stop && stop.scope !== "wo" && stop.scope !== "workorder" ? no(`${stopWhy} Restore the ${stop.scope} first.`) : restoreD.pending ? null : restoreD, group: "more", onClick: () => stops.restore("workorder", wo.id) }
      : { key: "kill", label: "Kill work order", kind: "danger", icon: "st-kill", id: "trv-kill", guard: wo.state === "done" ? no(closedWhy) : killD.pending ? null : killD, group: "more", onClick: () => stops.kill("workorder", wo.id) },
  );
  void ok;
  return out;
}

const btn = (a: ActionSpec) => <Btn key={a.key} label={a.label} {...(a.kind ? { kind: a.kind } : {})} icon={a.icon} id={a.id} {...(a.aria ? { aria: a.aria } : {})} guard={a.guard} onClick={a.onClick} />;

/** The traveler drawer's action rows: what decides the work order first, then the rest. */
export function Actions({ wo }: { wo: TWo }) {
  const specs = useActionSpecs(wo);
  if (!specs) return null;
  const row1: ReactElement[] = [];
  for (const a of specs.filter((x) => x.group === "decide" || x.group === "main")) {
    row1.push(btn(a));
    if (a.why) row1.push(<p key={`${a.key}-why`} className="small muted trv-why" id="trv-approve-why" role="note">{a.why}</p>);
  }
  const row2 = specs.filter((x) => x.group !== "decide" && x.group !== "main").map(btn);
  return (
    <div className="trv-actions">
      {row1.length ? <div className="drawer-actions">{row1}</div> : null}
      <div className="drawer-actions trv-actions-2">{row2}</div>
    </div>
  );
}
