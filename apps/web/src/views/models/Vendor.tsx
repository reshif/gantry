/** One vendor card (legacy vendorPanel): health and latency and spend from real calls, residency, models with their toggles, and the actions. */
import { fmt, type Vendor } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Chip, Toggle } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { dec, hasEndpoint, usd } from "./kit";

export function VendorPanel({ v }: { v: Vendor }) {
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
      <div className="small muted">{[v.product || (v.custom ? "Custom vendor" : "Vendor"), (endpointVendor ? v.endpoint : v.region) || ""].filter(Boolean).join(" · ")}</div>
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
    </section>
  );
}
