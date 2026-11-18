/** One vendor card (legacy vendorPanel): health and latency and spend from real calls, residency, models with their toggles, and the actions. */
import { useState } from "react";
import { fmt, type Agent, type Model, type Routing, type Vendor } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Chip, Toggle } from "../../ui/primitives";
import { AddModelDialog, ConnectDialog, DisconnectDialog, RemoveModelDialog } from "./Dialogs";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { dec, hasEndpoint, usd } from "./kit";

export function VendorPanel({ v, vendors, routing, agents }: { v: Vendor; vendors: Vendor[]; routing: Routing; agents: Agent[] }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const endpointVendor = hasEndpoint(v);

  const healthTone = !v.connected ? "warn" : v.health === "healthy" ? "ok" : "warn";
  const spendRatio = v.budget ? (v.mtd || 0) / v.budget : 0;
  return (
    <section className="card vendor" aria-label={v.name} id={`vendor-${v.id}`}>
      <div className="row vendor-head">
        <h3 className="vendor-name">{v.name}</h3>
        <span className="spacer" />
        <Chip text={v.connected ? v.health : "offline"} cls={healthTone} />
      </div>
      <div className="small muted">{[v.product || (v.custom ? "Custom vendor" : "Vendor"), (endpointVendor ? (v.region || "on-prem") : v.region) || ""].filter(Boolean).join(" · ")}</div>
      <dl className="kv tb-vendor md-kv">
        <dt>Latency</dt><dd>{`${v.connected ? v.latency || 0 : 0} ms`}</dd>
        <dt>Spend MTD</dt><dd>{`${usd(v.mtd || 0)} / ${usd(v.budget || 0)}`}</dd>
      </dl>
      <div className={`meter${spendRatio > 0.8 ? " warn" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, spendRatio) * 100)} aria-label={`${v.name} spend vs budget`}><i style={{ width: `${Math.min(1, spendRatio) * 100}%` }} /></div>
      <div className="small muted residency">{v.residency || (v.endpoint ? `Data goes to ${v.endpoint.replace(/^https?:[/][/]/, "").replace(/[/].*$/, "")}${v.region ? ` in ${v.region}` : ""}.` : "No residency information.")}{v.retention && v.retention !== "standard" ? ` Data retention: ${v.retention}.` : ""}</div>
      <div className="md-models">
        {v.models.map((m) => {
          // The server refuses a switch-off that would strand a default, a fallback or an agent, and says why in the toast.
          const lock = !perm.allowed ? perm : null;
          return (
            <label key={m.id} className="check md-model" htmlFor={`mt-${m.id}`} style={{ justifyContent: "space-between", padding: "6px 0", borderBottom: "1px dotted var(--line)" }}>
              <span title={m.id}>{m.name}<span className="sub muted small" style={{ display: "block" }}>{`${fmt.k(m.context || 0)} ctx · $${m.inPrice}/$${m.outPrice} per M`}</span></span>
              <Toggle id={`mt-${m.id}`} checked={m.enabled} label={m.name} decision={lock} onChange={(on) => void (async () => { const r = await ops.setModelEnabled(m.id, on); ui.toast(r.ok ? `${m.name} ${on ? "enabled" : "disabled"}` : r.msg, r.ok ? "ok" : "error"); })()} />
            </label>
          );
        })}
      </div>
      <div className="row md-actions" style={{ flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        <Btn small label={v.connected ? "Update key" : "Connect"} kind={v.connected ? undefined : "primary"} id={`vendor-connect-${v.id}`} guard={perm} onClick={() => ui.open((close) => <ConnectDialog v={v} close={close} />)} />
        <Btn small label="Add model" icon="plus" id={`vendor-addmodel-${v.id}`} guard={perm} onClick={() => ui.open((close) => <AddModelDialog v={v} vendors={vendors} close={close} />)} />
        {v.models.length ? <Btn small kind="ghost" label="Remove model" id={`vendor-rmmodel-${v.id}`} guard={perm} onClick={() => ui.open((close) => <RemoveModelPick v={v} close={close} />)} /> : null}
        {v.connected ? <Btn small kind="ghost" label="Disconnect" id={`vendor-disc-${v.id}`} guard={perm} onClick={() => ui.open((close) => <DisconnectDialog v={v} routing={routing} agents={agents} close={close} />)} /> : null}
      </div>
    </section>
  );
}

/** Remove model needs a model: with one model it goes straight to the confirmation, with several a small picker comes first. */
function RemoveModelPick({ v, close }: { v: Vendor; close: () => void }) {
  const [picked, setPicked] = useState<Model | null>(v.models.length === 1 ? v.models[0]! : null);
  if (picked) return <RemoveModelDialog v={v} m={picked} close={close} />;
  return (
    <Dialog title={`Remove a model from ${v.name}`} kicker="Models · catalogue" onClose={close} sub="Pick the model to remove from the catalogue." actions={[{ label: "Cancel" }]}
      body={<div className="stack">{v.models.map((m) => <Btn key={m.id} label={m.name} id={`rm-pick-${m.id}`} onClick={() => setPicked(m)} />)}</div>} />
  );
}
