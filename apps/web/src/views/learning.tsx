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
import { useLearningFindings, useLearningProposals, useLearningSettings } from "../api/queries";
import { Btn, Tabs } from "../ui/primitives";
import { Page, Stats } from "../ui/cr";
import { useUrlState } from "./urlState";
import { Async, qState } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { dec } from "./mcp/kit";
import { FindingsTab } from "./learning/Findings";
import { ProposalsTab } from "./learning/Proposals";
import { takeLearningFocus } from "./learning/focus";

export { learningFocus } from "./learning/focus";

const TABS = ["findings", "proposals"];
const DAY = 86_400_000;

export default function LearningView() {
  const ui = useUI();
  const fq = useLearningFindings();
  const pq = useLearningProposals();
  const findings = fq.data ?? [];
  const proposals = pq.data ?? [];
  const settings = useLearningSettings().data;
  const perm = dec(useCan("learning.apply"));
  const [url, setUrl] = useUrlState({ tab: "findings", q: "", sig: "", sort: "", dir: "", st: "all" });
  const tab = TABS.includes(url.tab) ? url.tab : "findings";
  const [hi, setHi] = useState<string | null>(null);
  const [hiFinding, setHiFinding] = useState<string | null>(null);
  const setTab = (t: string): void => setUrl({ tab: t, q: "", sig: "", sort: "", dir: "" });

  useEffect(() => {
    const f = takeLearningFocus();
    if (!f) return;
    if (f.proposal) { setUrl({ tab: "proposals", st: "all" }); setHi(f.proposal); }
    else if (f.finding) { setUrl({ tab: "findings" }); setHiFinding(f.finding); }
    else if (f.tab) setUrl({ tab: f.tab });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const on = settings?.proposalsOn ?? false;
  const open = proposals.filter((lp) => lp.status === "proposed").length;
  const openFindings = findings.filter((f) => f.status === "open").length;
  const accepted30 = proposals.filter((lp) => (lp.status === "accepted" || lp.status === "verified") && (lp.appliedAt ?? lp.at) >= Date.now() - 30 * DAY).length;
  const focusProposal = (id: string): void => { setUrl({ tab: "proposals", st: "all" }); setHi(id); };

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
    ? <Async query={fq} what="learning findings" id="ln-findings">{() => <FindingsTab findings={findings} hi={hiFinding} onDrafted={focusProposal} proposalsOn={on} url={url} setUrl={setUrl} />}</Async>
    : <Async query={pq} what="learning proposals" id="ln-proposals">{() => <ProposalsTab proposals={proposals} hi={hi} />}</Async>;
  return (
    <div className="view-learning">
      <Page eyebrow="Workforce" title="Learning" sub="Agents notice patterns in rejections and overrides, then propose instruction changes. A person accepts or declines.">
        <div id="ln-stats">
          <Stats items={[
            { l: "Open findings", v: qState(fq, () => String(openFindings)), tone: "warn" },
            { l: "Proposals waiting", v: qState(pq, () => String(open)), tone: "agent" },
            { l: "Accepted, 30d", v: qState(pq, () => String(accepted30)), tone: "ok" },
            { l: "Avg eval lift", v: "n/a", tone: "info" },
          ]} />
        </div>
        <Tabs idPrefix="ln-tab" items={[{ id: "findings", label: "Findings" }, { id: "proposals", label: "Proposals", count: open }]} active={tab} onChange={(t) => { setTab(t); setHi(null); setHiFinding(null); }} />
        <div id="ln-tab-panel" role="tabpanel" className="ln-panel">{body}
          {tab === "proposals" && settings ? <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}><Btn label={on ? "Turn off proposals" : "Turn on proposals"} kind="ghost" small id="ln-switch" guard={perm} onClick={() => flip(!on)} /></div> : null}
        </div>
      </Page>
    </div>
  );
}
