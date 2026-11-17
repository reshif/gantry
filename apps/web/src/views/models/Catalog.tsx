/** The Models tab in the Control Room layout: one table of every model (tier, context, price, used at, enabled) beside spend by vendor. */
import { useMemo, useState } from "react";
import { fmt, type Agent, type Routing, type Vendor } from "@gantry/domain";
import { useCan } from "../../api/can";
import { Chip, FilterBar, Meter, SearchBox, Select, Toggle, reasonText } from "../../ui/primitives";
import { Card } from "../../ui/cr";
import { DataTable, type SortCol } from "../../ui/DataTable";
import { useModelSwitch } from "./Vendor";
import { dec, no, usedBy } from "./kit";

type Row = { id: string; name: string; tier: string; context: number; inPrice: number; outPrice: number; enabled: boolean; needsPrice: boolean; invocable: boolean; vendor: Vendor };
const tierTone = (t: string): string => (t === "frontier" ? "agent" : t === "fast" ? "ok" : "info");

export function ModelCatalog({ vendors, routing, agents }: { vendors: Vendor[]; routing: Routing; agents: Agent[] }) {
  const setEnabled = useModelSwitch();
  const perm = dec(useCan("model.edit"));
  const [q, setQ] = useState("");
  const [vendor, setVendor] = useState("");
  const [tier, setTier] = useState("");
  const all: Row[] = useMemo(() => vendors.flatMap((v) => v.models.map((m) => ({ id: m.id, name: m.name, tier: m.tier ?? "standard", context: m.context || 0, inPrice: m.inPrice, outPrice: m.outPrice, enabled: m.enabled, needsPrice: !!m.needsPrice, invocable: m.invocable !== false, vendor: v }))), [vendors]);
  const term = q.trim().toLowerCase();
  const rows = all.filter((m) => (!vendor || m.vendor.id === vendor) && (!tier || m.tier === tier) && (!term || `${m.name} ${m.id}`.toLowerCase().includes(term)));
  const tiers = [...new Set(all.map((m) => m.tier))];
  const lockFor = (m: Row) => !perm.allowed ? perm
    : !m.vendor.connected ? no(`Connect ${m.vendor.name} first.`)
    : !m.enabled && !m.invocable ? no("The model gateway cannot call this vendor's models yet.")
    : m.enabled && routing.defaultModel === m.id ? no("This is the factory default model. Pick another default first.")
    : m.enabled && usedBy(agents, m.id).some((a) => a.model === m.id) ? no("Primary model of an agent. Change that agent first.") : null;
  const cols: SortCol<Row>[] = [
    { key: "name", label: "Model", sort: (m) => m.name.toLowerCase(), render: (m) => { const l = lockFor(m); return <span className="stack" style={{ gap: 0 }}><b className="ell">{m.name}</b><span className="mono dim ell" style={{ fontSize: 11 }} title={l && perm.allowed ? reasonText(l) : undefined}>{`${m.id} \u00b7 ${m.vendor.name}`}</span></span>; } },
    { key: "tier", label: "Tier", sort: true, render: (m) => <Chip text={m.tier} cls={tierTone(m.tier)} /> },
    { key: "context", label: "Context", sort: true, align: "end", render: (m) => <span className="mono">{fmt.k(m.context)}</span> },
    { key: "price", label: "In / out per Mtok", sort: (m) => m.outPrice, align: "end", render: (m) => m.needsPrice ? <span className="warn-text">needs a price</span> : <span className="mono">{m.inPrice || m.outPrice ? `$${m.inPrice} / $${m.outPrice}` : "self-hosted"}</span> },
    { key: "use", label: "Used at", render: (m) => { const u = usedBy(agents, m.id); return u.length ? <span className="tag" title={u.map((a) => a.name).join(", ")}>{`${u.length} agent${u.length > 1 ? "s" : ""}`}</span> : <span className="dim">{"\u2014"}</span>; } },
    { key: "en", label: "On", render: (m) => <Toggle id={`mc-${m.id}`} checked={m.enabled} label={`Enable ${m.name}`} decision={lockFor(m)} onChange={(on) => setEnabled(m.id, on)} /> },
  ];
  const spend = vendors.filter((v) => v.connected);
  const top = Math.max(1, ...spend.map((v) => v.mtd || 0));
  return (
    <div className="grid g-main">
      <div>
        <FilterBar label="Filter models" count={`${rows.length} of ${all.length}`}>
          <SearchBox id="mc-search" value={q} onChange={setQ} placeholder="Search models" />
          <Select id="mc-vendor" aria-label="Vendor" value={vendor} onChange={setVendor} options={[{ value: "", label: "Vendor: all" }, ...vendors.map((v) => ({ value: v.id, label: `Vendor: ${v.name}` }))]} />
          <Select id="mc-tier" aria-label="Tier" value={tier} onChange={setTier} options={[{ value: "", label: "Tier: all" }, ...tiers.map((t) => ({ value: t, label: `Tier: ${t}` }))]} />
        </FilterBar>
        <DataTable id="mc-table" caption="Models" columns={cols} rows={rows} rowKey={(m) => m.id} pageSize={12} pager empty={{ title: "No models match", text: "Clear a filter to see every model." }} />
      </div>
      <Card title="Spend by vendor" hint="Month to date, against budget">
        <div className="stack" style={{ gap: 10 }}>
          {spend.map((v) => (
            <div key={v.id}>
              <div className="row spread"><span className="ell">{v.name}</span><span className="mono">{fmt.money0(v.mtd || 0)}</span></div>
              <Meter value={v.mtd || 0} max={v.budget || top} label={`${v.name} spend`} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
