/** Projects (#projects): the portfolio as cards or a table, and New project. The layout is in the URL (`?view=cards|table`); templates are a secondary page (`?view=templates`). */
import { useEffect } from "react";
import { useCan } from "../api/can";
import { useMe, useProjects, useTemplates } from "../api/queries";
import { fmt } from "@gantry/domain";
import { Btn, Segmented, Stat, StatRow, ViewHead } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { Async, qState } from "../ui/async";
import { registerCommand } from "../lib/commands";
import { usePrefs } from "../lib/prefs";
import { ProjectGrid, ProjectTable } from "./projects/gallery";
import { NewProjectDialog } from "./projects/newproject";
import { TemplatesTab } from "./projects/templates";
import { NewProjectWizard } from "./projects/wizard";
import { ActBtn } from "./projects/proto";
import { useQueryParam } from "./projects/urlState";
import type { PView } from "./projects/kit";

export default function ProjectsView() {
  const ui = useUI();
  const me = useMe();
  const prefs = usePrefs();
  const projectsQ = useProjects();
  const tplsQ = useTemplates();
  const projects = ((projectsQ.data ?? []) as PView[]).slice();
  const create = useCan("project.create");
  const [viewQ, setView] = useQueryParam("view");
  const view = viewQ === "table" ? "table" : viewQ === "templates" ? "templates" : "cards";
  const current = projects.find((p) => p.id === prefs.project) ?? null;

  const openNew = () => ui.open((close) => <NewProjectDialog projects={projects} close={close} />);
  // the full wizard (presets for approvers and notifications) stays behind a template's "Use" on the Templates page
  const openWizard = (tplId?: string) => ui.open((close) => <NewProjectWizard tplId={tplId} projects={projects} close={close} />);
  useEffect(() => registerCommand("newProject", () => { if (create.allowed) openNew(); }), [create.allowed, projects.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!me) return null;
  const wip = projects.reduce((n, p) => n + (p.metrics?.wip ?? 0), 0);
  const spent = projects.reduce((n, p) => n + p.budget.mtd, 0);
  const cap = projects.reduce((n, p) => n + p.budget.monthly, 0);
  const regulated = projects.filter((p) => p.regulated).length;
  const activeN = projects.filter((p) => p.status === "active").length;
  return (
    <div className="view prj">
      <ViewHead
        kicker="ALL LINES" title="Projects" sub="Each project is its own production line with its own flow, gates and budget."
        actions={<>
          <Segmented pressed name="prj-view" label="View" items={[{ id: "cards", label: "Cards" }, { id: "table", label: "Table" }]} value={view === "table" ? "table" : view === "cards" ? "cards" : ""} onChange={(id) => setView(id === "cards" ? null : id)} />
          <ActBtn kind="primary" icon="plus" id="prj-new" guard={create} label="New project" onClick={openNew} />
        </>}
      />
      <StatRow id="prj-stats">
        <Stat label="Projects" value={qState(projectsQ, () => String(projects.length))} sub={qState(projectsQ, () => `${activeN} active`)} tone="info" />
        <Stat label="In flight" value={qState(projectsQ, () => String(wip))} sub="work orders" />
        <Stat label="Spend MTD" value={qState(projectsQ, () => fmt.money0(spent))} sub={`of ${fmt.money0(cap)}`} />
        <Stat label="Regulated" value={qState(projectsQ, () => String(regulated))} sub="extra gates" {...(regulated ? { tone: "wait" as const } : {})} />
      </StatRow>
      {view === "templates" ? (
        <div className="prj-stack">
          <div className="row"><Btn small kind="ghost" icon="back" id="prj-back" label="Projects" onClick={() => setView(null)} /></div>
          <Async query={tplsQ} what="templates" id="prj-tpl">{() => <TemplatesTab projects={projects} current={current} onUse={openWizard} />}</Async>
        </div>
      ) : (
        <Async query={projectsQ} what="projects" id="prj-pf">
          {() => (view === "table" ? <ProjectTable projects={projects} /> : <ProjectGrid projects={projects} />)}
        </Async>
      )}
    </div>
  );
}
