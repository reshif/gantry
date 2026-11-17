/** Onboarding (#onboarding): repo readiness pipeline for the current project, the repo drawer, the connect-repo wizard, per-repo settings and the Onboarding agent tab with versioned guidelines. Ported from legacy/js/views/onboarding.js. */
import { useState } from "react";
import { useCan } from "../api/can";
import { useMe, useProjects, useRepos } from "../api/queries";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { navigate, useHash } from "../lib/router";
import { Btn, Empty, Tabs, ViewHead } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { AgentTab } from "./onboarding/Agent";
import { RepoDrawer, rememberTab } from "./onboarding/Drawer";
import { isStopped, needsMerge, needsPr, type RepoV } from "./onboarding/kit";
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
  const [tab, setTab] = useState<"pipeline" | "agent">("pipeline");
  const openRepo = (repoId: string, dtab?: string) => {
    if (!project) return;
    if (dtab) rememberTab(repoId, dtab);
    ui.drawer.open(`onb:${repoId}`, (close) => <RepoDrawer repoId={repoId} projectId={project.id} close={close} />);
  };
  const wizard = () => {
    if (!project) return;
    ui.open((close) => <ConnectWizard project={project} repos={repos} close={close} onDone={(id) => { setTab("pipeline"); navigate("onboarding", id); }} />);
  };
  if (!me) return null;
  if (!project) return <div className="view">{projectsQ.data ? <Empty title="No project" text="You do not have a project to show." /> : <Async query={projectsQ} what="your projects" id="onb-projects">{() => null}</Async>}</div>;
  // `#/p/<project>/onboarding/<repo>`: the onboarding session of one repo (the pipeline's rows open it).
  if (hash.param) return <div className="view onb-view"><SessionPage projectId={project.id} repoId={hash.param} back={() => navigate("onboarding", null)} details={() => openRepo(hash.param!)} /></div>;
  const ready = repos.filter((r) => r.onboarding.stage === "ready").length;
  const attention = repos.filter((r) => isStopped(r) || needsMerge(r) || needsPr(r)).length;
  return (
    <div className="view onb-view">
      <ViewHead
        title="Onboarding"
        sub="A repo must reach Ready before anyone can submit work orders to it. Gantry assesses each repo and opens a PR with the changes it needs. The Onboarding Agent adds its judgement and drafts when a model vendor is connected; otherwise the work is rule-based."
        meta={[["Repos", qState(reposQ, () => String(repos.length))], ["Ready", qState(reposQ, () => `${ready} / ${repos.length}`)], ["In progress", qState(reposQ, () => String(repos.length - ready - attention))], ["Needs action", qState(reposQ, () => String(attention))]]}
        actions={<Btn kind="primary" icon="plus" id="onb-connect" label="Connect repo" guard={connect} onClick={wizard} />}
      />
      <div className="onb-tabrow">
        <Tabs idPrefix="onb-tab" items={[{ id: "pipeline", label: "Pipeline", count: repos.length }, { id: "agent", label: "Guidelines" }]} active={tab} onChange={(t) => setTab(t as typeof tab)} />
        <Btn small kind="ghost" icon="agent" id="onb-agent-profile" label="Onboarding agent profile" onClick={() => { updatePrefs({ agent: "ag-onboard" }); navigate("agents"); }} />
      </div>
      {tab === "pipeline" ? <Async query={reposQ} what="repos" id="onb-repos">{() => <Pipeline project={project.id} repos={repos} open={(id) => navigate("onboarding", id)} details={openRepo} />}</Async> : <AgentTab project={project} />}
    </div>
  );
}
