/** Proposals tab: the status strip and one card per proposal, with accept, decline, verify and roll back. Each is a real command with its own refusal. */
import type { LearningFinding, LearningProposal } from "@gantry/domain";
import { fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { useLearningFindings, useLearningSettings, useSkills } from "../../api/queries";
import { useMe } from "../../api/queries";
import { Avatar, Btn, Chip, Segmented } from "../../ui/primitives";
import { Card } from "../../ui/cr";
import { useLn } from "./kit";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { dec } from "../mcp/kit";
import { AcceptDialog, VerifyDialog } from "./Dialogs";
import { ChangeView, ChipList, KINDS, STATUS, sigName } from "./kit";

const scopeOf = (lp: LearningProposal): { project: string } | undefined => {
  const p = (lp.change as { project?: unknown } | undefined)?.project;
  return typeof p === "string" ? { project: p } : undefined;
};
const verifyDue = (lp: LearningProposal): number | null => (lp.appliedAt && lp.windowDays ? lp.appliedAt + lp.windowDays * 86_400_000 : null);

export function ProposalsTab({ proposals, status, setStatus, hi, onFocusFinding, control }: {
  proposals: LearningProposal[];
  status: string;
  setStatus: (s: string) => void;
  hi: string | null;
  onFocusFinding: (id: string) => void;
  control?: React.ReactNode;
}) {
  const all = proposals.slice().reverse();
  const counts: Record<string, number> = { open: 0, accepted: 0, verified: 0, declined: 0 };
  for (const lp of all) {
    const k = lp.status === "proposed" ? "open" : lp.status;
    if (k in counts) counts[k]!++;
  }
  const shown = all.filter((lp) => status === "all" || (status === "open" ? lp.status === "proposed" : lp.status === status));
  const items = [{ id: "all", label: `All (${all.length})` }, { id: "open", label: `Proposed (${counts.open})` }, { id: "accepted", label: `Accepted (${counts.accepted})` }, { id: "verified", label: `Verified (${counts.verified})` }, { id: "declined", label: `Declined (${counts.declined})` }];
  return (
    <div className="ln-props stack">
      {control}
      <Segmented name="ln-st" items={items} value={status} onChange={setStatus} label="Show proposals" />
      {shown.length ? (
        <div className="stack ln-list">{shown.map((lp) => <ProposalCard key={lp.id} lp={lp} hi={hi === lp.id} onFocusFinding={onFocusFinding} />)}</div>
      ) : (
        <div className="empty empty-state" id="ln-props-empty">
          <div className="empty-icon" aria-hidden="true"><Icon name="learn" /></div>
          <div className="empty-title">Nothing here</div>
          <p>{status === "open" ? "No proposals are waiting. Draft one from a finding." : "No proposals with this status."}</p>
        </div>
      )}
    </div>
  );
}

function ProposalCard({ lp, hi, onFocusFinding }: { lp: LearningProposal; hi: boolean; onFocusFinding: (id: string) => void }) {
  const ui = useUI();
  const actor = useActors();
  const me = useMe();
  const findings = useLearningFindings().data ?? [];
  const settings = useLearningSettings().data;
  const skills = useSkills().data ?? [];
  const f: LearningFinding | undefined = findings.find((x) => x.id === lp.finding);
  const perm = dec(useCan("learning.apply", scopeOf(lp) ?? {}));
  const off = settings && !settings.proposalsOn ? "Learning proposals are switched off. Turn them on first." : null;
  const mine = lp.owner === me?.person.id && (settings?.otherDeciders ?? 0) > 0 ? "You drafted this proposal, so someone else decides it where a second person can." : null;
  const last = lp.history[lp.history.length - 1];
  const sk = lp.kind === "skill" ? skills.find((s) => s.id === (lp.change as { skill?: string }).skill) : undefined;
  const due = verifyDue(lp);
  const early = lp.status === "accepted" && due && Date.now() < due ? `The window runs until ${fmt.istDate(due)}. It can be verified then.` : null;
  const act = [] as React.ReactNode[];
  if (lp.status === "proposed") {
    act.push(<Btn key="a" label="Accept change" kind="ok" icon="check" id={`ln-accept-${lp.id}`} guard={perm} disabledReason={off ?? mine} onClick={() => ui.open((close) => <AcceptDialog lp={lp} close={close} />)} />);
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
  if (lp.kind === "skill" && lp.status !== "proposed" && lp.status !== "declined" && sk) {
    act.push(<a key="s" href="#skills" className="btn btn-sm btn-ghost" id={`ln-open-skill-${lp.id}`} onClick={(e) => { e.preventDefault(); navigate("skills"); }}><Icon name="skill" /><span>{`Open ${sk.name} v${sk.version}`}</span></a>);
  }
  const m = lp.metric;
  const lift = lp.verification ? <Chip text={`signals ${lp.verification.baseline ?? "?"} \u2192 ${lp.verification.measured}`} cls="plain ok" /> : <Chip text="eval lift not available" cls="plain idle" />;
  return (
    <div id={`ln-prop-${lp.id}`} className={hi ? "is-hi" : ""}>
      <Card title={`${lp.id} \u00b7 ${lp.title}`} hint={`From finding ${lp.finding}`} cls={`ln-card is-${lp.status}`}>
        <div className="stack">
          <div className="row">
            {f?.agent ? <AgentWho id={f.agent} /> : null}
            <Chip text={STATUS[lp.status] ?? lp.status} cls={lp.status === "proposed" ? "warn" : lp.status === "declined" || lp.status === "rolled_back" ? "idle" : "ok"} />
            <Chip text={(KINDS[lp.kind] ?? { name: lp.kind }).name} cls="plain agent" />
            {lift}
          </div>
          <div className="ln-change"><ChangeView lp={lp} /></div>
          <dl className="ln-kv">
            <div><dt>Expected effect</dt><dd>{lp.expected || "\u2013"}</dd></div>
            {m && lp.windowDays ? <div><dt>Verified when</dt><dd>{`At most ${m.target} ${sigName(m.signal)} signal${m.target === 1 ? "" : "s"} in the ${lp.windowDays} days after it is applied${lp.baseline ? ` (before: ${lp.baseline.count} in ${lp.windowDays} days)` : ""}`}</dd></div> : null}
            {lp.verification ? <div><dt>Measured</dt><dd>{`${lp.verification.measured} signal${lp.verification.measured === 1 ? "" : "s"}, target at most ${lp.verification.target}`}</dd></div> : null}
            <div><dt>Owner</dt><dd>{actor(lp.owner).name}</dd></div>
            <div><dt>From finding</dt><dd>{f ? <button type="button" className="linkish" id={`ln-goto-f-${lp.id}`} onClick={() => onFocusFinding(f.id)}>{`${f.id} ${f.title}`}</button> : lp.finding}</dd></div>
            {f ? <div><dt>{`Evidence (${f.evidence.length})`}</dt><dd><ChipList ids={f.evidence} max={6} project={f.project} /></dd></div> : null}
            {lp.status === "accepted" || lp.status === "verified" ? <div><dt>Rollback</dt><dd>{lp.rollback?.summary ?? "\u2013"}</dd></div> : null}
            {lp.status === "declined" && lp.reason ? <div><dt>Declined because</dt><dd>{lp.reason}</dd></div> : null}
            {lp.status === "rolled_back" && lp.reason ? <div><dt>Rolled back because</dt><dd>{lp.reason}</dd></div> : null}
          </dl>
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
