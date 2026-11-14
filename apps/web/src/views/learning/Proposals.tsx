/** Proposals tab: the status strip and one card per proposal, with accept, decline, verify and roll back. Each is a real command with its own refusal. */
import { useState } from "react";
import type { LearningFinding, LearningProposal } from "@gantry/domain";
import { fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { useLearningFindings, useLearningSettings, useSkills } from "../../api/queries";
import { useMe } from "../../api/queries";
import { Btn } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { dec } from "../mcp/kit";
import { AcceptDialog, VerifyDialog } from "./Dialogs";
import { ChangeView, ChipList, KINDS, Pipeline, sigName } from "./kit";

const scopeOf = (lp: LearningProposal): { project: string } | undefined => {
  const p = (lp.change as { project?: unknown } | undefined)?.project;
  return typeof p === "string" ? { project: p } : undefined;
};
const verifyDue = (lp: LearningProposal): number | null => (lp.appliedAt && lp.windowDays ? lp.appliedAt + lp.windowDays * 86_400_000 : null);

export function ProposalsTab({ proposals, status, setStatus, hi, onFocusFinding }: {
  proposals: LearningProposal[];
  status: string;
  setStatus: (s: string) => void;
  hi: string | null;
  onFocusFinding: (id: string) => void;
}) {
  const all = proposals.slice().reverse();
  const counts: Record<string, number> = { open: 0, accepted: 0, verified: 0, declined: 0 };
  for (const lp of all) {
    const k = lp.status === "proposed" ? "open" : lp.status;
    if (k in counts) counts[k]!++;
  }
  const shown = all.filter((lp) => status === "all" || (status === "open" ? lp.status === "proposed" : lp.status === status));
  const items: Array<[string, string]> = [["open", "Proposed"], ["accepted", "Accepted and applied"], ["verified", "Verified"], ["declined", "Declined"]];
  return (
    <div className="ln-props">
      <ol className="ln-strip" aria-label="Proposals by status">
        {items.map(([k, label]) => (
          <li key={k}>
            <button type="button" className={`ln-strip-b${status === k ? " is-on" : ""}`} id={`ln-st-${k}`} aria-pressed={status === k ? "true" : "false"} onClick={() => setStatus(k)}>
              <span className="ln-strip-n">{String(counts[k])}</span><span>{label}</span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" className={`ln-strip-b${status === "all" ? " is-on" : ""}`} id="ln-st-all" aria-pressed={status === "all" ? "true" : "false"} onClick={() => setStatus("all")}>
            <span className="ln-strip-n">{String(all.length)}</span><span>All</span>
          </button>
        </li>
      </ol>
      {shown.length ? (
        <ul className="ln-list">{shown.map((lp) => <ProposalCard key={lp.id} lp={lp} hi={hi === lp.id} onFocusFinding={onFocusFinding} />)}</ul>
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
    act.push(<Btn key="a" label="Accept and apply" small kind="primary" icon="check" id={`ln-accept-${lp.id}`} guard={perm} disabledReason={off ?? mine} onClick={() => ui.open((close) => <AcceptDialog lp={lp} close={close} />)} />);
    act.push(<Btn key="d" label="Decline" small icon="x" id={`ln-decline-${lp.id}`} guard={perm} disabledReason={off} onClick={() => ui.reasonDialog({
      title: `Decline ${lp.id}`, kicker: `Learning · ${KINDS[lp.kind]?.name ?? lp.kind}`, sub: `${lp.title}. Nothing changes; the finding stays open.`, label: "Reason (required)", ok: "Decline", kind: "danger", min: 4, guard: perm,
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
  const kind = KINDS[lp.kind] ?? { name: lp.kind, icon: "dots" };
  const m = lp.metric;
  return (
    <li className={`panel ln-card is-${lp.status}${hi ? " is-hi" : ""}`} id={`ln-prop-${lp.id}`}>
      <div className="ln-card-top">
        <span className="mono strong">{lp.id}</span>
        <span className="chip ln-kind"><Icon name={kind.icon} />{kind.name}</span>
        <h3 className="ln-title">{lp.title}</h3>
      </div>
      <Pipeline lp={lp} />
      <div className="ln-card-grid">
        <div className="ln-change"><div className="kicker">Change</div><ChangeView lp={lp} /></div>
        <dl className="ln-kv">
          <div><dt>Expected effect</dt><dd>{lp.expected || "–"}</dd></div>
          {m && lp.windowDays ? <div><dt>Verified when</dt><dd>{`At most ${m.target} ${sigName(m.signal)} signal${m.target === 1 ? "" : "s"} in the ${lp.windowDays} days after it is applied${lp.baseline ? ` (before: ${lp.baseline.count} in ${lp.windowDays} days)` : ""}`}</dd></div> : null}
          {lp.verification ? <div><dt>Measured</dt><dd>{`${lp.verification.measured} signal${lp.verification.measured === 1 ? "" : "s"}, target at most ${lp.verification.target}`}</dd></div> : null}
          <div><dt>Owner</dt><dd>{actor(lp.owner).name}</dd></div>
          <div><dt>From finding</dt><dd>{f ? <button type="button" className="linkish" id={`ln-goto-f-${lp.id}`} onClick={() => onFocusFinding(f.id)}>{`${f.id} ${f.title}`}</button> : lp.finding}</dd></div>
          {f ? <div><dt>{`Evidence (${f.evidence.length})`}</dt><dd><ChipList ids={f.evidence} max={6} project={f.project} /></dd></div> : null}
          {lp.status === "accepted" || lp.status === "verified" ? <div><dt>Rollback</dt><dd>{lp.rollback?.summary ?? "–"}</dd></div> : null}
          {lp.status === "declined" && lp.reason ? <div><dt>Declined because</dt><dd>{lp.reason}</dd></div> : null}
          {lp.status === "rolled_back" && lp.reason ? <div><dt>Rolled back because</dt><dd>{lp.reason}</dd></div> : null}
        </dl>
      </div>
      <div className="ln-card-foot">
        <span className="small muted">{last ? `${fmt.stamp(last.at)} · ${actor(last.by).name}: ${last.text}` : ""}</span>
        {act.length ? <span className="ln-acts">{act}</span> : null}
      </div>
    </li>
  );
}

