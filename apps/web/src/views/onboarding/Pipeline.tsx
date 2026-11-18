/**
 * The Pipeline tab in the prototype's table: Repository, Project, Language, Tests, State, paged, over every project's repos.
 * The repository name opens the repo's drawer (stage, pull request, settings, history). The State chip is the prototype's: Ready (ok), Assessing
 * (info) while a repo is being worked on; a repo that needs a person, failed or waits on a merge keeps its real wording.
 */
import { Empty } from "../../ui/primitives";
import { Chip } from "../../ui/primitives";
import { DataTable, type Col } from "../../ui/DataTable";
import { status, type RepoV } from "./kit";

/** Test coverage as a number, read from the assessment's coverage finding; null when the assessment does not say. */
export const testsPct = (r: RepoV): number | null => {
  const f = r.onboarding.findings.find((x) => /coverage|tests/i.test(x.check) && /\d+\s*%/.test(x.detail ?? ""));
  const m = f?.detail?.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
};

/** The prototype's two states, ok and info; the stopped and waiting states keep their own words and tones. */
export function stateOf(r: RepoV): { id: string; label: string; cls: string } {
  const s = status(r);
  if (s.id === "ready" || s.id === "exception") return { id: s.id, label: s.label, cls: "ok" };
  if (s.id === "person" || s.id === "failed") return { id: s.id, label: s.label, cls: "bad" };
  if (s.id === "merge" || s.id === "openpr") return { id: s.id, label: s.label, cls: "warn" };
  return { id: s.id, label: r.onboarding.stage === "connected" ? "Assessing" : s.label, cls: "info" };
}

export function Pipeline({ keyOf, repos, details }: { keyOf: (projectId: string) => string; repos: RepoV[]; details: (repo: RepoV) => void }) {
  const cols: Col<RepoV>[] = [
    { key: "name", label: "Repository", sort: (r) => r.name, render: (r) => <a className="mono rl" id={`onb-detail-${r.id}`} href="#onboarding" onClick={(e) => { e.preventDefault(); details(r); }}>{r.name}</a> },
    { key: "project", label: "Project", sort: (r) => keyOf(r.project), render: (r) => <span className="tag">{keyOf(r.project)}</span> },
    { key: "lang", label: "Language", sort: (r) => r.lang, render: (r) => <>{r.lang || <span className="dim">not available</span>}</> },
    { key: "tests", label: "Tests", align: "end", sort: (r) => testsPct(r) ?? -1, render: (r) => (testsPct(r) === null ? <span className="dim">not available</span> : <span className="mono">{`${testsPct(r)}%`}</span>) },
    { key: "state", label: "State", sort: (r) => stateOf(r).label, render: (r) => { const s = stateOf(r); return <Chip text={s.label} cls={`${s.cls} onb-status onb-st-${s.id}`} />; } },
  ];
  if (!repos.length) return <Empty id="onb-empty" icon="folder" title="No repos yet" text="Connect a repo from the Wizard tab to start onboarding." />;
  return <DataTable<RepoV> id="onb-table" caption="Repos and their onboarding state" columns={cols} rows={repos} rowKey={(r) => r.id} rowId={(r) => `onb-row-${r.id}`} sort={{ key: "name", dir: 1 }} sortGlyphs pageSize={10} pager />;
}
