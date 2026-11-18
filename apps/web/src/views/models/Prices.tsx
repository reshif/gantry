/** Model prices and project budgets in the Blueprint layout. */
import { useState } from "react";
import { fmt, type Project, type Vendor } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { usePrices } from "../../api/queries";
import { useActors } from "../../ui/actors";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { hashFor, navigate } from "../../lib/router";
import { Btn, Chip, Field, FilterBar, LockNote, Panel, SearchBox } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/SortTable";
import { allModels, dec, usd } from "./kit";

/** Model prices (Blueprint §1): a read table; publishing a new price version is the extra action. */
export function ModelPrices({ vendors }: { vendors: Vendor[] }) {
  const [q, setQ] = useState("");
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
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
    <Panel title="Model prices" flush tools={<Btn small kind="primary" icon="plus" label="Publish prices" id="md-publish-prices" guard={perm} onClick={() => ui.open((close) => <PublishPricesDialog vendors={vendors} close={close} />)} />}>
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

const nowLocal = (): string => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/** Multi-model publish: edit any number of prices; everything changed goes out as one price version with one note. */
function PublishPricesDialog({ vendors, close }: { vendors: Vendor[]; close: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const q = usePrices();
  const models = allModels(vendors);
  const cur = (q.data?.versions ?? []).find((v) => v.version === q.data?.current);
  const [edits, setEdits] = useState<Record<string, { in?: string; out?: string }>>({});
  const [eff, setEff] = useState(nowLocal());
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const off = !perm.allowed;
  const setField = (id: string, k: "in" | "out", v: string) => setEdits((e) => ({ ...e, [id]: { ...e[id], [k]: v } }));
  const shown = (id: string, k: "in" | "out"): string => edits[id]?.[k] ?? (cur?.prices[id] ? String(cur.prices[id]![k]) : "");
  const publish = async () => {
    const out: Record<string, { in: number; out: number }> = {};
    for (const m of models) {
      const i = shown(m.id, "in");
      const o = shown(m.id, "out");
      const was = cur?.prices[m.id];
      if (was && i === String(was.in) && o === String(was.out)) continue;
      if (!was && i === "" && o === "") continue;
      const ni = Number(i);
      const no = Number(o);
      if (i === "" || o === "" || !(ni >= 0) || !(no >= 0)) return setErr("Prices are numbers per million tokens, for both input and output.");
      out[m.id] = { in: ni, out: no };
    }
    if (!Object.keys(out).length) return setErr("Nothing to publish: no price changed.");
    const at = new Date(eff).getTime();
    const r = await ops.publishPrices(out, Number.isFinite(at) && at > Date.now() + 60_000 ? new Date(at).toISOString() : undefined, note.trim() || undefined);
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (r.ok) close(); else setErr(r.msg);
  };
  return (
    <Dialog title="Publish prices" kicker="Models · prices" wide onClose={close}
      sub="US dollars per million tokens. Change as many models as you like; everything you changed goes out as one price version with one note."
      actions={[{ label: "Cancel" }, { label: "Publish prices", kind: "primary", submit: true, id: "pv-add", guard: perm, onClick: () => void publish() }]}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what="Prices" />
          <div className="table-scroll">
            <table className="table table-compact" id="pv-edit">
              <thead><tr><th scope="col">Model</th><th scope="col">Input $ / Mtok</th><th scope="col">Output $ / Mtok</th></tr></thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.id}>
                    <td><b>{m.name}</b> <span className="small muted">{m.vendorName}</span></td>
                    <td><input id={`pv-in-${m.id}`} className="input mono" type="number" min="0" step="0.01" aria-label={`Input price per million tokens for ${m.name}`} value={shown(m.id, "in")} disabled={off} onChange={(e) => setField(m.id, "in", e.target.value)} /></td>
                    <td><input id={`pv-out-${m.id}`} className="input mono" type="number" min="0" step="0.01" aria-label={`Output price per million tokens for ${m.name}`} value={shown(m.id, "out")} disabled={off} onChange={(e) => setField(m.id, "out", e.target.value)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-row">
            <Field label="Effective from" htmlFor="pv-eff" hint="Now, or a later time to schedule the version."><input id="pv-eff" className="input mono" type="datetime-local" value={eff} min={nowLocal()} disabled={off} onChange={(e) => setEff(e.target.value)} /></Field>
            <Field label="Note" htmlFor="pv-note"><input id="pv-note" className="input" value={note} disabled={off} placeholder="Why the prices changed" onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
          <div className="form-err" role="alert">{err}</div>
        </div>
      )} />
  );
}

/** Every published price version: effective date, who, note, models priced. Read-only; a new one comes from Publish prices. */
export function PriceVersions() {
  const q = usePrices();
  const actor = useActors();
  const versions = q.data?.versions ?? [];
  const now = Date.now();
  return (
    <Panel title="Price versions">
      <p className="muted small">Each call is costed at the price version in force when it is recorded. A published version never changes; a new price takes effect from its date, never in the past.</p>
      <div className="table-scroll">
        <table className="table table-compact" id="pv-table">
          <thead><tr><th scope="col">Version</th><th scope="col">Effective</th><th scope="col">Published by</th><th scope="col">Note</th><th scope="col" className="num">Models priced</th></tr></thead>
          <tbody>
            {versions.length ? null : <tr><td colSpan={5} className="small muted">{q.isLoading ? "Loading versions." : "No price version yet."}</td></tr>}
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
    <Panel title="Vendor budgets">
      <div className="stack">
        {vendors.map((v) => {
          const r = v.budget ? (v.mtd || 0) / v.budget : 0;
          return (
            <div key={v.id}>
              <div className="row">
                <span>{v.name}</span>
                <span className="spacer" />
                <span className="num small">{v.budget ? `${usd(v.mtd || 0)} / ${usd(v.budget)}` : `${usd(v.mtd || 0)} · no budget set`}</span>
              </div>
              {v.budget ? <div className={`meter${r > 0.8 ? " warn" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, r) * 100)} aria-label={`${v.name} budget used`}><i style={{ width: `${Math.min(1, r) * 100}%` }} /></div> : null}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
