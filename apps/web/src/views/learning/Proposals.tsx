/** Proposals tab: the status strip and one card per proposal, with accept, decline, verify and roll back. Each is a real command with its own refusal. */
import type { LearningProposal } from "@gantry/domain";
import { fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { useLearningSettings, useSkills } from "../../api/queries";
import { useMe } from "../../api/queries";
import { Btn, Chip, Empty, Panel } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { dec } from "../mcp/kit";
import { AcceptDialog, VerifyDialog } from "./Dialogs";
import { ChangeView, KINDS, PlainDiff, STATUS } from "./kit";

const scopeOf = (lp: LearningProposal): { project: string } | undefined => {
  const p = (lp.change as { project?: unknown } | undefined)?.project;
  return typeof p === "string" ? { project: p } : undefined;
};
const verifyDue = (lp: LearningProposal): number | null => (lp.appliedAt && lp.windowDays ? lp.appliedAt + lp.windowDays * 86_400_000 : null);

/** The prototype's Proposals: each open proposal is its own panel (kind chip, expected outcome, the change as a diff, Adopt and Decline); decided ones are a flat list with their status and the follow-up commands (verify, roll back). */
export function ProposalsTab({ proposals, hi, onFocusFinding }: {
  proposals: LearningProposal[];
  hi: string | null;
  onFocusFinding: (id: string) => void;
}) {
  const all = proposals.slice();
  const open = all.filter((lp) => lp.status === "proposed");
  const decided = all.filter((lp) => lp.status !== "proposed").reverse();
  return (
    <div className="ln-props stack">
      {open.length ? (
        <div className="stack">{open.map((lp) => <ProposalPanel key={lp.id} lp={lp} hi={hi === lp.id} onFocusFinding={onFocusFinding} />)}</div>
      ) : <Panel><Empty id="ln-props-empty" title="No proposals to review" text="Gantry proposes changes when a pattern repeats." /></Panel>}
      {decided.length ? (
        <Panel title="Decided" flush>
          <ul className="list">{decided.map((lp) => <DecidedRow key={lp.id} lp={lp} hi={hi === lp.id} onFocusFinding={onFocusFinding} />)}</ul>
        </Panel>
      ) : null}
    </div>
  );
}

/** Adopt, Decline, Mark verified, Roll back and the skill link: each a real command with its own refusal and reason. */
function useProposalActions(lp: LearningProposal): React.ReactNode[] {
  const ui = useUI();
  const settings = useLearningSettings().data;
  const me = useMe();
  const skills = useSkills().data ?? [];
  const perm = dec(useCan("learning.apply", scopeOf(lp) ?? {}));
  const off = settings && !settings.proposalsOn ? "Learning proposals are switched off. Turn them on first." : null;
  const mine = lp.owner === me?.person.id && (settings?.otherDeciders ?? 0) > 0 ? "You drafted this proposal, so someone else decides it where a second person can." : null;
  const sk = lp.kind === "skill" ? skills.find((s) => s.id === (lp.change as { skill?: string }).skill) : undefined;
  const due = verifyDue(lp);
  const early = lp.status === "accepted" && due && Date.now() < due ? `The window runs until ${fmt.istDate(due)}. It can be verified then.` : null;
  const act = [] as React.ReactNode[];
  if (lp.status === "proposed") {
    act.push(<Btn key="a" label="Adopt" small kind="primary" id={`ln-accept-${lp.id}`} guard={perm} disabledReason={off ?? mine} onClick={() => ui.open((close) => <AcceptDialog lp={lp} close={close} />)} />);
    act.push(<Btn key="d" label="Decline" small id={`ln-decline-${lp.id}`} guard={perm} disabledReason={off} onClick={() => ui.reasonDialog({
      title: `Decline: ${lp.title}`, kicker: `Learning · ${KINDS[lp.kind]?.name ?? lp.kind}`, sub: "Nothing changes; the finding stays open.", label: "Why decline? (required)", ok: "Decline", kind: "danger", min: 6, guard: perm,
      onOk: async (t) => { const r = await ops.declineLearning(lp.id, t); if (r.ok) ui.toast(r.msg, "ok"); return r; },
    })} />);
  }
  if (lp.status === "accepted") act.push(<Btn key="v" label="Mark verified" small icon="eval" id={`ln-verify-${lp.id}`} guard={perm} disabledReason={off ?? early} onClick={() => ui.open((close) => <VerifyDialog lp={lp} close={close} />)} />);
  if ((lp.status === "accepted" || lp.status === "verified") && lp.rollback?.available) {
    act.push(<Btn key="r" label="Roll back" small icon="undo" id={`ln-rollback-${lp.id}`} guard={perm} disabledReason={off} onClick={() => ui.reasonDialog({
      title: `Roll back ${lp.id}`, kicker: `Learning · ${KINDS[lp.kind]?.name ?? lp.kind}`, sub: lp.rollback?.summary ?? "", label: "Reason (required)", ok: "Roll back", kind: "danger", min: 4, guard: perm,
      onOk: async (t) => { const r = await ops.rollbackLearning(lp.id, t); ui.toast(r.msg, r.ok ? "ok" : "error"); return r; },
    })} />);
  }
  if (lp.kind === "skill" && lp.status !== "proposed" && lp.status !== "declined" && sk) {
    act.push(<a key="s" href="#skills" className="btn btn-sm btn-ghost" id={`ln-open-skill-${lp.id}`} onClick={(e) => { e.preventDefault(); navigate("skills"); }}><Icon name="skill" /><span>{`Open ${sk.name} v${sk.version}`}</span></a>);
  }
  return act;
}

function ProposalPanel({ lp, hi }: { lp: LearningProposal; hi: boolean; onFocusFinding: (id: string) => void }) {
  const actor = useActors();
  const act = useProposalActions(lp);
  return (
    <Panel title={lp.title} id={`ln-prop-${lp.id}`} cls={hi ? "is-hi" : ""}>
      <div className="stack">
        <div className="row"><Chip text={lp.kind} cls="info" /><span className="small muted">{`from ${lp.finding} · owner ${actor(lp.owner).name}`}</span></div>
        <p>{lp.expected || "–"}</p>
        {lp.kind === "skill" && (lp.change as { before?: string }).before != null ? <PlainDiff lp={lp} /> : <ChangeView lp={lp} />}
        <div className="row">{act}</div>
      </div>
    </Panel>
  );
}

function DecidedRow({ lp, hi, onFocusFinding }: { lp: LearningProposal; hi: boolean; onFocusFinding: (id: string) => void }) {
  const actor = useActors();
  const act = useProposalActions(lp);
  const last = lp.history[lp.history.length - 1];
  const tone = lp.status === "accepted" || lp.status === "verified" ? "ok" : "plain";
  return (
    <li id={`ln-prop-${lp.id}`} className={hi ? "is-hi" : undefined}>
      <div className="grow">
        <div className="row"><b>{lp.title}</b><button type="button" className="linkish small" id={`ln-goto-f-${lp.id}`} onClick={() => onFocusFinding(lp.finding)}>{lp.finding}</button></div>
        <div className="small muted">{last ? `${fmt.stamp(last.at)} · ${actor(last.by).name}: ${last.text}` : ""}{lp.reason ? ` · ${lp.reason}` : ""}</div>
      </div>
      <Chip text={STATUS[lp.status] ?? lp.status} cls={tone} />
      {act.length ? <span className="row ln-acts">{act}</span> : null}
    </li>
  );
}
