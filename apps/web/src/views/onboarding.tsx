/** Onboarding (#onboarding): repo readiness pipeline for the current project, the repo drawer, the connect-repo wizard, per-repo settings and the Onboarding agent tab with versioned guidelines. Ported from legacy/js/views/onboarding.js. */
import { useState } from "react";
import { useCan } from "../api/can";
import { useMe, useProjects, useRepos } from "../api/queries";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { navigate, useHash } from "../lib/router";
import { Btn, Empty, Tabs } from "../ui/primitives";
import { Page } from "../ui/cr";
import { Async } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { AgentTab } from "./onboarding/Agent";
import { RepoDrawer, rememberTab } from "./onboarding/Drawer";
import { type RepoV } from "./onboarding/kit";
import { Pipeline } from "./onboarding/Pipeline";
import { SessionPage } from "./onboarding/Session";
import { ConnectWizard } from "./onboarding/Wizard";

export default function OnboardingView() {
  const ui = useUI();
  const me = useMe();
  const hash = useHash();
  const prefs = usePrefs();
  const projectsQ = useProjects();
  const projects = projectsQ.data ?? [];
  const project = projects.find((p) => p.id === prefs.project) ?? null;
  const reposQ = useRepos(project?.id);
  const repos = (reposQ.data ?? []) as RepoV[];
  const connect = useCan("repo.onboard", { project: project?.id });
  const [tab, setTab] = useState<"wizard" | "pipeline" | "agent">(() => { const t = new URLSearchParams(window.location.search).get("tab"); return t === "wizard" || t === "agent" ? t : "pipeline"; });
  const openRepo = (repoId: string, dtab?: string) => {
    if (!project) return;
    if (dtab) rememberTab(repoId, dtab);
    ui.drawer.open(`onb:${repoId}`, (close) => <RepoDrawer repoId={repoId} projectId={project.id} close={close} />);
  };
  if (!me) return null;
  if (!project) return <div className="view">{projectsQ.data ? <Empty title="No project" text="You do not have a project to show." /> : <Async query={projectsQ} what="your projects" id="onb-projects">{() => null}</Async>}</div>;
  // `#/p/<project>/onboarding/<repo>`: the onboarding session of one repo (the pipeline's rows open it).
  if (hash.param) return <div className="view onb-view"><SessionPage projectId={project.id} repoId={hash.param} back={() => navigate("onboarding", null)} details={() => openRepo(hash.param!)} /></div>;
  return (
    <Page
      cls="onb-view"
      eyebrow={`Portfolio · ${project.name}`}
      title="Onboarding"
      sub="Bring a repository onto the line: assess, set guidelines, merge the onboarding PR."
      acts={
        <>
          <Btn small kind="ghost" icon="agent" id="onb-agent-profile" label="Onboarding agent profile" onClick={() => { updatePrefs({ agent: "ag-onboard" }); navigate("agents"); }} />
          <Btn kind="primary" icon="plus" id="onb-connect" label="Connect repo" guard={connect} onClick={() => setTab("wizard")} />
        </>
      }
    >
      <Tabs idPrefix="onb-tab" items={[{ id: "wizard", label: "Wizard" }, { id: "pipeline", label: "Pipeline", count: repos.length }, { id: "agent", label: "Guidelines" }]} active={tab} onChange={(t) => setTab(t as typeof tab)} />
      {tab === "wizard" ? <ConnectWizard project={project} repos={repos} onCancel={() => setTab("pipeline")} onDone={(id) => { setTab("pipeline"); navigate("onboarding", id); }} /> : null}
      {tab === "pipeline" ? <Async query={reposQ} what="repos" id="onb-repos">{() => <Pipeline project={project.id} repos={repos} open={(id) => navigate("onboarding", id)} details={openRepo} />}</Async> : null}
      {tab === "agent" ? <AgentTab project={project} /> : null}
    </Page>
  );
}
