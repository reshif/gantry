/**
 * Trust ladder (spec 8.7, 13.3). Port of legacy/js/views/trust.js against /api/v1/trust: earned autonomy per agent x work class x project (optionally repo), as the prototype's flat Ladder with
 * Level, Project and Agent filters; cell detail (evidence, history, the criteria for the next level, Change level, the matrix) in a drawer; promotion proposals, demotions with cause, and the Rules tab
 * (criteria per level, ceilings, the runtime switch for levels above L1 and the L2 spot-check rate). L4 is not grantable. A rate is shown with its count and "insufficient data" when small (spec 13.3).
 * Not ported, on purpose: the legacy "Simulate an incoming outcome" button. Outcomes are recorded for real, on shipped work, with an attribution.
 * The tab is in the URL (#trust/proposals); the ladder follows the project switcher (the eyebrow shows the project key), the other tabs stay factory-wide.
 */
import { useEffect } from "react";
import { useTrustCells } from "../api/queries";
import { useUI } from "../ui/overlay-context";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Empty, Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
import { Async } from "../ui/async";
import { DemotionsTab, PolicyTab, ProposalsTab } from "./trust/Tabs";
import { CellDrawer, LadderTab, useLadderProps } from "./trust/Ladder";
import { trustFocus, trustUi, useTrustUi, type CellOut } from "./trust/kit";
import { useScope, useTabParam } from "./tabparam";
import "../styles/views/trust.css";

const TABS = ["ladder", "proposals", "demotions", "rules"] as const;

export default function TrustView() {
  useTrustUi();
  const scope = useScope();
  const ui = useUI();
  const prefs = usePrefs();
  const [tab, setTab] = useTabParam("trust", TABS);
  const all = useTrustCells();
  const base = useLadderProps(null);
  const tr = all.data;
  const cells = (tr?.cells ?? []) as CellOut[];
  const proposals = tr?.proposals ?? [];
  const focus = (prefs as unknown as { trustFocus?: Parameters<typeof trustFocus>[0] | null }).trustFocus;
  useEffect(() => {
    if (!focus || !tr) return;
    const target = focus.cell ? cells.find((c) => c.id === focus.cell) : null;
    trustFocus(focus, cells, proposals);
    if (target) ui.drawer.open(`tr-cell:${target.id}`, (close) => <CellDrawer projectId={target.project} close={close} />);
    updatePrefs({ trustFocus: null } as never);
  }, [focus, tr]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!tr) return <div className="view view-trust"><ViewHead title="Trust" kicker={scope.kicker} /><Async query={all} what="trust levels" id="trust">{() => null}</Async></div>;
  if (!base) return <div className="view view-trust"><ViewHead title="Trust" kicker={scope.kicker} /><Empty title="No projects to show" text="You have no role on an active project." /></div>;
  const pending = proposals.filter((x) => x.status === "pending");
  const unattended = cells.filter((c) => c.level >= 3).length;
  const body = tab === "proposals" ? <ProposalsTab p={base} cells={cells} proposals={proposals} />
    : tab === "demotions" ? <DemotionsTab cells={cells} projects={base.projects} p={{ ...base, cells }} />
    : tab === "rules" ? <PolicyTab p={{ ...base, cells, ...({ ceilings: tr.ceilings, criteriaVersion: tr.criteriaVersion ?? 0 } as object) } as typeof base & { criteriaVersion: number }} cells={cells} projects={base.projects} />
    : <LadderTab cells={scope.id ? cells.filter((c) => c.project === scope.id) : cells} projects={base.projects} switchOn={base.switchOn} agentName={base.agentName} clsName={base.clsName} />;
  return (
    <div className="view view-trust">
      <ViewHead title="Trust" kicker={scope.kicker} sub="How much autonomy each agent has earned, per class of work and project." />
      <StatRow id="tr-stats">
        <Stat label="Cells" value={String(cells.length)} sub="agent × class × project" tone="info" />
        <Stat label="At L3 or above" value={String(unattended)} tone="done" />
        <Stat label="Proposals" value={String(pending.length)} sub="awaiting you" {...(pending.length ? { tone: "wait" as const } : {})} />
        <Stat label="Sample rate" value={`${tr.sampleRate}%`} sub="of autonomous work reviewed" />
      </StatRow>
      <Tabs idPrefix="tr-tab" items={[{ id: "ladder", label: "Ladder", count: cells.length }, { id: "proposals", label: "Proposals", count: pending.length }, { id: "demotions", label: "Demotions" }, { id: "rules", label: "Rules" }]} active={tab} onChange={(t) => { trustUi.hiProposal = null; setTab(t); }} />
      <div id="tr-tab-panel" role="tabpanel" className="tr-panel">{body}</div>
    </div>
  );
}
