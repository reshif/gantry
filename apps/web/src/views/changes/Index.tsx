/** The Changes index (prototype): the code changes produced by the line, one row per work order that changed files. Search, a Checks filter and sort live in the URL. */
import { useMemo } from "react";
import type { WorkOrder } from "@gantry/domain";
import { useWorkOrders } from "../../api/queries";
import { useMe } from "../../api/queries";
import { Async } from "../../ui/async";
import { Btn, Chip, Field, FilterBar, Panel, SearchBox, Select, ViewHead } from "../../ui/primitives";
import { DataTable, type Col } from "../../ui/DataTable";
import { hashFor, navigate, useHash } from "../../lib/router";
import { usePrefs } from "../../lib/prefs";
import { pickProject } from "../../lib/routes";
import { useQueryParam } from "../floor/urlState";

/** The prototype's words for a PR's checks; the server says green, pending or red. */
export const CHECKS: Record<string, { label: string; tone: string }> = { green: { label: "passed", tone: "ok" }, pending: { label: "pending", tone: "warn" }, red: { label: "failed", tone: "bad" } };

export function ChangesIndex() {
  const me = useMe();
  const prefs = usePrefs();
  const hash = useHash();
  const projectId = hash.project ?? (me ? pickProject(me, prefs.project) : null);
  const read = useWorkOrders(projectId, { state: "all", limit: 200 });
  const [q, setQ] = useQueryParam("q");
  const [checks, setChecks] = useQueryParam("checks");
  const all = useMemo(() => {
    const d = read.data;
    const items: WorkOrder[] = Array.isArray(d) ? d : (d?.items ?? []);
    return items.filter((w) => (w.diff?.files ?? 0) > 0);
  }, [read.data]);
  const needle = (q ?? "").trim().toLowerCase();
  const rows = all.filter((w) => (!needle || `${w.id} ${w.title}`.toLowerCase().includes(needle)) && (!checks || checks === "all" || (w.pr?.checks ? CHECKS[w.pr.checks]?.label === checks : false)));
  const filtered = !!needle || (!!checks && checks !== "all");
  const clear = () => { setQ(null); setChecks(null); };
  const cols: Col<WorkOrder>[] = [
    { key: "id", label: "Work order", sort: (w) => w.id, render: (w) => <span className="pri-cell"><a className="pri mono" href={hashFor("changes", w.id, w.project)} onClick={(e) => { e.preventDefault(); navigate("changes", w.id, w.project); }}>{w.id}</a><span className="sub trunc" style={{ maxWidth: 340 }}>{w.title}</span></span> },
    { key: "repo", label: "Repo", render: (w) => <span className="mono small">{w.repo}</span> },
    { key: "pr", label: "PR", render: (w) => (w.pr ? `#${w.pr.number} ${w.pr.state}` : "—") },
    { key: "ck", label: "Checks", render: (w) => (w.pr ? <Chip text={w.pr.checks} cls={CHECKS[w.pr.checks]?.tone ?? "plain"} /> : "—") },
    { key: "d", label: "Diff", align: "end", sort: (w) => w.diff.plus + w.diff.minus, render: (w) => <span className="num">{`+${w.diff.plus} −${w.diff.minus}`}</span> },
    { key: "f", label: "Files", align: "end", sort: (w) => w.diff.files, render: (w) => w.diff.files },
  ];
  return (
    <div className="view rec-view" id="chg-index">
      <ViewHead plain title="Changes" sub="Code changes produced by the line, one row per work order." />
      <Panel flush>
        <Async query={read} what="the changes" id="chg-index-read" isEmpty={() => false}>
          {() => (
            <>
              <FilterBar label="Filter changes" count={`${rows.length} ${rows.length === 1 ? "change" : "changes"}`} actions={filtered ? <Btn label="Clear" small kind="ghost" id="chg-clear" onClick={clear} /> : undefined}>
                <SearchBox id="chg-q" value={q ?? ""} onChange={(v) => setQ(v || null)} placeholder="Search id or title" label="Search" />
                <Field label="Checks" htmlFor="chg-f-checks">
                  <Select id="chg-f-checks" options={[{ value: "all", label: "All" }, ...["passed", "pending", "failed"].map((v) => ({ value: v, label: v }))]} value={checks ?? "all"} onChange={(v) => setChecks(v === "all" ? null : v)} />
                </Field>
              </FilterBar>
              <DataTable
                id="chg-table"
                caption="Changes by work order"
                columns={cols}
                rows={rows}
                rowKey={(w) => w.id}
                rowHref={(w) => hashFor("changes", w.id, w.project)}
                rowLabel={(w) => `Open the changes of ${w.id}`}
                pageSize={12}
                empty={{ title: filtered ? "Nothing matches these filters" : "No changes yet", text: filtered ? "Try fewer filters." : "Work orders that change files appear here.", action: filtered ? <Btn label="Clear filters" id="chg-clear-empty" onClick={clear} /> : undefined }}
              />
            </>
          )}
        </Async>
      </Panel>
    </div>
  );
}
