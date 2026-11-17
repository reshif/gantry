/** The Pipeline tab: repos per stage, the waiting-for-merge callout, the filter bar and the table of repos. */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { Empty, FilterBar, Panel, SearchBox, Segmented } from "../../ui/primitives";
import { DataTable, type Col } from "../../ui/SortTable";
import { Icon } from "../../ui/Icon";
import { STAGES, StatusChip, Steps, gaps, isStopped, needsMerge, stageIndex, stageName, status, useIntegrationsFor, useTeamName, type RepoV } from "./kit";

type Filter = "all" | "attention" | "progress" | "ready";

export function Pipeline({ project, repos, open, details }: { project: string; repos: RepoV[]; open: (repoId: string) => void; details: (repoId: string, tab?: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const teamName = useTeamName();
  const { all } = useIntegrationsFor(project);
  const now = Date.now();
  const counts = STAGES.map((s) => repos.filter((r) => r.onboarding.stage === s.id).length);
  const stopped = repos.filter(isStopped).length;
  const sourceName = (r: RepoV): string => (r.source ? all.find((x) => x.inst.id === r.source)?.inst.name ?? "source control" : "GitHub App");
  const text = (r: RepoV): string => [r.name, teamName(r.team), r.lang, status(r).label, stageName(r.onboarding.stage), ...r.tags].join(" ").toLowerCase();
  const list = repos.filter((r) => {
    const s = status(r).id;
    const inFilter = filter === "all" || (filter === "attention" ? s === "person" || s === "failed" || s === "merge" || s === "openpr" : filter === "ready" ? s === "ready" || s === "exception" : s === "progress" || s === "merge");
    return inFilter && (!q.trim() || text(r).includes(q.trim().toLowerCase()));
  });
  const waiting = repos.filter(needsMerge);

  const cols: Col<RepoV>[] = [
    {
      key: "name", label: "Repo", sort: (r) => r.name,
      render: (r) => (
        <div className="onb-repo">
          <span className="mono strong">{r.name}</span>
          <button type="button" className="linkish small" id={`onb-detail-${r.id}`} onClick={(e) => { e.stopPropagation(); details(r.id); }}>Details</button>
          <span className="muted small">{`${r.lang || "Language not read yet"} · ${teamName(r.team)} · ${sourceName(r)}${r.tags.length ? ` · ${r.tags.join(", ")}` : ""}`}</span>
        </div>
      ),
    },
    { key: "pipe", label: "Pipeline", hideSmall: true, render: (r) => <Steps r={r} /> },
    {
      key: "stage", label: "Stage", sort: (r) => (isStopped(r) ? 99 : stageIndex(r)),
      render: (r) => (
        <div className="onb-stage-cell">
          <span className="strong">{stageName(r.onboarding.stage)}</span>
          <StatusChip r={r} />
        </div>
      ),
    },
    {
      key: "pr", label: "Onboarding PR", hideSmall: true,
      render: (r) => (r.onboarding.pr ? <span className="mono">{`#${r.onboarding.pr.number}`}<span className="muted">{` · ${r.onboarding.pr.state === "merged" ? "merged" : `checks ${r.onboarding.pr.checks}`}`}</span></span> : <span className="muted">none yet</span>),
    },
    { key: "gaps", label: "Gaps", align: "end", sort: (r) => (r.onboarding.findings.length ? gaps(r).length : -1), render: (r) => (r.onboarding.findings.length ? <span className="mono">{String(gaps(r).length)}</span> : <span className="muted">-</span>) },
    {
      key: "time", label: "Time", hideSmall: true,
      render: (r) => {
        const o = r.onboarding;
        return <span className="mono small">{o.stage === "ready" ? (o.readyAt ? `ready ${fmt.ago(o.readyAt, now)}` : "ready") : `started ${fmt.ago(o.startedAt || o.timeline[0]?.at || now, now)}`}</span>;
      },
    },
  ];

  return (
    <div className="onb-pipe">
      <ol className="onb-strip" aria-label="Repos per onboarding stage">
        {STAGES.map((s, i) => (
          <li key={s.id} className={counts[i] ? "has-n" : ""}>
            <span className="onb-strip-no">{`Stage ${i + 1}`}</span>
            <span className="onb-strip-n">{String(counts[i])}</span>
            <span className="onb-strip-l">{s.name}</span>
          </li>
        ))}
        <li className={`onb-strip-off${stopped ? " has-n" : ""}`}>
          <span className="onb-strip-no">Off belt</span>
          <span className="onb-strip-n">{String(stopped)}</span>
          <span className="onb-strip-l">Stopped</span>
        </li>
      </ol>
      {waiting.length ? (
        <div className="callout callout-warn onb-callout">
          <Icon name="st-wait" />
          <div>
            <strong>{`${waiting.length} onboarding PR${waiting.length > 1 ? "s are" : " is"} green and waiting for a person to approve and merge: `}</strong>
            {waiting.map((r, i) => (
              <span key={r.id}>
                {i ? ", " : ""}
                <button type="button" className="linkish mono" id={`onb-wait-${r.id}`} onClick={() => open(r.id)}>{`${r.name}#${r.onboarding.pr!.number}`}</button>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {repos.length ? (
        <>
          <FilterBar label="Filter repos" count={`${list.length} of ${repos.length} repos`}>
            <SearchBox id="onb-search" value={q} onChange={setQ} placeholder="Search repos" />
            <Segmented name="onb-filter" label="Filter repos" value={filter} onChange={(v) => setFilter(v as Filter)} items={[{ id: "all", label: "All" }, { id: "attention", label: "Needs action" }, { id: "progress", label: "In progress" }, { id: "ready", label: "Ready" }]} />
          </FilterBar>
          <Panel flush>
            <DataTable<RepoV>
              id="onb-table"
              caption="Repos and their onboarding state"
              columns={cols}
              rows={list}
              rowKey={(r) => r.id}
              rowId={(r) => `onb-row-${r.id}`}
              rowLabel={(r) => `Open the onboarding session for ${r.name}`}
              onRow={(r) => open(r.id)}
              sort={{ key: "stage", dir: 1 }}
              pageSize={8}
              empty={{ title: "No repos match", text: "Pick another filter, or clear the search." }}
            />
          </Panel>
        </>
      ) : (
        <Empty id="onb-empty" icon="folder" title="No repos yet" text="Connect a repo the GitHub App is installed on to start onboarding." />
      )}
      <p className="footnote">Gantry reads each repo through the GitHub App, checks the onboarding PR's CI every minute, and moves repos on by itself. A person must approve and merge each onboarding PR.</p>
    </div>
  );
}
