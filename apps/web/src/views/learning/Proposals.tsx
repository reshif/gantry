/** Proposals tab: the status strip and one card per proposal, with accept, decline, verify and roll back. Each is a real command with its own refusal. */
import type { LearningFinding, LearningProposal } from "@gantry/domain";
import { fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { useLearningFindings, useLearningSettings } from "../../api/queries";
import { useMe } from "../../api/queries";
import { Avatar, Btn, Chip } from "../../ui/primitives";
import { Card } from "../../ui/cr";
import { useLn } from "./kit";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { dec } from "../mcp/kit";
import { VerifyDialog } from "./Dialogs";
import { KINDS, STATUS, useChangeLines } from "./kit";

const scopeOf = (lp: LearningProposal): { project: string } | undefined => {
  const p = (lp.change as { project?: unknown } | undefined)?.project;
  return typeof p === "string" ? { project: p } : undefined;
};
const verifyDue = (lp: LearningProposal): number | null => (lp.appliedAt && lp.windowDays ? lp.appliedAt + lp.windowDays * 86_400_000 : null);

export function ProposalsTab({ proposals, hi }: { proposals: LearningProposal[]; hi: string | null }) {
  return (
    <div className="ln-props stack">
      {proposals.length ? (
        <div className="stack ln-list">{proposals.map((lp) => <ProposalCard key={lp.id} lp={lp} hi={hi === lp.id} />)}</div>
      ) : (
        <div className="empty empty-state" id="ln-props-empty">
          <div className="empty-icon" aria-hidden="true"><Icon name="learn" /></div>
          <div className="empty-title">No proposals yet</div>
          <p>Agents propose instruction changes from findings. They appear here for a person to accept or decline.</p>
        </div>
      )}
    </div>
  );
}

function ProposalCard({ lp, hi }: { lp: LearningProposal; hi: boolean }) {
  const ui = useUI();
  const actor = useActors();
  const me = useMe();
  const findings = useLearningFindings().data ?? [];
  const settings = useLearningSettings().data;
  const f: LearningFinding | undefined = findings.find((x) => x.id === lp.finding);
  const perm = dec(useCan("learning.apply", scopeOf(lp) ?? {}));
  const off = settings && !settings.proposalsOn ? "Learning proposals are switched off. Turn them on first." : null;
  const mine = lp.owner === me?.person.id && (settings?.otherDeciders ?? 0) > 0 ? "You drafted this proposal, so someone else decides it where a second person can." : null;
  const last = lp.history[lp.history.length - 1];
  const due = verifyDue(lp);
  const early = lp.status === "accepted" && due && Date.now() < due ? `The window runs until ${fmt.istDate(due)}. It can be verified then.` : null;
  const act = [] as React.ReactNode[];
  if (lp.status === "proposed") {
    act.push(<Btn key="a" label="Accept change" kind="ok" id={`ln-accept-${lp.id}`} guard={perm} disabledReason={off ?? mine} onClick={() => { void ops.acceptLearning(lp.id).then((r) => ui.toast(r.ok ? (r.msg || "Accepted. A new agent version will run evals first.") : r.msg, r.ok ? "ok" : "error")); }} />);
    act.push(<Btn key="d" label="Decline" kind="danger" id={`ln-decline-${lp.id}`} guard={perm} disabledReason={off} onClick={() => ui.reasonDialog({
      title: `Decline ${lp.id}`, kicker: `Learning · ${KINDS[lp.kind]?.name ?? lp.kind}`, sub: `${lp.title}. Nothing changes; the finding stays open.`, label: "Reason (required)", ok: "Decline", kind: "danger", min: 4, guard: perm,
      onOk: async (t) => { const r = await ops.declineLearning(lp.id, t); if (r.ok) ui.toast(r.msg, "ok"); return r; },
    })} />);
  }
  if (lp.status === "accepted") act.push(<Btn key="v" label="Mark verified" id={`ln-verify-${lp.id}`} guard={perm} disabledReason={off ?? early} onClick={() => ui.open((close) => <VerifyDialog lp={lp} close={close} />)} />);
  if ((lp.status === "accepted" || lp.status === "verified") && lp.rollback?.available) {
    act.push(<Btn key="r" label="Roll back" id={`ln-rollback-${lp.id}`} guard={perm} disabledReason={off} onClick={() => ui.reasonDialog({
      title: `Roll back ${lp.id}`, kicker: `Learning · ${KINDS[lp.kind]?.name ?? lp.kind}`, sub: lp.rollback?.summary ?? "", label: "Reason (required)", ok: "Roll back", kind: "danger", min: 4, guard: perm,
      onOk: async (t) => { const r = await ops.rollbackLearning(lp.id, t); ui.toast(r.msg, r.ok ? "ok" : "error"); return r; },
    })} />);
  }
  const lines = useChangeLines(lp);
  return (
    <div id={`ln-prop-${lp.id}`} className={hi ? "is-hi" : ""}>
      <Card title={`${lp.id} \u00b7 ${lp.title}`} hint={`From finding ${lp.finding}`} cls={`ln-card is-${lp.status}`}>
        <div className="stack">
          <div className="row">
            {f?.agent ? <AgentWho id={f.agent} /> : null}
            <Chip text={STATUS[lp.status] ?? lp.status} cls={lp.status === "proposed" ? "agent" : lp.status === "declined" || lp.status === "rolled_back" ? "idle" : "ok"} />
            <Chip text="eval n/a" cls="plain idle" />
          </div>
          <pre className="code diff" style={{ padding: 8 }}>{lines.map((l, i) => <div key={i} className={l[0] === "+" ? "add" : "del"}>{l}</div>)}</pre>
          {act.length || last ? (
            <div className="row">
              {act}
              <span className="small muted grow">{last ? `${fmt.stamp(last.at)} \u00b7 ${actor(last.by).name}: ${last.text}` : ""}</span>
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function AgentWho({ id }: { id: string }) {
  const { agName } = useLn();
  return <span className="who"><Avatar id={id} size="sm" /><span>{agName(id)}</span></span>;
}
