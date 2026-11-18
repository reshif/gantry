/** Model prices and project budgets in the Blueprint layout. */
import { useState } from "react";
import { fmt, type Project, type Vendor } from "@gantry/domain";
import { hashFor, navigate } from "../../lib/router";
import { Btn, Chip, FilterBar, Panel, SearchBox } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/SortTable";
import { allModels, usd } from "./kit";

/** Model prices (Blueprint §1): a read table; publishing a new price version is the extra action. */
export function ModelPrices({ vendors }: { vendors: Vendor[] }) {
  const [q, setQ] = useState("");
  const models = allModels(vendors);
  const term = q.trim().toLowerCase();
  const rows = models.filter((m) => !term || `${m.name}${m.vendorName}`.toLowerCase().includes(term));
  const cols: SortCol<(typeof models)[number]>[] = [
    { key: "name", label: "Model", sort: (m) => m.name.toLowerCase(), render: (m) => <div>{m.name}<span className="sub">{m.vendorName}</span></div> },
    { key: "ctx", label: "Context", align: "end", sort: (m) => m.context || 0, render: (m) => fmt.k(m.context || 0) },
    { key: "in", label: "$ in / M", align: "end", sort: (m) => m.inPrice || 0, render: (m) => <span className="num">{m.inPrice || ""}</span> },
    { key: "out", label: "$ out / M", align: "end", sort: (m) => m.outPrice || 0, render: (m) => <span className="num">{m.outPrice || ""}</span> },
    { key: "en", label: "State", render: (m) => <Chip text={m.enabled ? "enabled" : "disabled"} cls={m.enabled ? "ok" : "plain"} /> },
  ];
  return (
    <Panel title="Model prices" flush>
      <FilterBar label="Filter models" count={`${rows.length} model${rows.length === 1 ? "" : "s"}${rows.length !== models.length ? ` of ${models.length}` : ""}`}>
        <SearchBox id="md-price-search" value={q} onChange={setQ} placeholder="Search…" label="Search models" />
      </FilterBar>
      <DataTable id="md-prices" caption="Model prices" columns={cols} rows={rows} rowKey={(m) => m.id} pageSize={12} pager sortSelect={false}
        empty={{ title: "Nothing matches these filters", text: "Loosen the search or clear the filters.", action: <Btn label="Clear filters" onClick={() => setQ("")} /> }} />
    </Panel>
  );
}

/** Project budgets, this month (Blueprint §2): name link, spend over budget, a meter that turns amber past the alert. */
export function ProjectBudgets({ projects }: { projects: Project[] }) {
  return (
    <Panel title="Project budgets, this month">
      <div className="stack">
        {projects.map((p) => {
          const r = p.budget.monthly ? p.budget.mtd / p.budget.monthly : 0;
          return (
            <div key={p.id}>
              <div className="row">
                <a href={hashFor("project-config", null, p.id)} onClick={(e) => { e.preventDefault(); navigate("project-config", null, p.id); }}>{p.name}</a>
                <span className="spacer" />
                <span className="num small">{`${usd(p.budget.mtd)} / ${usd(p.budget.monthly)}`}</span>
              </div>
              <div className={`meter${r > p.budget.alertAt ? " warn" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, r) * 100)} aria-label={`${p.name} spend vs budget`}><i style={{ width: `${Math.min(1, r) * 100}%` }} /></div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
