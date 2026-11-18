/** Runs tab (prototype): every suite run in one table, newest first, searchable. A run id opens that run in its suite's detail. */
import { fmt } from "@gantry/domain";
import { Avatar, Btn, Empty, FilterBar, SearchBox } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/DataTable";
import { agentOf, evalsUi, ScoreMeter, type EvalsData, type RunRow } from "./kit";

type Url = { tab: string; q: string; sort: string; dir: string; suite: string; run: string };

export function RunsTab({ d, url, setUrl }: { d: EvalsData; url: Url; setUrl: (p: Partial<Url>) => void }) {
  const term = url.q.trim().toLowerCase();
  const nameOf = (r: RunRow): string => agentOf(d, r.agent)?.name ?? r.agent;
  const rows = d.runs.filter((r) => !term || `${r.id} ${r.suite} ${nameOf(r)} ${r.agent}`.toLowerCase().includes(term));
  const cols: SortCol<RunRow>[] = [
    { key: "id", label: "Run", sort: (r) => r.id, render: (r) => <a className="mono rl" href="#evals" id={`ev-runs-open-${r.id}`} aria-label={`Open run ${r.id} in suite ${r.suite}`} onClick={(e) => { e.preventDefault(); evalsUi.a = evalsUi.b = null; setUrl({ tab: "suites", q: "", sort: "", dir: "", suite: r.suite, run: r.id }); }}>{r.id}</a> },
    { key: "suite", label: "Suite", sort: (r) => r.suite, render: (r) => <span className="mono">{r.suite}</span> },
    { key: "agent", label: "Agent", sort: (r) => nameOf(r).toLowerCase(), render: (r) => <span className="who"><Avatar id={r.agent} size="sm" /><span>{nameOf(r)}</span></span> },
    { key: "version", label: "Version", sort: (r) => r.version, render: (r) => <span className="mono">{r.version}</span> },
    { key: "at", label: "When", sort: (r) => r.at, render: (r) => <span className="mono dim">{fmt.ago(r.at, Date.now())}</span> },
    { key: "score", label: "Score", sort: (r) => r.score, render: (r) => r.status === "completed" ? <ScoreMeter score={r.score} gate={0.85} label={`${r.id} score`} /> : <span className="dim mono">{r.status}</span> },
  ];
  const sort = { key: url.sort || "at", dir: (url.sort ? (url.dir === "desc" ? -1 : 1) : -1) as 1 | -1 };
  return (
    <div className="ev-runs">
      <FilterBar label="Filter runs" count={`${rows.length} of ${d.runs.length}`} actions={url.q ? <Btn label="Clear" small kind="ghost" id="ev-runs-clear" onClick={() => setUrl({ q: "" })} /> : undefined}>
        <SearchBox id="ev-runs-search" value={url.q} onChange={(v) => setUrl({ q: v })} placeholder="Search runs" />
      </FilterBar>
      {rows.length ? (
        <DataTable id="ev-runs-table" caption="Eval runs" columns={cols} rows={rows} rowKey={(r) => r.id} pageSize={12} pager sort={sort} onSort={(s) => setUrl({ sort: s.key, dir: s.dir === -1 ? "desc" : "asc" })} />
      ) : <Empty icon="search" title="Nothing matches" text="Try clearing a filter or searching for something else." action={<Btn label="Clear filters" id="ev-runs-clear-empty" onClick={() => setUrl({ q: "" })} />} />}
    </div>
  );
}
