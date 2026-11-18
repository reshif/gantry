/** One vendor's page (#models/vendors/<id>): the vendor's facts and actions in the header, then only that vendor's models in one table. Search, filters and sort live in the URL (F-15). */
import { useState } from "react";
import { fmt, type Agent, type Model, type Routing, type Vendor } from "@gantry/domain";
import { useAgents, useRouting, useVendors } from "../../api/queries";
import { useCan } from "../../api/can";
import { useHash } from "../../lib/router";
import { setRouteQuery } from "../../lib/routeQuery";
import { Async } from "../../ui/async";
import { Btn, Chip, Field, FilterBar, Panel, SearchBox, Select, Stat, StatRow, Toggle, ViewHead } from "../../ui/primitives";
import { DataTable, type SortCol, type SortState } from "../../ui/SortTable";
import { useUI } from "../../ui/overlay-context";
import { AddModelDialog, ConnectDialog, DisconnectDialog, RemoveModelDialog } from "./Dialogs";
import { PublishPricesDialog } from "./Prices";
import { discoverModels, productLine, residencyLine } from "./Vendor";
import { dec, hasEndpoint, usd, usedBy } from "./kit";
import { setModelEnabled } from "./commands";

export type Row = Model & { unpriced: boolean; free: boolean; usedBy: string[] };

/** A model with no price is not free: only an endpoint vendor (on-prem) legitimately has none, and the server flags discovered models it could not price. */
export function toRows(v: Vendor, agents: Agent[], routing: Routing): Row[] {
  return v.models.map((m) => {
    const zero = !m.inPrice && !m.outPrice;
    const free = zero && hasEndpoint(v) && !m.needsPrice;
    const used = [
      ...(routing.defaultModel === m.id ? ["Factory default"] : []),
      ...Object.entries(routing.overrides ?? {}).filter(([, id]) => id === m.id).map(([st]) => `${st} default`),
      ...(routing.fallback.includes(m.id) ? ["Fallback chain"] : []),
      ...usedBy(agents, m.id).map((a) => a.name),
    ];
    return { ...m, unpriced: !!m.needsPrice || (zero && !free), free, usedBy: used };
  });
}

const KEYS = ["name", "tier", "ctx", "in", "out"];

export default function VendorPage({ id }: { id: string }) {
  const vq = useVendors();
  const rq = useRouting();
  const aq = useAgents();
  return (
    <div className="view view-models view-vendor">
      <Async query={vq} what="model vendors" id="models">
        {(vendors) => (
          <Async query={rq} what="model routing" id="models-routing">
            {(routing) => (
              <Async query={aq} what="agents" id="models-agents" isEmpty={() => false}>
                {(agents) => {
                  const v = vendors.find((x) => x.id === id);
                  return v ? <VendorBody v={v} vendors={vendors} agents={agents} routing={routing} /> : <Missing id={id} />;
                }}
              </Async>
            )}
          </Async>
        )}
      </Async>
    </div>
  );
}

function Missing({ id }: { id: string }) {
  return (
    <>
      <ViewHead title="Vendor not found" crumbs={[{ label: "Models", href: "#models" }, { label: "Vendors", href: "#models" }, { label: id }]} />
      <Panel title="No such vendor"><p className="muted">{`There is no vendor called "${id}". It may have been removed.`}</p><a href="#models" id="vp-back">Back to Vendors</a></Panel>
    </>
  );
}

function VendorBody({ v, vendors, agents, routing }: { v: Vendor; vendors: Vendor[]; agents: Agent[]; routing: Routing }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const { q: query } = useHash();
  const [pending, setPending] = useState<string | null>(null);
  const all = toRows(v, agents, routing);
  const term = (query.mq ?? "").trim().toLowerCase();
  const tier = query.tier ?? "";
  const state = query.state === "on" || query.state === "off" ? query.state : "";
  const price = query.price === "needs" ? "needs" : "";
  const sort: SortState | undefined = query.sort && KEYS.includes(query.sort) ? { key: query.sort, dir: query.dir === "desc" ? -1 : 1 } : undefined;
  const tiers = [...new Set(all.map((m) => m.tier).filter((t): t is string => !!t))];
  const rows = all.filter((m) => (!term || `${m.name} ${m.id}`.toLowerCase().includes(term)) && (!tier || m.tier === tier)
    && (!state || (state === "on") === m.enabled) && (!price || m.unpriced));
  const filtered = !!(term || tier || state || price);
  const clear = () => { for (const k of ["mq", "tier", "state", "price"]) setRouteQuery(k, null); };

  const hasBudget = (v.budget || 0) > 0;
  const enabled = v.models.filter((m) => m.enabled).length;
  const product = productLine(v);
  const tone = !v.connected || v.health !== "healthy" ? "warn" : "ok";
  const setPrice = () => ui.open((close) => <PublishPricesDialog vendors={vendors} close={close} />);
  const flip = async (m: Row, on: boolean) => {
    setPending(m.id);
    const r = await setModelEnabled(m.id, on);
    setPending(null);
    ui.toast(r.ok ? `${m.name} ${on ? "enabled" : "disabled"}` : r.msg, r.ok ? "ok" : "error");
  };
  const rowMenu = (el: HTMLElement, m: Row) => ui.menu(el, m.name, [
    ...(m.unpriced ? [{ label: "Set price", icon: "edit", guard: perm, onClick: setPrice }] : []),
    { label: "Remove model", kind: "danger", guard: perm, onClick: () => ui.open((close: () => void) => <RemoveModelDialog v={v} m={m} close={close} />) },
  ]);

  const cols: SortCol<Row>[] = [
    { key: "name", label: "Model", sort: (m) => m.name.toLowerCase(), render: (m) => <div title={m.id}>{m.name}<span className="sub mono small">{m.id}</span></div> },
    ...(tiers.length ? [{ key: "tier", label: "Tier", sort: (m: Row) => m.tier ?? "", render: (m: Row) => m.tier ? <Chip text={m.tier} cls="plain" /> : <span className="muted">–</span> }] : []),
    { key: "ctx", label: "Context", align: "end", sort: (m) => m.context || 0, render: (m) => m.context ? fmt.k(m.context) : <span className="muted">–</span> },
    { key: "in", label: "Input / Mtok", align: "end", sort: (m) => m.inPrice || 0, render: (m) => priceCell(m, m.inPrice, perm.allowed, setPrice, true) },
    { key: "out", label: "Output / Mtok", align: "end", sort: (m) => m.outPrice || 0, render: (m) => priceCell(m, m.outPrice, perm.allowed, setPrice, false) },
    { key: "used", label: "Used by", render: (m) => m.usedBy.length ? <span className="md-used">{m.usedBy.slice(0, 3).map((u) => <Chip key={u} text={u} cls="plain" />)}{m.usedBy.length > 3 ? <span className="small muted" title={m.usedBy.join(", ")}>{`+${m.usedBy.length - 3}`}</span> : null}</span> : <span className="muted small">Not used</span> },
    { key: "enabled", label: "Enabled", render: (m) => <Toggle id={`mt-${m.id}`} checked={m.enabled} label={`Enabled: ${m.name}`} decision={!perm.allowed ? perm : null} disabled={pending === m.id} onChange={(on) => void flip(m, on)} /> },
    { key: "menu", label: "Actions", render: (m) => <Btn small kind="ghost" icon="down" id={`mt-menu-${m.id}`} aria={`Actions for ${m.name}`} aria-haspopup="menu" onClick={(e) => rowMenu(e.currentTarget, m)} /> },
  ];

  return (
    <>
      <ViewHead
        title={v.name}
        crumbs={[{ label: "Models", href: "#models" }, { label: "Vendors", href: "#models" }, { label: v.name }]}
        status={<Chip text={v.connected ? v.health : "offline"} cls={tone} />}
        sub={[product, v.connected && v.latency ? `Last check ${v.latency} ms` : "No calls yet"].filter(Boolean).join(" · ")}
        actions={(
          <>
            <Btn label={v.connected ? "Update key" : "Connect"} kind={v.connected ? undefined : "primary"} icon="key" id="vp-connect" guard={perm} onClick={() => ui.open((close) => <ConnectDialog v={v} close={close} />)} />
            <Btn label="Add model" icon="plus" id="vp-add-model" guard={perm} onClick={() => ui.open((close) => <AddModelDialog v={v} vendors={vendors} close={close} />)} />
            <Btn label="Discover models" icon="search" id="vp-discover" guard={perm} onClick={() => void discoverModels(ui, v)} />
            {v.connected ? <Btn label="Disconnect" kind="danger" id="vp-disconnect" guard={perm} onClick={() => ui.open((close) => <DisconnectDialog v={v} routing={routing} agents={agents} close={close} />)} /> : null}
          </>
        )}
      />
      <StatRow id="vp-stats">
        <Stat label={hasBudget ? "Spend this month" : "Spend"} value={usd(v.mtd || 0)} sub={hasBudget ? `of ${usd(v.budget)} budget` : <>No budget set · <a href="#models?tab=prices" id="vp-budget-link">Set it in Prices and budgets</a></>} {...(hasBudget && (v.mtd || 0) / v.budget > 0.8 ? { tone: "wait" as const } : {})} />
        <Stat label="Models" value={`${enabled} of ${v.models.length}`} sub="enabled" tone="info" />
        <Stat label="Data residency" value={v.region || "–"} sub={residencyLine(v)} />
      </StatRow>
      <Panel title="Models" id="vp-models" flush>
        <FilterBar label={`Filter ${v.name} models`} count={`${rows.length} model${rows.length === 1 ? "" : "s"}${rows.length !== all.length ? ` of ${all.length}` : ""}`}
          actions={filtered ? <Btn small kind="ghost" label="Clear filters" id="vp-clear" onClick={clear} /> : undefined}>
          <SearchBox id="vp-search" value={query.mq ?? ""} onChange={(x) => setRouteQuery("mq", x || null)} placeholder="Search models…" label="Search models" />
          {tiers.length ? <Field label="Tier" htmlFor="vp-f-tier"><Select id="vp-f-tier" value={tier} options={[{ value: "", label: "All tiers" }, ...tiers.map((t) => ({ value: t, label: t }))]} onChange={(x) => setRouteQuery("tier", x || null)} /></Field> : null}
          <Field label="State" htmlFor="vp-f-state"><Select id="vp-f-state" value={state} options={[{ value: "", label: "Any state" }, { value: "on", label: "Enabled" }, { value: "off", label: "Disabled" }]} onChange={(x) => setRouteQuery("state", x || null)} /></Field>
          <Field label="Price" htmlFor="vp-f-price"><Select id="vp-f-price" value={price} options={[{ value: "", label: "Any price" }, { value: "needs", label: "Needs a price" }]} onChange={(x) => setRouteQuery("price", x || null)} /></Field>
        </FilterBar>
        <DataTable id="vp-table" caption={`${v.name} models`} columns={cols} rows={rows} rowKey={(m) => m.id} sort={sort} onSort={(s) => { setRouteQuery("sort", s.key); setRouteQuery("dir", s.dir === -1 ? "desc" : null); }} sortSelect={false}
          empty={all.length
            ? { title: "Nothing matches these filters", text: "Loosen the search or clear the filters.", action: <Btn label="Clear filters" onClick={clear} /> }
            : { title: "No models yet", text: "Add a model by hand or discover what the vendor offers.", action: <Btn label="Discover models" guard={perm} onClick={() => void discoverModels(ui, v)} /> }} />
      </Panel>
    </>
  );
}

function priceCell(m: Row, n: number, canEdit: boolean, setPrice: () => void, first: boolean) {
  if (m.unpriced) {
    if (!first) return <span className="muted">–</span>;
    return <span className="md-needs"><Chip text="Needs a price" cls="warn" />{canEdit ? <Btn small kind="ghost" label="Set price" aria={`Set price for ${m.name}`} onClick={setPrice} /> : null}</span>;
  }
  if (m.free) return first ? <span className="muted small">Self-hosted, no per-token price</span> : <span className="muted">–</span>;
  return <span className="num">{`$${n}`}</span>;
}
