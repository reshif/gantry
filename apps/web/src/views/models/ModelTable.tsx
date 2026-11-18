/** Models across vendors: one table, grouped by vendor (collapsible), with search, filters and sort kept in the URL (F-15). */
import { useState } from "react";
import { fmt, type Agent, type Model, type Routing, type Vendor } from "@gantry/domain";
import { useCan } from "../../api/can";
import { useHash } from "../../lib/router";
import { setRouteQuery } from "../../lib/routeQuery";
import { Btn, Chip, Field, FilterBar, Panel, SearchBox, Select, Toggle } from "../../ui/primitives";
import { DataTable, type SortCol, type SortState } from "../../ui/SortTable";
import { useUI } from "../../ui/overlay-context";
import { PublishPricesDialog } from "./Prices";
import { dec, hasEndpoint, usedBy } from "./kit";
import { setModelEnabled } from "./commands";

export type Row = Model & { vendorId: string; vendorName: string; connected: boolean; unpriced: boolean; free: boolean; usedBy: string[] };

/** A model with no price is not free: only an endpoint vendor (on-prem) legitimately has none, and the server flags discovered models it could not price. */
export function toRows(vendors: Vendor[], agents: Agent[], routing: Routing): Row[] {
  return vendors.flatMap((v) => v.models.map((m) => {
    const zero = !m.inPrice && !m.outPrice;
    const free = zero && hasEndpoint(v) && !m.needsPrice;
    const used = [
      ...(routing.defaultModel === m.id ? ["Factory default"] : []),
      ...Object.entries(routing.overrides ?? {}).filter(([, id]) => id === m.id).map(([st]) => `${st} default`),
      ...(routing.fallback.includes(m.id) ? ["Fallback chain"] : []),
      ...usedBy(agents, m.id).map((a) => a.name),
    ];
    return { ...m, vendorId: v.id, vendorName: v.name, connected: v.connected, unpriced: !!m.needsPrice || (zero && !free), free, usedBy: used };
  }));
}

const KEYS = ["name", "tier", "ctx", "in", "out"];

export function ModelTable({ vendors, agents, routing }: { vendors: Vendor[]; agents: Agent[]; routing: Routing }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const { q: query } = useHash();
  const all = toRows(vendors, agents, routing);
  const term = (query.mq ?? "").trim().toLowerCase();
  const vendor = vendors.some((v) => v.id === query.vendor) ? query.vendor! : "";
  const tier = query.tier ?? "";
  const state = query.state === "on" || query.state === "off" ? query.state : "";
  const price = query.price === "needs" ? "needs" : "";
  const grouped = query.group !== "0";
  const closed = new Set((query.closed ?? "").split(",").filter(Boolean));
  const sort: SortState | undefined = query.sort && KEYS.includes(query.sort) ? { key: query.sort, dir: query.dir === "desc" ? -1 : 1 } : undefined;
  const tiers = [...new Set(all.map((m) => m.tier).filter((t): t is string => !!t))];
  const [pending, setPending] = useState<string | null>(null);

  const rows = all.filter((m) => (!term || `${m.name} ${m.id} ${m.vendorName}`.toLowerCase().includes(term))
    && (!vendor || m.vendorId === vendor) && (!tier || m.tier === tier)
    && (!state || (state === "on") === m.enabled) && (!price || m.unpriced));
  const filtered = !!(term || vendor || tier || state || price);
  const clear = () => { for (const k of ["mq", "vendor", "tier", "state", "price"]) setRouteQuery(k, null); };
  const toggleGroup = (id: string) => { const n = new Set(closed); if (n.has(id)) n.delete(id); else n.add(id); setRouteQuery("closed", [...n].join(",") || null); };

  const flip = async (m: Row, on: boolean) => {
    setPending(m.id);
    const r = await setModelEnabled(m.id, on);
    setPending(null);
    ui.toast(r.ok ? `${m.name} ${on ? "enabled" : "disabled"}` : r.msg, r.ok ? "ok" : "error");
  };
  const setPrice = () => ui.open((close) => <PublishPricesDialog vendors={vendors} close={close} />);

  const cols: SortCol<Row>[] = [
    { key: "name", label: "Model", sort: (m) => m.name.toLowerCase(), render: (m) => <div title={m.id}>{m.name}<span className="sub mono small">{m.id}</span></div> },
    ...(grouped ? [] : [{ key: "vendor", label: "Vendor", render: (m: Row) => m.vendorName }]),
    ...(tiers.length ? [{ key: "tier", label: "Tier", sort: (m: Row) => m.tier ?? "", render: (m: Row) => m.tier ? <Chip text={m.tier} cls="plain" /> : <span className="muted">–</span> }] : []),
    { key: "ctx", label: "Context", align: "end", sort: (m) => m.context || 0, render: (m) => m.context ? fmt.k(m.context) : <span className="muted">–</span> },
    { key: "in", label: "Input / Mtok", align: "end", sort: (m) => m.inPrice || 0, render: (m) => priceCell(m, m.inPrice, perm.allowed, setPrice, true) },
    { key: "out", label: "Output / Mtok", align: "end", sort: (m) => m.outPrice || 0, render: (m) => priceCell(m, m.outPrice, perm.allowed, setPrice, false) },
    { key: "used", label: "Used by", render: (m) => m.usedBy.length ? <span className="md-used">{m.usedBy.slice(0, 3).map((u) => <Chip key={u} text={u} cls="plain" />)}{m.usedBy.length > 3 ? <span className="small muted" title={m.usedBy.join(", ")}>{`+${m.usedBy.length - 3}`}</span> : null}</span> : <span className="muted small">Not used</span> },
    { key: "enabled", label: "Enabled", render: (m) => (
      <Toggle id={`mt-${m.id}`} checked={m.enabled} label={`Enabled: ${m.name}`} decision={!perm.allowed ? perm : null} disabled={pending === m.id} onChange={(on) => void flip(m, on)} />
    ) },
  ];

  const table = (list: Row[], id: string, caption: string) => (
    <DataTable id={id} caption={caption} columns={cols} rows={list} rowKey={(m) => m.id} sort={sort} onSort={(s) => { setRouteQuery("sort", s.key); setRouteQuery("dir", s.dir === -1 ? "desc" : null); }} sortSelect={false}
      empty={{ title: "Nothing matches these filters", text: "Loosen the search or clear the filters.", action: <Btn label="Clear filters" onClick={clear} /> }} />
  );

  const groups = vendors.map((v) => ({ v, list: rows.filter((m) => m.vendorId === v.id) })).filter((g) => g.list.length);
  return (
    <Panel title="Models" id="md-models" flush tools={<Btn small kind="primary" icon="plus" label="Publish prices" id="md-publish-prices" guard={perm} onClick={setPrice} />}>
      <FilterBar label="Filter models" count={`${rows.length} model${rows.length === 1 ? "" : "s"}${rows.length !== all.length ? ` of ${all.length}` : ""}`}
        actions={filtered ? <Btn small kind="ghost" label="Clear filters" id="md-clear" onClick={clear} /> : undefined}>
        <SearchBox id="md-model-search" value={query.mq ?? ""} onChange={(v) => setRouteQuery("mq", v || null)} placeholder="Search models…" label="Search models" />
        <Field label="Vendor" htmlFor="md-f-vendor"><Select id="md-f-vendor" value={vendor} options={[{ value: "", label: "All vendors" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]} onChange={(v) => setRouteQuery("vendor", v || null)} /></Field>
        {tiers.length ? <Field label="Tier" htmlFor="md-f-tier"><Select id="md-f-tier" value={tier} options={[{ value: "", label: "All tiers" }, ...tiers.map((t) => ({ value: t, label: t }))]} onChange={(v) => setRouteQuery("tier", v || null)} /></Field> : null}
        <Field label="State" htmlFor="md-f-state"><Select id="md-f-state" value={state} options={[{ value: "", label: "Enabled and disabled" }, { value: "on", label: "Enabled" }, { value: "off", label: "Disabled" }]} onChange={(v) => setRouteQuery("state", v || null)} /></Field>
        <Field label="Price" htmlFor="md-f-price"><Select id="md-f-price" value={price} options={[{ value: "", label: "Any price" }, { value: "needs", label: "Needs a price" }]} onChange={(v) => setRouteQuery("price", v || null)} /></Field>
        <Field label="Group" htmlFor="md-f-group"><Select id="md-f-group" value={grouped ? "vendor" : "none"} options={[{ value: "vendor", label: "By vendor" }, { value: "none", label: "No grouping" }]} onChange={(v) => setRouteQuery("group", v === "none" ? "0" : null)} /></Field>
      </FilterBar>
      {!grouped || !groups.length ? table(rows, "md-models-table", "Models") : (
        <div className="md-groups">
          {groups.map(({ v, list }) => {
            const open = !closed.has(v.id);
            return (
              <section key={v.id} className="md-group" aria-label={`${v.name} models`}>
                <Btn kind="ghost" cls="md-group-head" id={`md-group-${v.id}`} aria-expanded={open} aria-controls={`md-group-body-${v.id}`} onClick={() => toggleGroup(v.id)}>
                  <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                  <b>{v.name}</b>
                  <span className="small muted">{`${list.filter((m) => m.enabled).length} of ${list.length} enabled`}</span>
                </Btn>
                <div id={`md-group-body-${v.id}`} hidden={!open}>{open ? table(list, `md-table-${v.id}`, `${v.name} models`) : null}</div>
              </section>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function priceCell(m: Row, n: number, canEdit: boolean, setPrice: () => void, first: boolean) {
  if (m.unpriced) {
    if (!first) return <span className="muted">–</span>;
    return <span className="md-needs"><Chip text="Needs a price" cls="warn" />{canEdit ? <Btn small kind="ghost" label="Set price" aria={`Set price for ${m.name}`} onClick={setPrice} /> : null}</span>;
  }
  if (m.free) return first ? <span className="muted small">No per-token cost</span> : <span className="muted">–</span>;
  return <span className="num">{`$${n}`}</span>;
}
