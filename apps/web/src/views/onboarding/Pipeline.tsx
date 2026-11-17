/** The Pipeline tab: repos per stage, the waiting-for-merge callout, the filter bar and the table of repos. */
import { useState } from "react";
import { Btn, Empty, FilterBar, Panel, SearchBox, Select } from "../../ui/primitives";
import { DataTable, type Col } from "../../ui/SortTable";
import { Icon } from "../../ui/Icon";
import { StatusChip, Steps, gaps, isStopped, needsMerge, stageIndex, stageName, status, useIntegrationsFor, useTeamName, type RepoV } from "./kit";

type Filter = "all" | "attention" | "progress" | "ready";

export function Pipeline({ project, repos, open, details }: { project: string; repos: RepoV[]; open: (repoId: string) => void; details: (repoId: string, tab?: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const teamName = useTeamName();
  const { all } = useIntegrationsFor(project);
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
    { key: "gaps", label: "Gaps", align: "end", sort: (r) => (r.onboarding.findings.length ? gaps(r).length : -1), render: (r) => (r.onboarding.findings.length ? <span className="mono">{String(gaps(r).length)}</span> : <span className="muted" title="Not assessed yet"><span aria-hidden="true">-</span><span className="sr">Not assessed yet</span></span>) },
    { key: "act", label: "", align: "end", render: (r) => <Btn small kind={r.onboarding.stage === "connected" ? "primary" : undefined} id={`onb-open-${r.id}`} label={r.onboarding.stage === "connected" ? "Start" : "Open"} onClick={() => open(r.id)} /> },
  ];

  return (
    <div className="onb-pipe">
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
          <Panel title="Repositories moving to Ready" flush>
            <FilterBar label="Filter repos" count={`${list.length} of ${repos.length} repos`}>
              <SearchBox id="onb-search" value={q} onChange={setQ} placeholder="Search..." />
              <label className="q" htmlFor="onb-filter"><span>Stage</span><Select id="onb-filter" value={filter} onChange={(v) => setFilter(v as Filter)} options={[{ value: "all", label: "All" }, { value: "attention", label: "Needs action" }, { value: "progress", label: "In progress" }, { value: "ready", label: "Ready" }]} /></label>
            </FilterBar>
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
              empty={{ title: "No repos match", text: "Pick another filter, or clear the search.", action: <button type="button" className="btn btn-sm" id="onb-filter-clear" onClick={() => { setFilter("all"); setQ(""); }}>Show all</button> }}
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
