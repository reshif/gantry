/**
 * Learning loop (spec 8.7, 13.4). Port of legacy/js/views/learning.js against /api/v1/learning/*: outcomes come back as proposed improvements. Signals from the work order
 * records (gate rejections, send-backs, reverts, incidents, classification overrides, intake misses) and eval runs are grouped into findings; a person drafts a proposal
 * from a finding, a second person accepts it (the change is applied through its ordinary command and can be rolled back), and it is verified against a metric and window
 * declared before the change. Proposals are switched off in a new install.
 * Not ported, on purpose: "Draft with Claude" (no model call from this screen; "Fill in from finding" writes a plain starting text) and every "simulated" label.
 */
import { useEffect, useState } from "react";
import { useCan } from "../api/can";
import { ops } from "../api/ops";
import { useLearningFindings, useLearningProposals, useLearningSettings, useLearningSignals } from "../api/queries";
import { Btn, LockNote, Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
import { useTabParam } from "./tabparam";
import { Async, qState } from "../ui/async";
import { Icon } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";
import { dec } from "./mcp/kit";
import { FindingsTab } from "./learning/Findings";
import { ProposalsTab } from "./learning/Proposals";
import { SignalsTab } from "./learning/Signals";
import { takeLearningFocus } from "./learning/focus";

export { learningFocus } from "./learning/focus";

export default function LearningView() {
  const ui = useUI();
  const fq = useLearningFindings();
  const pq = useLearningProposals();
  const sq = useLearningSignals(30);
  const findings = fq.data ?? [];
  const proposals = pq.data ?? [];
  const signals = sq.data ?? [];
  const settings = useLearningSettings().data;
  const perm = dec(useCan("learning.apply"));
  const [tab, setTabUrl] = useTabParam("learning", ["proposals", "findings", "signals"] as const);
  const setTab = (t: string): void => setTabUrl(t);
  const [hi, setHi] = useState<string | null>(null);
  const [hiFinding, setHiFinding] = useState<string | null>(null);

  useEffect(() => {
    const f = takeLearningFocus();
    if (!f) return;
    if (f.proposal) { setTab("proposals"); setHi(f.proposal); }
    else if (f.finding) { setTab("findings"); setHiFinding(f.finding); }
    else if (f.tab) setTab(f.tab);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const on = settings?.proposalsOn ?? false;
  const open = proposals.filter((lp) => lp.status === "proposed").length;
  const openFindings = findings.filter((f) => f.status === "open").length;
  const adopted = proposals.filter((lp) => lp.status === "accepted" || lp.status === "verified").length;
  const events = findings.reduce((a, f) => a + f.count, 0);
  const focusProposal = (id: string): void => { setTab("proposals"); setHi(id); };
  const focusFinding = (id: string): void => { setTab("findings"); setHiFinding(id); };

  const flip = (next: boolean): void => {
    if (!next) {
      void ops.setLearningSwitch(false).then((r) => ui.toast(r.msg, r.ok ? "ok" : "error"));
      return;
    }
    ui.reasonDialog({
      title: "Turn on learning proposals", kicker: "Learning · switch", sub: "Off in a new install. Once on, a person can draft proposals from findings, and a second person can accept them: the change is applied through its own command and can be rolled back.",
      label: "Reason (required)", ok: "Turn on", min: 4, guard: perm,
      onOk: async (t) => { const r = await ops.setLearningSwitch(true, t); ui.toast(r.msg, r.ok ? "ok" : "error"); return r; },
    });
  };

  const body = tab === "findings"
    ? <Async query={fq} what="learning findings" id="ln-findings">{() => <FindingsTab findings={findings} proposals={proposals} hi={hiFinding} onFocusProposal={focusProposal} onDrafted={focusProposal} proposalsOn={on} />}</Async>
    : tab === "signals" ? <Async query={sq} what="learning signals" id="ln-signals">{() => <SignalsTab signals={signals} findings={findings} />}</Async>
    : <Async query={pq} what="learning proposals" id="ln-proposals">{() => <ProposalsTab proposals={proposals} hi={hi} onFocusFinding={focusFinding} />}</Async>;
  return (
    <div className="view view-learning">
      <ViewHead title="Learning" kicker="All lines" sub="The factory reads its own rejections and overrides, then proposes how to improve. People decide." />
      <StatRow id="ln-stats">
        <Stat label="Open findings" value={qState(fq, () => String(openFindings))} tone="wait" />
        <Stat label="To review" value={qState(pq, () => String(open))} sub="proposals" tone="info" />
        <Stat label="Adopted" value={qState(pq, () => String(adopted))} tone="done" />
        <Stat label="Signals" value={qState(fq, () => String(events))} sub="events seen" />
      </StatRow>
      {perm.allowed ? null : <LockNote decision={perm} what="Applying learning proposals" />}
      {settings && !on ? (
        <div className="callout callout-warn" role="note" id="ln-off">
          <Icon name="alert" />
          <span>Learning proposals are switched off. Findings and signals keep being recorded from every work order; nothing can be drafted, accepted or verified until a person turns proposals on.</span>
        </div>
      ) : null}
      <Tabs idPrefix="ln-tab" items={[{ id: "proposals", label: "Proposals", count: open }, { id: "findings", label: "Findings", count: openFindings }, { id: "signals", label: "Signals" }]} active={tab} onChange={(t) => { setTab(t); setHi(null); setHiFinding(null); }} />
      <div id="ln-tab-panel" role="tabpanel" className="ln-panel">{body}</div>
      {settings && tab === "proposals" ? (
        <div className="row ln-switch-row">
          <span className="small muted">{on ? "Learning proposals are on." : "Learning proposals are off."}</span>
          <Btn label={on ? "Turn off proposals" : "Turn on proposals"} kind="ghost" small icon={on ? "pause" : "play"} id="ln-switch" guard={perm} onClick={() => flip(!on)} />
        </div>
      ) : null}
    </div>
  );
}
