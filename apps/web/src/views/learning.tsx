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
import { Btn, LockNote, Tabs, ViewHead } from "../ui/primitives";
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
  const findings = useLearningFindings().data ?? [];
  const proposals = useLearningProposals().data ?? [];
  const signals = useLearningSignals(30).data ?? [];
  const settings = useLearningSettings().data;
  const perm = dec(useCan("learning.apply"));
  const [tab, setTab] = useState("proposals");
  const [status, setStatus] = useState("open");
  const [hi, setHi] = useState<string | null>(null);
  const [hiFinding, setHiFinding] = useState<string | null>(null);

  useEffect(() => {
    const f = takeLearningFocus();
    if (!f) return;
    if (f.proposal) { setTab("proposals"); setHi(f.proposal); setStatus("all"); }
    else if (f.finding) { setTab("findings"); setHiFinding(f.finding); }
    else if (f.tab) setTab(f.tab);
  }, []);

  const on = settings?.proposalsOn ?? false;
  const open = proposals.filter((lp) => lp.status === "proposed").length;
  const openFindings = findings.filter((f) => f.status === "open").length;
  const week = signals.filter((x) => x.at >= Date.now() - 7 * 86_400_000).length;
  const focusProposal = (id: string): void => { setTab("proposals"); setHi(id); setStatus("all"); };
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
    ? <FindingsTab findings={findings} proposals={proposals} hi={hiFinding} onFocusProposal={focusProposal} onDrafted={focusProposal} proposalsOn={on} />
    : tab === "signals" ? <SignalsTab signals={signals} />
    : <ProposalsTab proposals={proposals} status={status} setStatus={setStatus} hi={hi} onFocusFinding={focusFinding} />;
  return (
    <div className="view view-learning">
      <ViewHead
        kicker="Agents · Sheet 18" title="Learning"
        sub="What the factory learns from its own outcomes: repeated rejections, send-backs, reverts and misses become proposed changes to skills, guidelines, evals, guardrails, approver rules and routes."
        meta={[["Open findings", String(openFindings)], ["To review", String(open)], ["Applied", String(proposals.filter((lp) => lp.status === "accepted").length)], ["Verified", String(proposals.filter((lp) => lp.status === "verified").length)], ["Signals 7d", String(week)]]}
        actions={settings ? <Btn label={on ? "Turn off proposals" : "Turn on proposals"} kind="ghost" small icon={on ? "x" : "check"} id="ln-switch" guard={perm} onClick={() => flip(!on)} /> : undefined} />
      {perm.allowed ? null : <LockNote decision={perm} what="Applying learning proposals" />}
      {settings && !on ? (
        <div className="callout callout-warn" role="note" id="ln-off">
          <Icon name="alert" />
          <span>Learning proposals are switched off. Findings and signals keep being recorded from every work order; nothing can be drafted, accepted or verified until a person turns proposals on.</span>
        </div>
      ) : null}
      <Tabs idPrefix="ln-tab" items={[{ id: "proposals", label: "Proposals", count: open }, { id: "findings", label: "Findings", count: openFindings }, { id: "signals", label: "Signals" }]} active={tab} onChange={(t) => { setTab(t); setHi(null); setHiFinding(null); }} />
      <div id="ln-tab-panel" role="tabpanel" className="ln-panel">{body}</div>
    </div>
  );
}
