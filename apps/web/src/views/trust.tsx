/**
 * Trust ladder (spec 8.7, 13.3). Port of legacy/js/views/trust.js against /api/v1/trust: earned autonomy per agent x work class x project (optionally repo), the ladder matrix with level,
 * evidence count and ceiling marker per cell, cell detail with evidence, history and the criteria for the next level, promotion proposals, demotions with cause, ceilings, versioned
 * promotion criteria, the L2 spot-check rate, and the runtime switch for levels above L1 (off in a new install). L4 is not grantable. A rate is shown with its count and "insufficient
 * data" when small (spec 13.3). Not ported, on purpose: the legacy "Simulate an incoming outcome" button. Outcomes are recorded for real, on shipped work, with an attribution.
 */
import { useEffect, useMemo } from "react";
import { useAgents, useProjects, useTrustCells } from "../api/queries";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Btn, Empty, Tabs } from "../ui/primitives";
import { Page, Stats } from "../ui/cr";
import { Async } from "../ui/async";
import { CeilingsTab, CriteriaTab, DemotionsTab, ProposalsTab } from "./trust/Tabs";
import { useUrlState } from "./urlState";
import { MatrixTab } from "./trust/Matrix";
import { LadderTab, type LadderProps } from "./trust/Ladder";
import { trustFocus, trustUi, useTrustUi, type CellOut, type TrustTab } from "./trust/kit";
import { useCatalog } from "./projects/kit";
import type { Project } from "@gantry/domain";

const DAY = 86_400_000;

/** The four prototype tabs. "ladder" and "demotions" stay reachable by URL (the matrix dialog and the legend link open them) as drill-downs, not tabs. */
const TABS: TrustTab[] = ["matrix", "proposals", "ceilings", "criteria", "ladder", "demotions"];
const SUB = "How much each agent may do without a person, earned by evidence and capped by policy.";

export default function TrustView() {
  useTrustUi();
  const [url, setUrl] = useUrlState({ tab: "matrix" });
  const tab = ((TABS as string[]).includes(url.tab) ? url.tab : "matrix") as TrustTab;
  trustUi.tab = tab;
  const prefs = usePrefs();
  const cat = useCatalog();
  const pq = useProjects();
  const projects = ((pq.data ?? []) as Project[]).filter((p) => p.status !== "archived");
  const agentsData = useAgents().data;
  const all = useTrustCells();
  const project = (trustUi.project && projects.some((p) => p.id === trustUi.project) ? trustUi.project : null) ?? (prefs.project && projects.some((p) => p.id === prefs.project) ? prefs.project : null) ?? projects[0]?.id ?? null;
  if (project !== trustUi.project) trustUi.project = project;
  const lad = useTrustCells(tab === "ladder" ? project : null);
  const tr = all.data;
  const cells = (tr?.cells ?? []) as CellOut[];
  const proposals = tr?.proposals ?? [];
  const focus = (prefs as unknown as { trustFocus?: Parameters<typeof trustFocus>[0] | null }).trustFocus;
  useEffect(() => {
    if (!focus || !tr) return;
    trustFocus(focus, cells, proposals);
    updatePrefs({ trustFocus: null } as never);
  }, [focus, tr]); // eslint-disable-line react-hooks/exhaustive-deps
  const agentName = useMemo(() => (id: string) => (agentsData ?? []).find((a) => a.id === id)?.name ?? id, [agentsData]);
  const clsName = useMemo(() => (id: string) => cat?.classes.find((c) => c.id === id)?.name ?? id, [cat]);
  const head = <Page eyebrow="Workforce" title="Trust" sub={SUB} />;
  if (pq.data === undefined) return <div className="view view-trust">{head}<Async query={pq} what="projects" id="trust-projects">{() => null}</Async></div>;
  if (!projects.length) return <div className="view view-trust">{head}<Empty title="No projects to show" text="You have no role on an active project." /></div>;
  if (!tr || !cat) return <div className="view view-trust">{head}<Async query={all} what="trust levels" id="trust">{() => null}</Async></div>;
  const proj = projects.find((p) => p.id === project)!;
  const pending = proposals.filter((x) => x.status === "pending");
  const dem7 = cells.reduce((n, c) => n + (c.history || []).filter((e) => (e.kind === "demote" || (e.kind === "grant" && e.from != null && e.to < e.from)) && e.at >= Date.now() - 7 * DAY).length, 0);
  const atL3 = new Set(cells.filter((c) => (c.effective ?? c.level) >= 3).map((c) => c.agent)).size;
  const ladderCells = (lad.data?.cells ?? cells.filter((c) => c.project === project)) as CellOut[];
  const base: LadderProps = {
    cat, project: proj, projects, cells: ladderCells.filter((c) => c.project === project), proposals, switchOn: tr.levelsAboveL1 === true, criteria: tr.criteria, sampleRate: tr.sampleRate,
    coverage: tr.coverage?.[proj.id] ?? { total: 0, auto: 0 }, agentName, clsName,
  };
  const policy = { ...base, cells, ...({ ceilings: tr.ceilings, criteriaVersion: tr.criteriaVersion ?? 0 } as object) } as LadderProps & { criteriaVersion: number };
  const tabs = [{ id: "matrix", label: "Matrix" }, { id: "proposals", label: "Proposals", count: pending.length }, { id: "ceilings", label: "Ceilings" }, { id: "criteria", label: "Criteria" }];
  const body = tab === "matrix" ? <MatrixTab cells={cells} projects={projects} agents={(agentsData ?? []).map((a) => ({ id: a.id, name: a.name }))} switchOn={tr.levelsAboveL1 === true} demotions={dem7} />
    : tab === "proposals" ? <ProposalsTab p={base} cells={cells} proposals={proposals} />
    : tab === "demotions" ? <DemotionsTab cells={cells} projects={projects} p={{ ...base, cells }} />
    : tab === "ceilings" ? <CeilingsTab p={policy} cells={cells} projects={projects} />
    : tab === "criteria" ? <CriteriaTab p={policy} cells={cells} projects={projects} />
    : <LadderTab p={base} />;
  return (
    <div className="view view-trust">
      <Page eyebrow="Workforce" title="Trust" sub={SUB}>
        <div id="tr-stats">
          <Stats items={[
            { l: "Agents at L3+", v: String(atL3), tone: "agent" },
            { l: "Open proposals", v: String(pending.length), tone: pending.length ? "warn" : "ok" },
            { l: "Active ceilings", v: String(tr.ceilings.filter((c) => c.enabled).length), tone: "info" },
            { l: "Review sample rate", v: `${Math.round(100 / Math.max(1, tr.sampleRate))}%` },
          ]} />
        </div>
        <div style={{ minWidth: 0, maxWidth: "100%", contain: "inline-size" }}><Tabs idPrefix="tr-tab" items={tabs} active={tab === "ladder" || tab === "demotions" ? "matrix" : tab} onChange={(t) => { trustUi.hiProposal = null; setUrl({ tab: t }); }} /></div>
        {tab === "ladder" || tab === "demotions" ? <div className="row" style={{ marginBottom: 8 }}><Btn label="Back to the matrix" small kind="ghost" icon="back" id="tr-back" onClick={() => setUrl({ tab: "matrix" })} /></div> : null}
        <div id="tr-tab-panel" role="tabpanel" className="tr-panel" style={{ minWidth: 0, maxWidth: "100%", contain: "inline-size" }}>{body}</div>
      </Page>
    </div>
  );
}
