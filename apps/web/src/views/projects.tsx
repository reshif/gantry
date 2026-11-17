/** Projects (#projects): the portfolio, templates and the New project wizard. Ported from legacy/js/views/projects.js. */
import { useEffect, useState } from "react";
import { useCan } from "../api/can";
import { useMe, useProjects, useTemplates } from "../api/queries";
import { usePrefs } from "../lib/prefs";
import { fmt } from "@gantry/domain";
import { Btn, Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { Async, qState } from "../ui/async";
import { registerCommand } from "../lib/commands";
import { Portfolio } from "./projects/portfolio";
import { TemplatesTab } from "./projects/templates";
import { NewProjectWizard } from "./projects/wizard";
import type { PView } from "./projects/kit";

export default function ProjectsView() {
  const ui = useUI();
  const me = useMe();
  const prefs = usePrefs();
  const projectsQ = useProjects();
  const tplsQ = useTemplates();
  const projects = ((projectsQ.data ?? []) as PView[]).slice();
  const tpls = tplsQ.data ?? [];
  const create = useCan("project.create");
  const [tab, setTab] = useState<"projects" | "templates">("projects");
  const current = projects.find((p) => p.id === prefs.project) ?? null;

  const openWizard = (tplId?: string) => {
    ui.open((close) => <NewProjectWizard tplId={tplId} projects={projects} close={close} />);
  };
  useEffect(() => registerCommand("newProject", () => { if (create.allowed) openWizard(); }), [create.allowed, projects.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!me) return null;
  const live = projects.filter((p) => p.status !== "archived").length;
  const archived = projects.length - live;
  const active = projects.filter((p) => p.status !== "archived");
  const wip = active.reduce((n, p) => n + (p.metrics?.wip ?? 0), 0);
  const spent = active.reduce((n, p) => n + p.budget.mtd, 0);
  const cap = active.reduce((n, p) => n + p.budget.monthly, 0);
  const regulated = active.filter((p) => p.regulated).length;
  return (
    <div className="view prj">
      <ViewHead
        title="Projects" sub="Each project is its own production line with its own flow, gates and budget."
        actions={<Btn kind="primary" icon="plus" id="prj-new" guard={create} label="New project" onClick={() => openWizard()} />}
      />
      <StatRow id="prj-stats">
        <Stat label="Projects" value={qState(projectsQ, () => String(live))} sub={`${archived} archived`} tone="done" />
        <Stat label="In flight" value={qState(projectsQ, () => String(wip))} sub="work orders" />
        <Stat label="Spend MTD" value={qState(projectsQ, () => fmt.money0(spent))} sub={`of ${fmt.money0(cap)}`} {...(cap && spent / cap > 0.8 ? { tone: "wait" as const } : {})} />
        <Stat label="Regulated" value={qState(projectsQ, () => String(regulated))} sub="extra gates" {...(regulated ? { tone: "wait" as const } : {})} />
      </StatRow>
      <Tabs idPrefix="prj-tab" items={[{ id: "projects", label: "Portfolio", count: projects.length }, { id: "templates", label: "Templates", count: tpls.length }]} active={tab} onChange={(id) => setTab(id as typeof tab)} />
      <div role="tabpanel" id="prj-tab-panel" aria-labelledby={`prj-tab-${tab}`}>
        {tab === "templates" ? (
          <Async query={tplsQ} what="templates" id="prj-tpl">
            {() => <TemplatesTab projects={projects} current={current} onUse={openWizard} />}
          </Async>
        ) : (
          <div className="prj-stack">
            <Async query={projectsQ} what="projects" id="prj-pf">
              {() => <Portfolio ctx="prj-pf" projects={projects} defaultLayout="cards" roles />}
            </Async>
          </div>
        )}
      </div>
    </div>
  );
}
