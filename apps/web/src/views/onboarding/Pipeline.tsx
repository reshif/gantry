/**
 * The Pipeline tab in the prototype's table: Repository, Project, Language, Tests, State, paged. The repository name opens the repo's drawer
 * (stage, pull request, settings, history); the State chip keeps the richer onboarding states (In progress, Open the PR, Waiting for merge, Needs a person).
 */
import { Empty } from "../../ui/primitives";
import { DataTable, type Col } from "../../ui/DataTable";
import { StatusChip, status, type RepoV } from "./kit";

/** Test coverage as a number, read from the assessment's coverage finding; null when the assessment does not say. */
export const testsPct = (r: RepoV): number | null => {
  const f = r.onboarding.findings.find((x) => /coverage|tests/i.test(x.check) && /\d+\s*%/.test(x.detail ?? ""));
  const m = f?.detail?.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
};

export function Pipeline({ projectKey, repos, details }: { projectKey: string; repos: RepoV[]; details: (repoId: string, tab?: string) => void }) {
  const cols: Col<RepoV>[] = [
    { key: "name", label: "Repository", sort: (r) => r.name, render: (r) => <a className="mono rl" id={`onb-detail-${r.id}`} href="#onboarding" onClick={(e) => { e.preventDefault(); details(r.id); }}>{r.name}</a> },
    { key: "project", label: "Project", render: () => <span className="tag">{projectKey}</span> },
    { key: "lang", label: "Language", sort: (r) => r.lang, render: (r) => <>{r.lang || <span className="dim">not available</span>}</> },
    { key: "tests", label: "Tests", align: "end", sort: (r) => testsPct(r) ?? -1, render: (r) => (testsPct(r) === null ? <span className="dim">not available</span> : <span className="mono">{`${testsPct(r)}%`}</span>) },
    { key: "state", label: "State", sort: (r) => status(r).label, render: (r) => <StatusChip r={r} /> },
  ];
  if (!repos.length) return <Empty id="onb-empty" icon="folder" title="No repos yet" text="Connect a repo from the Wizard tab to start onboarding." />;
  return <DataTable<RepoV> id="onb-table" caption="Repos and their onboarding state" columns={cols} rows={repos} rowKey={(r) => r.id} rowId={(r) => `onb-row-${r.id}`} sort={{ key: "name", dir: 1 }} pageSize={10} pager />;
}
