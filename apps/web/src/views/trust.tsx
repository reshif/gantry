/**
 * Trust ladder (spec 8.7, 13.3). Port of legacy/js/views/trust.js against /api/v1/trust: earned autonomy per agent x work class x project (optionally repo), the ladder matrix with level,
 * evidence count and ceiling marker per cell, cell detail with evidence, history and the criteria for the next level, promotion proposals, demotions with cause, ceilings, versioned
 * promotion criteria, the L2 spot-check rate, and the runtime switch for levels above L1 (off in a new install). L4 is not grantable. A rate is shown with its count and "insufficient
 * data" when small (spec 13.3). Not ported, on purpose: the legacy "Simulate an incoming outcome" button. Outcomes are recorded for real, on shipped work, with an attribution.
 */
import { useEffect, useMemo } from "react";
import { useAgents, useProjects, useTrustCells } from "../api/queries";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Empty, Tabs, ViewHead } from "../ui/primitives";
import { DemotionsTab, PolicyTab, ProposalsTab } from "./trust/Tabs";
import { LadderTab, type LadderProps } from "./trust/Ladder";
import { rerender, trustFocus, trustUi, useTrustUi, type CellOut, type TrustTab } from "./trust/kit";
import { useCatalog } from "./projects/kit";
import type { Project } from "@gantry/domain";

const DAY = 86_400_000;

export default function TrustView() {
  useTrustUi();
  const prefs = usePrefs();
  const cat = useCatalog();
  const projects = ((useProjects().data ?? []) as Project[]).filter((p) => p.status !== "archived");
  const agents = useAgents().data ?? [];
  const all = useTrustCells();
  const project = (trustUi.project && projects.some((p) => p.id === trustUi.project) ? trustUi.project : null) ?? (prefs.project && projects.some((p) => p.id === prefs.project) ? prefs.project : null) ?? projects[0]?.id ?? null;
  if (project !== trustUi.project) trustUi.project = project;
  const lad = useTrustCells(trustUi.tab === "ladder" ? project : null);
  const tr = all.data;
  const cells = (tr?.cells ?? []) as CellOut[];
  const proposals = tr?.proposals ?? [];
  const focus = (prefs as unknown as { trustFocus?: Parameters<typeof trustFocus>[0] | null }).trustFocus;
  useEffect(() => {
    if (!focus || !tr) return;
    trustFocus(focus, cells, proposals);
    updatePrefs({ trustFocus: null } as never);
  }, [focus, tr]); // eslint-disable-line react-hooks/exhaustive-deps
  const agentName = useMemo(() => (id: string) => agents.find((a) => a.id === id)?.name ?? id, [agents]);
  const clsName = useMemo(() => (id: string) => cat?.classes.find((c) => c.id === id)?.name ?? id, [cat]);
  if (!projects.length) return <div className="view view-trust"><ViewHead title="Trust" /><Empty title="No projects to show" text="You have no role on an active project." /></div>;
  if (!tr || !cat) return <div className="view view-trust"><ViewHead title="Trust" /><div className="skeleton" aria-busy="true" /></div>;
  const proj = projects.find((p) => p.id === project)!;
  const pending = proposals.filter((x) => x.status === "pending");
  const saved = pending.reduce((t, x) => t + (x.savedPerWeek || 0), 0);
  const dem7 = cells.reduce((n, c) => n + (c.history || []).filter((e) => (e.kind === "demote" || (e.kind === "grant" && e.from != null && e.to < e.from)) && e.at >= Date.now() - 7 * DAY).length, 0);
  const cov = Object.values(tr.coverage ?? {}).reduce((a, c) => ({ total: a.total + c.total, auto: a.auto + c.auto }), { total: 0, auto: 0 });
  const unattended = cells.filter((c) => c.level >= 3).length;
  const ladderCells = (lad.data?.cells ?? cells.filter((c) => c.project === project)) as CellOut[];
  const base: LadderProps = {
    cat, project: proj, projects, cells: ladderCells.filter((c) => c.project === project), proposals, switchOn: tr.levelsAboveL1 === true, criteria: tr.criteria, sampleRate: tr.sampleRate,
    coverage: tr.coverage?.[proj.id] ?? { total: 0, auto: 0 }, agentName, clsName,
  };
  const tab = trustUi.tab as TrustTab;
  const tabs = [{ id: "ladder", label: "Ladder" }, { id: "proposals", label: "Proposals", count: pending.length }, { id: "demotions", label: "Demotions", count: dem7 }, { id: "policy", label: "Ceilings and criteria" }];
  const body = tab === "proposals" ? <ProposalsTab p={base} cells={cells} proposals={proposals} />
    : tab === "demotions" ? <DemotionsTab cells={cells} projects={projects} p={{ ...base, cells }} />
    : tab === "policy" ? <PolicyTab p={{ ...base, cells, ...({ ceilings: tr.ceilings, criteriaVersion: tr.criteriaVersion ?? 0 } as object) } as LadderProps & { criteriaVersion: number }} cells={cells} projects={projects} />
    : <LadderTab p={base} />;
  return (
    <div className="view view-trust">
      <ViewHead title="Trust" sub="Earned autonomy. Each agent earns a level per work class and project from evidence; people grant it, and regressions take it away automatically. L0 and L1 are enforced; higher levels are off until switched on."
        meta={[["Cells", String(cells.length)], ["L3 and up", String(unattended)], ["Pending", String(pending.length)], ["Saves if approved", `${Math.round(saved * 10) / 10}/wk`], ["Under trust 7d", cov.total >= 10 ? `${Math.round((cov.auto / cov.total) * 100)}% n=${cov.total}` : `n=${cov.total}`], ["Levels above L1", tr.levelsAboveL1 ? "on" : "off"]]} />
      <Tabs idPrefix="tr-tab" items={tabs} active={tab} onChange={(t) => { trustUi.tab = t as TrustTab; trustUi.hiProposal = null; rerender(); }} />
      <div id="tr-tab-panel" role="tabpanel" className="tr-panel">{body}</div>
    </div>
  );
}
