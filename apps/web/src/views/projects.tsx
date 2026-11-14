/** Projects (#projects): the portfolio, templates and the New project wizard. Ported from legacy/js/views/projects.js. */
import { useEffect, useState } from "react";
import { useCan } from "../api/can";
import { useMe, useProjects, useTemplates } from "../api/queries";
import { usePrefs } from "../lib/prefs";
import { Btn, Tabs, ViewHead } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { registerCommand } from "../lib/commands";
import { Portfolio } from "./projects/portfolio";
import { TemplatesTab } from "./projects/templates";
import { NewProjectWizard } from "./projects/wizard";
import type { PView } from "./projects/kit";

export default function ProjectsView() {
  const ui = useUI();
  const me = useMe();
  const prefs = usePrefs();
  const projects = ((useProjects().data ?? []) as PView[]).slice();
  const tpls = useTemplates().data ?? [];
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
  const killed = projects.filter((p) => p.killed || p.metrics?.health.id === "killed").length;
  return (
    <div className="view prj">
      <ViewHead
        kicker="Factory · Projects" title="Projects" sub="Each project is a line in the factory: its own repos, flow, approvers, budget and kill switch."
        meta={[["Projects", String(live)], ["Archived", String(archived)], ["Templates", String(tpls.length)], ["Killed", String(killed)]]}
        actions={<Btn kind="primary" icon="plus" id="prj-new" guard={create} label="New project" onClick={() => openWizard()} />}
      />
      <Tabs idPrefix="prj-tab" items={[{ id: "projects", label: "Portfolio", count: projects.length }, { id: "templates", label: "Templates", count: tpls.length }]} active={tab} onChange={(id) => setTab(id as typeof tab)} />
      <div role="tabpanel" id="prj-tab-panel" aria-labelledby={`prj-tab-${tab}`}>
        {tab === "templates" ? (
          <TemplatesTab projects={projects} current={current} onUse={openWizard} />
        ) : (
          <div className="prj-stack">
            <Portfolio ctx="prj-pf" projects={projects} defaultLayout="rows" roles />
          </div>
        )}
      </div>
    </div>
  );
}
