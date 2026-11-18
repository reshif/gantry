/** The Models tab in the Control Room layout: one table of every model (tier, context, price, used at, enabled) beside spend by vendor. */
import { useMemo, useState } from "react";
import { usePublishPrice } from "../../api/modelCommands";
import { NumberInput } from "../../lib/NumberInput";
import { useRouteState, useDebouncedParam } from "../../lib/routeState";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { fmt, type Agent, type Routing, type Vendor } from "@gantry/domain";
import { useCan } from "../../api/can";
import { Btn, Chip, Field, FilterBar, Meter, SearchBox, Select, Toggle, reasonText } from "../../ui/primitives";
import { Card } from "../../ui/cr";
import { DataTable, type SortCol } from "../../ui/DataTable";
import { useModelSwitch } from "./Vendor";
import { dec, no, usedBy } from "./kit";

type Row = { id: string; name: string; tier: string; context: number; inPrice: number; outPrice: number; enabled: boolean; needsPrice: boolean; invocable: boolean; vendor: Vendor };
const tierTone = (t: string): string => (t === "frontier" ? "agent" : t === "fast" ? "ok" : "info");

/** Set price (prototype dialog): input and output USD per million tokens, both above zero; published as one price version. */
function SetPriceDialog({ m, close }: { m: Row; close: () => void }) {
  const ui = useUI();
  const [i, setI] = useState("");
  const [o, setO] = useState("");
  const [err, setErr] = useState("");
  const publish = usePublishPrice();
  const submit = (done: () => void): void => {
    const ni = Number(i), no = Number(o);
    if (!(ni > 0) || !(no > 0)) { setErr("Prices must be above zero."); ui.toast("Prices must be above zero.", "warn"); return; }
    void publish.run(m.id, m.name, ni, no).then((r) => {
      if (!r) return;
      if (!r.ok) { setErr(r.msg); return; }
      ui.toast("Price saved. You can now enable it.", "ok");
      done();
    });
  };
  return (
    <Dialog title={`Set price for ${m.name}`} onClose={close} dirty={!!(i || o)}
      body={(
        <div className="form-grid">
          <Field label="Input USD per million tokens" htmlFor="sp-in"><NumberInput id="sp-in" value={i} onChange={setI} /></Field>
          <Field label="Output USD per million tokens" htmlFor="sp-out" error={err || undefined}><NumberInput id="sp-out" value={o} onChange={setO} /></Field>
        </div>
      )}
      actions={[{ label: "Cancel" }, { label: "Save price", kind: "primary", submit: true, id: "sp-save", onClick: submit }]} />
  );
}

export function ModelCatalog({ vendors, routing, agents }: { vendors: Vendor[]; routing: Routing; agents: Agent[] }) {
  const setEnabled = useModelSwitch();
  const perm = dec(useCan("model.edit"));
  const ui = useUI();
  const [r, setR] = useRouteState({ q: "", tier: "", sort: "name", dir: "asc" });
  const [qText, setQText] = useDebouncedParam(r.q, (v) => setR({ q: v }));
  const tier = r.tier;
  const all: Row[] = useMemo(() => vendors.flatMap((v) => v.models.map((m) => ({ id: m.id, name: m.name, tier: m.tier ?? "standard", context: m.context || 0, inPrice: m.inPrice, outPrice: m.outPrice, enabled: m.enabled, needsPrice: !!m.needsPrice, invocable: m.invocable !== false, vendor: v }))), [vendors]);
  const term = qText.trim().toLowerCase();
  const rows = all.filter((m) => (!tier || m.tier === tier) && (!term || `${m.name} ${m.id}`.toLowerCase().includes(term)));
  const TIER_ORDER = ["frontier", "standard", "fast"];
  const tiers = [...TIER_ORDER, ...new Set(all.map((m) => m.tier)).values()].filter((t, i, l) => l.indexOf(t) === i);
  /** Locks that stop the switch from being used at all (permission, price, vendor). */
  const lockFor = (m: Row) => !perm.allowed ? perm
    : m.needsPrice && !m.enabled ? no("Set a price first.")
    : !m.vendor.connected ? no(`Connect ${m.vendor.name} first.`)
    : !m.enabled && !m.invocable ? no("The model gateway cannot call this vendor's models yet.") : null;
  /** Refusals on switching off a model in use: the switch stays full colour and the click says why (nothing is written). */
  const inUse = (m: Row) => m.enabled && routing.defaultModel === m.id ? "This is the factory default model. Pick another default first."
    : m.enabled && usedBy(agents, m.id).some((a) => a.model === m.id) ? "Primary model of an agent. Change that agent first." : null;
  const cols: SortCol<Row>[] = [
    { key: "name", label: "Model", sort: (m) => m.name.toLowerCase(), render: (m) => { const l = lockFor(m) ?? (inUse(m) ? no(inUse(m)!) : null); return <span className="md-name"><b className="ell">{m.name}</b><span className="mono dim ell" style={{ fontSize: 11 }} title={l && perm.allowed ? reasonText(l) : undefined}>{m.id}</span></span>; } },
    { key: "tier", label: "Tier", sort: true, render: (m) => <Chip text={m.tier} cls={`${tierTone(m.tier)} plain`} /> },
    { key: "context", label: "Context", sort: true, align: "end", render: (m) => <span className="mono">{fmt.k(m.context)}</span> },
    { key: "price", label: "In / out per Mtok", sort: (m) => m.outPrice, align: "end", render: (m) => m.needsPrice ? <Btn label="Set price" small id={`mc-price-${m.id}`} guard={perm} onClick={() => ui.open((close) => <SetPriceDialog m={m} close={close} />)} /> : <span className="mono">{m.inPrice || m.outPrice ? `$${m.inPrice} / $${m.outPrice}` : "self-hosted"}</span> },
    { key: "use", label: "Used at", render: (m) => { const at = Object.entries(routing.overrides ?? {}).filter(([, id]) => id === m.id).map(([s]) => s); return at.length ? <span className="row">{at.map((s) => <span key={s} className="tag">{s}</span>)}</span> : <span className="dim">{"\u2014"}</span>; } },
    { key: "en", label: "Enabled", render: (m) => <Toggle id={`mc-${m.id}`} checked={m.enabled} label={`${m.name} enabled`} decision={lockFor(m)} onChange={(on) => { const why = inUse(m); if (why) { ui.toast(why, "warn"); return; } setEnabled(m.id, on); }} /> },
  ];
  const any = !!(r.q || r.tier);
  const clear = (): void => { setQText(""); setR({ q: "", tier: "" }); };
  return (
    <div className="grid g-main">
      <div>
        <FilterBar label="Filter models" count={`${rows.length} of ${all.length}`} actions={any ? <Btn label="Clear" small kind="ghost" id="mc-clear" onClick={clear} /> : undefined}>
          <SearchBox id="mc-search" value={qText} onChange={setQText} placeholder="Search models" />
          <Select id="mc-tier" aria-label="Tier" value={tier} onChange={(v) => setR({ tier: v })} options={[{ value: "", label: "Tier: all" }, ...tiers.map((t) => ({ value: t, label: t }))]} />
        </FilterBar>
        <DataTable id="mc-table" caption="Models" columns={cols} rows={rows} rowKey={(m) => m.id} pageSize={12} pager sort={{ key: r.sort, dir: r.dir === "desc" ? -1 : 1 }} onSort={(x) => setR({ sort: x.key, dir: x.dir === -1 ? "desc" : "asc" })}
          empty={{ title: "Nothing matches", text: "Try clearing a filter or searching for something else.", action: <Btn label="Clear filters" id="mc-empty-clear" onClick={clear} /> }} />
      </div>
      <Card title="Spend by model" hint="Last 30 days">
        <div className="stack" style={{ gap: 10 }}>
          {all.filter((m) => m.enabled).map((m) => (
            <div key={m.id}>
              <div className="row spread"><span className="ell">{m.name}</span><span className="mono dim">not available</span></div>
              <Meter value={0} max={1} label={`${m.name} spend`} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
