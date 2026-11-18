/** Price versions with effective dates (spec 10.4 Prices) and the per-work-order cost cap (spec 10.4 Budget). */
import { useState } from "react";
import { fmt, type Project, type Vendor } from "@gantry/domain";
import { hashFor, navigate } from "../../lib/router";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useBudgets, usePrices, type BudgetRow, type PriceVersion } from "../../api/queries";
import { Btn, Chip, Field, FilterBar, LockNote, Meter, Panel, SearchBox } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/SortTable";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { allModels, dec, usd } from "./kit";

const nowLocal = (): string => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

function PublishPricesBody({ vendors, close }: { vendors: Vendor[]; close: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const q = usePrices();
  const versions: PriceVersion[] = q.data?.versions ?? [];
  const models = allModels(vendors);
  const cur = versions.find((v) => v.version === q.data?.current);
  // Edits are kept per model (input, output); only models whose numbers differ from the price in force are published, as one version with one note.
  const [edits, setEdits] = useState<Record<string, { in?: string; out?: string }>>({});
  const [eff, setEff] = useState(nowLocal());
  const [note, setNote] = useState("");
  const now = Date.now();
  const setField = (id: string, k: "in" | "out", v: string) => setEdits((e) => ({ ...e, [id]: { ...e[id], [k]: v } }));
  const shown = (id: string, k: "in" | "out"): string => edits[id]?.[k] ?? (cur?.prices[id] ? String(cur.prices[id]![k]) : "");
  const publish = async () => {
    const out: Record<string, { in: number; out: number }> = {};
    let bad = false;
    for (const m of models) {
      const i = shown(m.id, "in");
      const o = shown(m.id, "out");
      const was = cur?.prices[m.id];
      if (was && i === String(was.in) && o === String(was.out)) continue;
      if (!was && i === "" && o === "") continue;
      const ni = Number(i);
      const no = Number(o);
      if (i === "" || o === "" || !(ni >= 0) || !(no >= 0)) { bad = true; continue; }
      out[m.id] = { in: ni, out: no };
    }
    if (bad) { ui.toast("Prices are numbers per million tokens, for both input and output.", "error"); return; }
    if (!Object.keys(out).length) { ui.toast("Nothing to publish: no price changed.", "error"); return; }
    const at = new Date(eff).getTime();
    const r = await ops.publishPrices(out, Number.isFinite(at) && at > now + 60_000 ? new Date(at).toISOString() : undefined, note.trim() || undefined);
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (r.ok) close();
  };
  return (
      <div className="md-prices">
        <LockNote decision={perm} what="Prices" />
        <p className="muted small">US dollars. Change as many models as you like; everything you changed goes out as one price version with one note.</p>
        <form id="pv-form" onSubmit={(e) => { e.preventDefault(); void publish(); }}>
          <div className="table-scroll">
            <table className="table table-compact" id="pv-edit">
              <thead><tr><th scope="col">Model</th><th scope="col">Input $ / Mtok</th><th scope="col">Output $ / Mtok</th></tr></thead>
              <tbody>
                {models.map((m) => {
                  const was = cur?.prices[m.id];
                  return (
                    <tr key={m.id}>
                      <td><b>{m.name}</b> <span className="small muted">{m.vendorName}</span>{was ? null : <span className="chip chip-warn"> needs a price</span>}<div className="mono small muted">{m.id}</div></td>
                      <td><input id={`pv-in-${m.id}`} className="input mono md-price-in" type="number" min="0" step="0.01" aria-label={`Input price per million tokens for ${m.name}`} value={shown(m.id, "in")} disabled={!perm.allowed} onChange={(e) => setField(m.id, "in", e.target.value)} />{was ? <div className="small muted">Now {was.in}</div> : null}</td>
                      <td><input id={`pv-out-${m.id}`} className="input mono md-price-in" type="number" min="0" step="0.01" aria-label={`Output price per million tokens for ${m.name}`} value={shown(m.id, "out")} disabled={!perm.allowed} onChange={(e) => setField(m.id, "out", e.target.value)} />{was ? <div className="small muted">Now {was.out}</div> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="rule-form md-price-form">
            <Field label="Effective from" htmlFor="pv-eff" hint="Now, or a later time to schedule the version."><input id="pv-eff" className="input mono" type="datetime-local" value={eff} min={nowLocal()} disabled={!perm.allowed} onChange={(e) => setEff(e.target.value)} /></Field>
            <Field label="Note" htmlFor="pv-note"><input id="pv-note" className="input" value={note} disabled={!perm.allowed} placeholder="Why the prices changed" onChange={(e) => setNote(e.target.value)} /></Field>
            <Btn label="Publish prices" kind="primary" type="submit" icon="plus" id="pv-add" guard={perm} />
          </div>
        </form>
    </div>
  );
}

/** Model prices (Blueprint §1): a read table; publishing a new price version is the extra action. */
export function ModelPrices({ vendors }: { vendors: Vendor[] }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const [q, setQ] = useState("");
  const models = allModels(vendors);
  const term = q.trim().toLowerCase();
  const rows = models.filter((m) => !term || `${m.name}${m.vendorName}`.toLowerCase().includes(term));
  const cols: SortCol<(typeof models)[number]>[] = [
    { key: "name", label: "Model", sort: (m) => m.name.toLowerCase(), render: (m) => <div>{m.name}<span className="sub">{m.vendorName}</span></div> },
    { key: "ctx", label: "Context", align: "end", sort: (m) => m.context || 0, render: (m) => fmt.k(m.context || 0) },
    { key: "in", label: "$ in / M", align: "end", sort: (m) => m.inPrice || 0, render: (m) => <span className="num">{m.inPrice}</span> },
    { key: "out", label: "$ out / M", align: "end", sort: (m) => m.outPrice || 0, render: (m) => <span className="num">{m.outPrice}</span> },
    { key: "en", label: "State", render: (m) => <Chip text={m.enabled ? "enabled" : "disabled"} cls={m.enabled ? "ok" : "plain"} /> },
  ];
  return (
    <Panel title="Model prices" flush tools={<Btn label="Publish prices" small id="pv-open" guard={perm} onClick={() => ui.open((close) => <Dialog title="Publish prices" kicker="Models · prices" wide onClose={close} body={<PublishPricesBody vendors={vendors} close={close} />} actions={[{ label: "Close" }]} />)} />}>
      <FilterBar label="Filter models" count={`${rows.length} model${rows.length === 1 ? "" : "s"}${rows.length !== models.length ? ` of ${models.length}` : ""}`}>
        <SearchBox id="md-price-search" value={q} onChange={setQ} placeholder="Search…" label="Search models" />
      </FilterBar>
      <DataTable id="md-prices" caption="Model prices" columns={cols} rows={rows} rowKey={(m) => m.id} pageSize={12} pager
        empty={{ title: "Nothing matches these filters", text: "Loosen the search or clear the filters.", action: <Btn label="Clear filters" onClick={() => setQ("")} /> }} />
    </Panel>
  );
}

/** Project budgets, this month (Blueprint §2): name link, spend over budget, a meter that turns amber past the alert. */
export function ProjectBudgets({ projects }: { projects: Project[] }) {
  const live = projects.filter((p) => p.status !== "archived");
  return (
    <Panel title="Project budgets, this month">
      <div className="stack">
        {live.map((p) => {
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

export function PriceVersions() {
  const actor = useActors();
  const q = usePrices();
  const versions: PriceVersion[] = q.data?.versions ?? [];
  const now = Date.now();
  return (
      <Panel title="Price versions">
        <p className="muted small">Each call is costed at the price version in force when it is recorded. A published version never changes; a new price takes effect from its date, never in the past.</p>
        <div className="table-scroll">
          <table className="table table-compact" id="pv-table">
            <thead><tr><th scope="col">Version</th><th scope="col">Effective</th><th scope="col">Published by</th><th scope="col">Note</th><th scope="col" className="num">Models priced</th></tr></thead>
            <tbody>
              {versions.length ? null : <tr><td colSpan={5} className="small muted">No price version yet.</td></tr>}
              {versions.slice(0, 8).map((v) => {
                const t = Date.parse(v.effectiveFrom);
                return (
                  <tr key={v.version}>
                    <td className="mono">v{v.version}{v.version === q.data?.current ? <span className="chip chip-accent"> in force</span> : t > now ? <span className="chip chip-warn"> scheduled</span> : null}</td>
                    <td className="mono small">{`${fmt.istDate(t)} ${fmt.ist(t)}`}</td>
                    <td className="small">{v.publishedBy ? actor(v.publishedBy).name : "–"}</td>
                    <td className="small">{v.note || <span className="muted">–</span>}</td>
                    <td className="num mono">{Object.keys(v.prices).length}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
    </Panel>
  );
}

/** What each vendor has spent this month against its budget. Read-only: a vendor's budget is set on its card in Vendors. */
export function VendorBudgets({ vendors }: { vendors: Vendor[] }) {
  return (
    <Panel title="Vendor budgets" cls="md-vendor-budgets">
      <p className="muted small">Month to date against each vendor&apos;s budget. Change a budget on the vendor&apos;s card.</p>
      <div className="table-scroll">
        <table className="table table-compact" id="vb-table">
          <thead><tr><th scope="col">Vendor</th><th scope="col" className="num">Budget</th><th scope="col" className="num">Spent this month</th><th scope="col">Used</th></tr></thead>
          <tbody>
            {vendors.map((v) => (
              <tr key={v.id}>
                <td>{v.name}</td>
                <td className="num mono">{v.budget ? fmt.money0(v.budget) : "none set"}</td>
                <td className="num mono">{fmt.money0(v.mtd || 0)}</td>
                <td className="md-vb-meter">{v.budget ? <Meter value={v.mtd || 0} max={v.budget} label={`${v.name} spend vs budget`} warnAt={0.8} /> : <span className="small muted">–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function WoCaps({ projects }: { projects: Project[] }) {
  const q = useBudgets();
  const rows = q.data ?? [];
  const live = projects.filter((p) => p.status !== "archived" && rows.some((r) => r.project === p.id));
  return (
    <Panel title="Per-work-order caps" cls="md-budgets">
      <p className="muted small">The project&apos;s monthly budget is set in its configuration. The cap below applies to each work order in the project; a work order may carry its own. When a cap is spent the gateway refuses the next call and the work order is halted with cause budget.</p>
      <div className="table-scroll">
        <table className="table table-compact" id="bd-table">
          <thead><tr><th scope="col">Project</th><th scope="col" className="num">Monthly</th><th scope="col" className="num">Spent MTD</th><th scope="col">Per work order (USD)</th></tr></thead>
          <tbody>
            {live.map((p) => <BudgetRowView key={p.id} p={p} row={rows.find((r) => r.project === p.id)!} />)}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function BudgetRowView({ p, row }: { p: Project; row: BudgetRow }) {
  const ui = useUI();
  const perm = dec(useCan("project.config", { project: p.id }));
  const [v, setV] = useState(String(row.perWorkOrder || ""));
  return (
    <tr>
      <td>{p.name}</td>
      <td className="num mono">{row.monthly ? fmt.money0(row.monthly) : "–"}</td>
      <td className="num mono">{fmt.money0(row.spent)}</td>
      <td>
        <span className="md-bd-edit">
          <input id={`bd-wo-${p.id}`} className="input mono" type="number" min="0" step="1" aria-label={`Per work order cap for ${p.name}`} value={v} placeholder="none" disabled={!perm.allowed} onChange={(e) => setV(e.target.value)} />
          <Btn small label="Save" id={`bd-save-${p.id}`} guard={perm} onClick={() => void (async () => {
            const n = v === "" ? 0 : Number(v);
            if (!(n >= 0)) { ui.toast("Enter a number of dollars, or leave it empty for no cap.", "error"); return; }
            const r = await ops.setWoBudget(p.id, n);
            ui.toast(r.msg, r.ok ? "ok" : "error");
          })()} />
        </span>
      </td>
    </tr>
  );
}
