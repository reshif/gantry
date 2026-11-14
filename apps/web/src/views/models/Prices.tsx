/** Price versions with effective dates (spec 10.4 Prices) and the per-work-order cost cap (spec 10.4 Budget). */
import { useState } from "react";
import { fmt, type Project, type Vendor } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useBudgets, usePrices, type BudgetRow, type PriceVersion } from "../../api/queries";
import { Btn, Field, LockNote, Panel, Select } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { allModels, dec } from "./kit";

const nowLocal = (): string => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

export function PricesPanel({ vendors }: { vendors: Vendor[] }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const actor = useActors();
  const q = usePrices();
  const versions: PriceVersion[] = q.data?.versions ?? [];
  const models = allModels(vendors);
  const [model, setModel] = useState("");
  const [pin, setPin] = useState("");
  const [pout, setPout] = useState("");
  const [eff, setEff] = useState(nowLocal());
  const [note, setNote] = useState("");
  const sel = model || models[0]?.id || "";
  const cur = versions.find((v) => v.version === q.data?.current);
  const now = Date.now();
  const publish = async () => {
    if (!sel) return;
    const i = Number(pin);
    const o = Number(pout);
    if (!(i >= 0) || !(o >= 0) || pin === "" || pout === "") { ui.toast("Prices are numbers per million tokens.", "error"); return; }
    const at = new Date(eff).getTime();
    const r = await ops.publishPrices({ [sel]: { in: i, out: o } }, Number.isFinite(at) && at > now + 60_000 ? new Date(at).toISOString() : undefined, note.trim() || undefined);
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (r.ok) { setPin(""); setPout(""); setNote(""); setEff(nowLocal()); }
  };
  return (
    <Panel title="Price versions" cls="md-prices">
      <LockNote decision={perm} what="Prices" />
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
      <form className="rule-form md-price-form" id="pv-form" onSubmit={(e) => { e.preventDefault(); void publish(); }}>
        <Field label="Model" htmlFor="pv-model"><Select id="pv-model" disabled={!perm.allowed} options={models.map((m) => ({ value: m.id, label: `${m.name} · ${m.vendorName}` }))} value={sel} onChange={setModel} /></Field>
        <Field label="Input $ / Mtok" htmlFor="pv-in" hint={cur?.prices[sel] ? `Now ${cur.prices[sel]!.in}` : undefined}><input id="pv-in" className="input mono" type="number" min="0" step="0.01" value={pin} disabled={!perm.allowed} onChange={(e) => setPin(e.target.value)} /></Field>
        <Field label="Output $ / Mtok" htmlFor="pv-out" hint={cur?.prices[sel] ? `Now ${cur.prices[sel]!.out}` : undefined}><input id="pv-out" className="input mono" type="number" min="0" step="0.01" value={pout} disabled={!perm.allowed} onChange={(e) => setPout(e.target.value)} /></Field>
        <Field label="Effective from" htmlFor="pv-eff"><input id="pv-eff" className="input mono" type="datetime-local" value={eff} min={nowLocal()} disabled={!perm.allowed} onChange={(e) => setEff(e.target.value)} /></Field>
        <Field label="Note" htmlFor="pv-note"><input id="pv-note" className="input" value={note} disabled={!perm.allowed} placeholder="Why the price changed" onChange={(e) => setNote(e.target.value)} /></Field>
        <Btn label="Publish price" kind="primary" type="submit" icon="plus" id="pv-add" guard={perm} />
      </form>
    </Panel>
  );
}

export function BudgetsPanel({ projects }: { projects: Project[] }) {
  const q = useBudgets();
  const rows = q.data ?? [];
  const live = projects.filter((p) => p.status !== "archived" && rows.some((r) => r.project === p.id));
  return (
    <Panel title="Work-order budgets" cls="md-budgets">
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
