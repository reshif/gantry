/** Onboarding (#onboarding): the Blueprint's pipeline of repositories moving to Ready, the guidelines, and one session page per repository. */
import { useCan } from "../api/can";
import { useGuidelines, useMe, useProjects, useRepos } from "../api/queries";
import { navigate, hashFor, useHash } from "../lib/router";
import { Btn, Chip, Empty, Panel, Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { setProject } from "../lib/prefs";
import { usePrefs } from "../lib/prefs";
import { ProtoList } from "./projects/protolist";
import { useTab } from "./projects/proto";
import { GuidelinesPanel } from "./onboarding/Guidelines";
import { OnboardDialog } from "./onboarding/OnboardDialog";
import { RepoDrawer } from "./onboarding/Drawer";
import { PSTAGES, protoStage, stoppedLabel, type OnbRow } from "./onboarding/proto";
import { gaps, useAvailableRepos, type RepoV } from "./onboarding/kit";
import { SessionPage } from "./onboarding/Session";

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
  const availQ = useAvailableRepos(project?.id ?? "", !!project);
  const gl = useGuidelines().data;
  const connect = useCan("repo.onboard", { project: project?.id });
  const [tab, setTab] = useTab(["pipeline", "guidelines"], "pipeline");
  if (!me) return null;
  if (!project) return <div className="view">{projectsQ.data ? <Empty title="No project" text="You do not have a project to show." /> : <Async query={projectsQ} what="your projects" id="onb-projects">{() => null}</Async>}</div>;
  // `#/p/<project>/onboarding/<repo>`: the onboarding session of one repo.
  if (hash.param) {
    return (
      <div className="view onb-view">
        <SessionPage projectId={project.id} repoId={hash.param} back={() => navigate("onboarding", null)} details={() => ui.drawer.open(`onb:${hash.param}`, (close) => <RepoDrawer repoId={hash.param!} projectId={project.id} close={close} />)} />
      </div>
    );
  }
  const connected = new Set(repos.map((r) => r.name.toLowerCase()));
  const rows: OnbRow[] = [
    ...repos.map((r) => ({ id: r.id, name: r.name, lang: r.lang, stage: protoStage(r), gaps: r.onboarding.findings.length ? gaps(r).length : null, repo: r })),
    ...(availQ.data?.available ?? []).filter((a) => !connected.has(a.repo.toLowerCase())).map((a) => ({ id: a.repo, name: a.repo, lang: a.lang, stage: 0, gaps: null, repo: null })),
  ];
  // in progress first, then the ones waiting to start, then the ready ones (the Blueprint lists what is moving)
  const order = (r: OnbRow) => (r.stage === 4 ? 2 : r.stage === 0 ? 1 : 0);
  rows.sort((a, b) => order(a) - order(b));
  const waiting = rows.filter((r) => r.stage === 0).length;
  const moving = rows.filter((r) => r.stage > 0 && r.stage < 4).length;
  const ready = rows.filter((r) => r.stage === 4).length;
  const onboard = (pick?: OnbRow) => ui.open((close) => <OnboardDialog rows={rows} projects={projects} project={project} pick={pick} close={close} />);
  const href = (r: OnbRow): string => hashFor("onboarding", r.repo ? r.repo.id : null, project.id);
  return (
    <div className="view onb-view">
      <ViewHead
        kicker={project.key} title="Onboarding" sub="Bring a repository onto the line: assess it, fix the gaps by pull request, then go live."
        actions={<Btn kind="primary" icon="plus" id="onb-connect" label="Onboard a repo" guard={connect} onClick={() => onboard()} />}
      />
      <StatRow>
        <Stat label="Waiting" value={qState(reposQ, () => String(waiting))} sub="not started" />
        <Stat label="In progress" value={qState(reposQ, () => String(moving))} tone="info" />
        <Stat label="Ready" value={qState(reposQ, () => String(ready))} tone="done" sub="repos live" />
        <Stat label="Guidelines" value={gl ? String(gl.items.length) : "…"} sub={gl ? `v${gl.version}` : ""} />
      </StatRow>
      <Tabs idPrefix="onb-tab" items={[{ id: "pipeline", label: "Pipeline", count: rows.filter((r) => r.stage > 0).length }, { id: "guidelines", label: "Guidelines", count: gl?.items.length ?? null }]} active={tab} onChange={setTab} />
      {tab === "pipeline" ? (
        <Async query={reposQ} what="repos" id="onb-repos" isEmpty={() => false}>
          {() => (
            <Panel title="Repositories moving to Ready" flush>
              <ProtoList<OnbRow>
                id="onb-list" noun="repo" rows={rows} rowKey={(r) => r.id} text={(r) => r.name} searchLabel="Search repo" searchPlaceholder="Search…"
                filters={[{ k: "stage", label: "Stage", opts: PSTAGES.map((s, i) => [String(i), s] as [string, string]), fn: (r, v) => String(r.stage) === v }]}
                cols={[
                  { key: "r", label: "Repository", sort: (r) => r.name, render: (r) => <div>{r.stage ? <a className="pri" href={href(r)} onClick={() => setProject(project.id)}>{r.name}</a> : <span className="pri">{r.name}</span>}<span className="sub">{r.lang}</span></div> },
                  { key: "s", label: "Stage", sort: (r) => r.stage, render: (r) => <div className="row" style={{ gap: 2 }} role="img" aria-label={`Stage ${PSTAGES[r.stage]}`}>{PSTAGES.map((s, i) => <span key={s} title={s} style={{ width: 18, height: 8, background: i <= r.stage ? "var(--accent)" : "var(--sunk)", border: "1px solid var(--line2)" }} />)}</div> },
                  { key: "sn", label: "Status", render: (r) => { const stop = r.repo ? stoppedLabel(r.repo) : null; return stop ? <Chip text={stop} cls={stop === "Failed" ? "bad" : "warn"} /> : <Chip text={PSTAGES[r.stage]} cls={r.stage === 4 ? "ok" : r.stage ? "info" : "plain"} />; } },
                  { key: "f", label: "Gaps", align: "end", render: (r) => (r.gaps == null ? "—" : String(r.gaps)) },
                  { key: "a", label: "", align: "end", render: (r) => (r.stage ? <Btn small id={`onb-open-${r.id}`} label="Open" onClick={() => navigate("onboarding", r.repo?.id ?? r.id)} /> : <Btn small kind="primary" id={`onb-start-${r.id}`} label="Start" guard={connect} onClick={() => onboard(r)} />) },
                ]}
              />
            </Panel>
          )}
        </Async>
      ) : (
        <GuidelinesPanel project={project} />
      )}
    </div>
  );
}
