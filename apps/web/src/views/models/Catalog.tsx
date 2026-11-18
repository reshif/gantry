/** The Models tab: vendor summary cards, then one full-width table of every model (tier, context, price or Needs a price, used by, labelled Enabled switch), grouped by vendor and filtered through the URL. */
import { useMemo, useState } from "react";
import { usePublishPrice } from "../../api/modelCommands";
import { NumberInput } from "../../lib/NumberInput";
import { useRouteState, useDebouncedParam } from "../../lib/routeState";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { fmt, type Agent, type Routing, type Vendor } from "@gantry/domain";
import { Icon } from "../../ui/Icon";
import { useCan } from "../../api/can";
import { Btn, Chip, Field, FilterBar, SearchBox, Select, Toggle, reasonText } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/DataTable";
import { useModelSwitch } from "./Vendor";
import { dec, hasEndpoint, no, usedBy } from "./kit";
import { VendorCards } from "./VendorCards";
import { AddVendorDialog } from "./Templates";
import { navigate } from "../../lib/router";

type Row = { id: string; name: string; tier: string; context: number; inPrice: number; outPrice: number; enabled: boolean; needsPrice: boolean; invocable: boolean; vendor: Vendor; used: string[] };
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

/** Where a model is used: routing default, station and class overrides, fallback slot, and the agents that name it. Only what the API holds. */
function usage(routing: Routing, agents: Agent[], id: string): string[] {
  const out: string[] = [];
  if (routing.defaultModel === id) out.push("Factory default");
  for (const [s, m] of Object.entries(routing.overrides ?? {})) if (m === id) out.push(`Station ${s}`);
  for (const [c, m] of Object.entries(routing.classOverrides ?? {})) if (m === id) out.push(`Class ${c}`);
  const fb = (routing.fallback ?? []).indexOf(id);
  if (fb >= 0) out.push(`Fallback ${fb + 1}`);
  for (const a of usedBy(agents, id)) out.push(a.model === id ? a.name : `${a.name} (fallback)`);
  return out;
}

const unpriced = (m: { needsPrice: boolean; inPrice: number; outPrice: number; vendor: Vendor }): boolean => m.needsPrice || (!m.inPrice && !m.outPrice && !hasEndpoint(m.vendor));

export function ModelCatalog({ vendors, routing, agents }: { vendors: Vendor[]; routing: Routing; agents: Agent[] }) {
  const setEnabled = useModelSwitch();
  const perm = dec(useCan("model.edit"));
  const ui = useUI();
  const [r, setR] = useRouteState({ q: "", tier: "", vendor: "", en: "", price: "", group: "vendor", fold: "", sort: "name", dir: "asc" });
  const [qText, setQText] = useDebouncedParam(r.q, (v) => setR({ q: v }));
  const tier = r.tier;
  const all: Row[] = useMemo(() => vendors.flatMap((v) => v.models.map((m) => ({ id: m.id, name: m.name, tier: m.tier ?? "standard", context: m.context || 0, inPrice: m.inPrice, outPrice: m.outPrice, enabled: m.enabled, needsPrice: !!m.needsPrice, invocable: m.invocable !== false, vendor: v, used: usage(routing, agents, m.id) }))), [vendors, routing, agents]);
  const term = qText.trim().toLowerCase();
  const rows = all.filter((m) => (!tier || m.tier === tier) && (!r.vendor || m.vendor.id === r.vendor) && (!r.en || (r.en === "on") === m.enabled) && (!r.price || unpriced(m)) && (!term || `${m.name} ${m.id} ${m.vendor.name}`.toLowerCase().includes(term)));
  const TIER_ORDER = ["frontier", "standard", "fast"];
  const tiers = [...TIER_ORDER, ...new Set(all.map((m) => m.tier)).values()].filter((t, i, l) => l.indexOf(t) === i);
  const grouped = r.group !== "none";
  const folded = new Set(r.fold.split(",").filter(Boolean));
  /** Locks that stop the switch from being used at all (permission, price, vendor). */
  const lockFor = (m: Row) => !perm.allowed ? perm
    : unpriced(m) && !m.enabled ? no("Set a price first.")
    : !m.vendor.connected ? no(`Connect ${m.vendor.name} first.`)
    : !m.enabled && !m.invocable ? no("The model gateway cannot call this vendor's models yet.") : null;
  /** Refusals on switching off a model in use: the switch stays full colour and the click says why (nothing is written). */
  const inUse = (m: Row) => m.enabled && routing.defaultModel === m.id ? "This is the factory default model. Pick another default first."
    : m.enabled && usedBy(agents, m.id).some((a) => a.model === m.id) ? "Primary model of an agent. Change that agent first." : null;
  const setPrice = (m: Row): void => { ui.open((close) => <SetPriceDialog m={m} close={close} />); };
  const cols: SortCol<Row>[] = [
    { key: "name", label: "Model", sort: (m) => m.name.toLowerCase(), render: (m) => { const l = lockFor(m) ?? (inUse(m) ? no(inUse(m)!) : null); return <span className="md-name"><b className="ell">{m.name}</b><span className="mono dim ell" style={{ fontSize: 11 }} title={l && perm.allowed ? reasonText(l) : undefined}>{m.id}</span></span>; } },
    ...(grouped ? [] : [{ key: "vendor", label: "Vendor", sort: (m: Row) => m.vendor.name.toLowerCase(), render: (m: Row) => <span className="ell">{m.vendor.name}</span> }]),
    { key: "tier", label: "Tier", sort: true, render: (m) => <Chip text={m.tier} cls={`${tierTone(m.tier)} plain`} /> },
    { key: "context", label: "Context", sort: true, align: "end", render: (m) => <span className="mono">{fmt.k(m.context)}</span> },
    { key: "price", label: "In / out per Mtok", sort: (m) => (unpriced(m) ? -1 : m.outPrice), align: "end", render: (m) => unpriced(m)
      ? <span className="md-needs"><span className="warn-text small">Needs a price</span><Btn label="Set price" small id={`mc-price-${m.id}`} guard={perm} aria={`Set price for ${m.name}`} onClick={() => setPrice(m)} /></span>
      : <span className="mono">{m.inPrice || m.outPrice ? `$${m.inPrice} / $${m.outPrice}` : "Self-hosted, no per-token price"}</span> },
    { key: "use", label: "Used by", render: (m) => m.used.length ? <span className="md-used" title={m.used.join(", ")}>{m.used.slice(0, 3).map((s) => <span key={s} className="tag">{s}</span>)}{m.used.length > 3 ? <span className="dim small">+{m.used.length - 3}</span> : null}</span> : <span className="dim">Not used yet</span> },
    { key: "en", label: "Enabled", render: (m) => <Toggle id={`mc-${m.id}`} checked={m.enabled} label={`Enable ${m.name}`} decision={lockFor(m)} onChange={(on) => { const why = inUse(m); if (why) { ui.toast(why, "warn"); return; } setEnabled(m.id, on); }} /> },
  ];
  const any = !!(r.q || r.tier || r.vendor || r.en || r.price);
  const clear = (): void => { setQText(""); setR({ q: "", tier: "", vendor: "", en: "", price: "" }); };
  const sortProps = { sort: { key: r.sort, dir: (r.dir === "desc" ? -1 : 1) as 1 | -1 }, onSort: (x: { key: string; dir: 1 | -1 }) => setR({ sort: x.key, dir: x.dir === -1 ? "desc" : "asc" }) };
  const empty = { title: "Nothing matches", text: "Try clearing a filter or searching for something else.", action: <Btn label="Clear filters" id="mc-empty-clear" onClick={clear} /> };
  const toggleFold = (id: string): void => { const s = new Set(folded); if (s.has(id)) s.delete(id); else s.add(id); setR({ fold: [...s].join(",") }); };
  const groups = vendors.map((v) => ({ v, rows: rows.filter((m) => m.vendor.id === v.id) })).filter((g) => g.rows.length || (!any && g.v.models.length === 0));
  const addVendor = (): void => { ui.open((close) => <AddVendorDialog close={close} onAdded={(id) => { navigate("models", "vendors"); setTimeout(() => document.getElementById(`vendor-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 60); }} />); };
  return (
    <div className="md-catalog">
      <VendorCards vendors={vendors} routing={routing} agents={agents} selected={r.vendor} onSelect={(id) => setR({ vendor: id })} onAdd={addVendor} />
      <FilterBar label="Filter models" count={`${rows.length} of ${all.length}`} actions={any ? <Btn label="Clear" small kind="ghost" id="mc-clear" onClick={clear} /> : undefined}>
        <SearchBox id="mc-search" value={qText} onChange={setQText} placeholder="Search models" />
        <Select id="mc-vendor" aria-label="Vendor" value={r.vendor} onChange={(v) => setR({ vendor: v })} options={[{ value: "", label: "Vendor: all" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]} />
        <Select id="mc-tier" aria-label="Tier" value={tier} onChange={(v) => setR({ tier: v })} options={[{ value: "", label: "Tier: all" }, ...tiers.map((t) => ({ value: t, label: t }))]} />
        <Select id="mc-enabled" aria-label="Enabled" value={r.en} onChange={(v) => setR({ en: v })} options={[{ value: "", label: "Enabled: any" }, { value: "on", label: "Enabled" }, { value: "off", label: "Not enabled" }]} />
        <Select id="mc-price-filter" aria-label="Price" value={r.price} onChange={(v) => setR({ price: v })} options={[{ value: "", label: "Price: any" }, { value: "needs", label: "Needs a price" }]} />
        <Select id="mc-group" aria-label="Group by" value={r.group} onChange={(v) => setR({ group: v })} options={[{ value: "vendor", label: "Group: vendor" }, { value: "none", label: "No grouping" }]} />
      </FilterBar>
      {grouped && rows.length ? (
        <div id="mc-table" className="md-groups">
          {groups.map(({ v, rows: gr }) => {
            const open = !folded.has(v.id);
            const on = gr.filter((m) => m.enabled).length;
            return (
              <section key={v.id} className="md-grp" id={`mc-group-${v.id}`} aria-label={`${v.name} models`}>
                <Btn kind="ghost" cls="md-grp-head" id={`mc-fold-${v.id}`} aria-expanded={open} onClick={() => toggleFold(v.id)}>
                  <Icon name="chevron" /><b>{v.name}</b>
                  <span className="small muted">{gr.length ? `${gr.length} ${gr.length === 1 ? "model" : "models"}, ${on} enabled` : "No models yet"}</span>
                </Btn>
                {open && gr.length ? <DataTable id={`mc-table-${v.id}`} caption={`${v.name} models`} columns={cols} rows={gr} rowKey={(m) => m.id} {...sortProps} /> : null}
              </section>
            );
          })}
        </div>
      ) : (
        <DataTable id="mc-table" caption="Models" columns={cols} rows={rows} rowKey={(m) => m.id} pageSize={12} pager {...sortProps} empty={empty} />
      )}
    </div>
  );
}
