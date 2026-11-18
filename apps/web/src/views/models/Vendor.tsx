/** Vendor summary cards (Models, Blueprint): one compact card per vendor, a "+ Add vendor" card at the end. The vendor's models live in the table below. */
import { useState } from "react";
import type { Agent, Model, Routing, Vendor } from "@gantry/domain";
import { discoverVendorModels } from "./commands";
import { useCan } from "../../api/can";
import { Btn, Chip } from "../../ui/primitives";
import { AddModelDialog, ConnectDialog, DisconnectDialog, RemoveModelDialog } from "./Dialogs";
import { AddVendorDialog } from "./Templates";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { dec, usd } from "./kit";

/** The product line only when it says something the name does not. */
export const productLine = (v: Vendor): string => {
  const p = (v.product || (v.custom ? "Custom vendor" : "")).trim();
  return p && p.toLowerCase() !== v.name.trim().toLowerCase() ? p : "";
};

/** One line of where data goes. */
export const residencyLine = (v: Vendor): string => {
  const base = v.residency || (v.endpoint ? `Data goes to ${v.endpoint.replace(/^https?:[/][/]/, "").replace(/[/].*$/, "")}${v.region ? ` in ${v.region}` : ""}.` : "No residency information.");
  return base + (v.retention && v.retention !== "standard" ? ` Retention: ${v.retention}.` : "");
};

export function VendorCard({ v, vendors, routing, agents, selected, onSelect, onDiscover }: { v: Vendor; vendors: Vendor[]; routing: Routing; agents: Agent[]; selected: boolean; onSelect: () => void; onDiscover: (v: Vendor) => void }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const hasBudget = (v.budget || 0) > 0;
  const ratio = hasBudget ? (v.mtd || 0) / v.budget : 0;
  const enabled = v.models.filter((m) => m.enabled).length;
  const product = productLine(v);
  const tone = !v.connected || v.health !== "healthy" ? "warn" : "ok";
  const menu = (el: HTMLElement) => ui.menu(el, v.name, [
    { label: v.connected ? "Update key" : "Connect", icon: "key", guard: perm, onClick: () => ui.open((close) => <ConnectDialog v={v} close={close} />) },
    { label: "Add model", icon: "plus", guard: perm, onClick: () => ui.open((close) => <AddModelDialog v={v} vendors={vendors} close={close} />) },
    { label: "Discover models", icon: "search", guard: perm, onClick: () => onDiscover(v) },
    ...(v.models.length ? [{ label: "Remove model", guard: perm, onClick: () => ui.open((close: () => void) => <RemoveModelPick v={v} close={close} />) }] : []),
    ...(v.connected ? [{ sep: true }, { label: "Disconnect", kind: "danger", guard: perm, onClick: () => ui.open((close: () => void) => <DisconnectDialog v={v} routing={routing} agents={agents} close={close} />) }] : []),
  ]);
  return (
    <section className={`card vendor md-vcard${selected ? " is-selected" : ""}`} aria-label={v.name} id={`vendor-${v.id}`}>
      <div className="row vendor-head md-vhead">
        <Btn kind="ghost" cls="md-vpick" id={`vendor-pick-${v.id}`} aria-pressed={selected} aria={`${selected ? "Showing" : "Show"} ${v.name} models`} onClick={onSelect}>
          <span className="vendor-name">{v.name}</span>
          {product ? <span className="small muted">{product}</span> : null}
        </Btn>
        <Chip text={v.connected ? v.health : "offline"} cls={tone} />
        <Btn small kind="ghost" icon="down" id={`vendor-menu-${v.id}`} aria={`Actions for ${v.name}`} aria-haspopup="menu" onClick={(e) => menu(e.currentTarget)} />
      </div>
      <dl className="kv tb-vendor md-kv">
        <dt>{hasBudget ? "Spend this month" : "Spend"}</dt>
        <dd>{hasBudget ? `${usd(v.mtd || 0)} of ${usd(v.budget)}` : <>{usd(v.mtd || 0)} <span className="muted">· No budget set</span></>}</dd>
        <dt>Models</dt><dd>{`${enabled} of ${v.models.length} enabled`}</dd>
        <dt>Last check</dt><dd>{v.connected && v.latency ? `${v.latency} ms` : "No calls yet"}</dd>
      </dl>
      {hasBudget ? <div className={`meter${ratio > 0.8 ? " warn" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, ratio) * 100)} aria-label={`${v.name} spend vs budget`}><i style={{ width: `${Math.min(1, ratio) * 100}%` }} /></div> : null}
      <div className="small muted residency md-resid" title={residencyLine(v)}>{residencyLine(v)}</div>
      {!v.connected ? <div className="md-vfoot"><Btn small kind="primary" label="Connect" id={`vendor-connect-${v.id}`} guard={perm} onClick={() => ui.open((close) => <ConnectDialog v={v} close={close} />)} /></div> : null}
    </section>
  );
}

export function AddVendorCard({ onAdded }: { onAdded: (id: string) => void }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  return (
    <section className="card vendor md-vcard md-vadd" aria-label="Add vendor">
      <Btn kind="ghost" icon="plus" label="Add vendor" id="md-add-vendor-card" guard={perm} onClick={() => ui.open((close) => <AddVendorDialog close={close} onAdded={onAdded} />)} />
      <span className="small muted">Pick a template or connect one by hand.</span>
    </section>
  );
}

/** What a vendor's discover call says, as one toast. */
export async function discoverModels(ui: { toast: (t: string, k?: "ok" | "error") => void }, v: Vendor): Promise<void> {
  const r = await discoverVendorModels(v.id);
  ui.toast(r.ok ? r.msg || `Models listed for ${v.name}.` : r.msg, r.ok ? "ok" : "error");
}

/** Remove model needs a model: with one model it goes straight to the confirmation, with several a small picker comes first. */
export function RemoveModelPick({ v, close }: { v: Vendor; close: () => void }) {
  const [picked, setPicked] = useState<Model | null>(v.models.length === 1 ? v.models[0]! : null);
  if (picked) return <RemoveModelDialog v={v} m={picked} close={close} />;
  return (
    <Dialog title={`Remove a model from ${v.name}`} kicker="Models · catalogue" onClose={close} sub="Pick the model to remove from the catalogue." actions={[{ label: "Cancel" }]}
      body={<div className="stack">{v.models.map((m) => <Btn key={m.id} label={m.name} id={`rm-pick-${m.id}`} onClick={() => setPicked(m)} />)}</div>} />
  );
}
