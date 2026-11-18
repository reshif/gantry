/** Onboarding (#onboarding): repo readiness pipeline for the current project, the repo drawer, the connect-repo wizard, per-repo settings and the Onboarding agent tab with versioned guidelines. Ported from legacy/js/views/onboarding.js. */
import { useState } from "react";
import { useMe, useProjects, useRepos } from "../api/queries";
import { usePrefs } from "../lib/prefs";
import { navigate, useHash } from "../lib/router";
import { Empty, Tabs } from "../ui/primitives";
import { Page } from "../ui/cr";
import { Async } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { RepoDrawer, rememberTab } from "./onboarding/Drawer";
import { useAllRepos } from "./projects/kit";
import { type RepoV } from "./onboarding/kit";
import { Pipeline } from "./onboarding/Pipeline";
import { SessionPage } from "./onboarding/Session";
import { OnbWizard, WIZ0, type Wiz } from "./onboarding/OnbWizard";
import { SessionTab, SettingsTab } from "./onboarding/Tabs";
import { useParam } from "./projects/url";

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
  const [tab, setTab] = useParam("tab", "wizard", ["wizard", "pipeline", "session", "settings"]);
  const [wiz, setWiz] = useState<Wiz>(WIZ0);
  // the Pipeline and Session tabs list every project's repos (the prototype's tables), the wizard and settings work on the current project
  const allQ = useAllRepos(projects.map((p) => p.id));
  const keyOf = (id: string): string => (projects.find((p) => p.id === id)?.key ?? id).toUpperCase();
  const openRepo = (repoId: string, dtab?: string, projectId?: string) => {
    const pid = projectId ?? project?.id;
    if (!pid) return;
    if (dtab) rememberTab(repoId, dtab);
    ui.drawer.open(`onb:${repoId}`, (close) => <RepoDrawer repoId={repoId} projectId={pid} close={close} />);
  };
  if (!me) return null;
  if (!project) return <div className="view">{projectsQ.data ? <Empty title="No project" text="You do not have a project to show." /> : <Async query={projectsQ} what="your projects" id="onb-projects">{() => null}</Async>}</div>;
  // `#/p/<project>/onboarding/<repo>`: the onboarding session of one repo (the pipeline's rows open it).
  if (hash.param) return <div className="view onb-view"><SessionPage projectId={project.id} repoId={hash.param} back={() => navigate("onboarding", null)} details={() => openRepo(hash.param!)} /></div>;
  return (
    <Page
      cls="onb-view"
      eyebrow="Portfolio"
      title="Onboarding"
      sub="Bring a repository onto the line: assess, set guidelines, merge the onboarding PR."
    >
      <Tabs idPrefix="onb-tab" items={[{ id: "wizard", label: "Wizard" }, { id: "pipeline", label: "Pipeline" }, { id: "session", label: "Session" }, { id: "settings", label: "Settings" }]} active={tab} onChange={setTab} />
      {tab === "wizard" ? <OnbWizard project={project} repos={repos} w={wiz} set={(p) => setWiz((x) => ({ ...x, ...p }))} onDone={() => setTab("pipeline")} /> : null}
      {tab === "pipeline" ? <Async query={allQ} what="repos" id="onb-repos">{(all) => <Pipeline keyOf={keyOf} repos={all as RepoV[]} details={(r) => openRepo(r.id, undefined, r.project)} />}</Async> : null}
      {tab === "session" ? <Async query={allQ} what="repos" id="onb-repos-s">{(all) => <SessionTab repos={all as RepoV[]} />}</Async> : null}
      {tab === "settings" ? <SettingsTab project={project} /> : null}
    </Page>
  );
}
