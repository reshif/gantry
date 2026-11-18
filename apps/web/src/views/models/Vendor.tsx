/** One vendor card (legacy vendorPanel): health and latency and spend from real calls, residency, models with their toggles, and the actions. */
import { useState } from "react";
import { fmt, type Agent, type Catalog, type Routing, type Vendor } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Chip, Select, Toggle, reasonText } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { AddModelDialog, ConnectDialog, DisconnectDialog, RemoveModelDialog } from "./Dialogs";
import { dec, hasEndpoint, no, usd, usedBy } from "./kit";

export function VendorPanel({ v, vendors, routing, agents, cat }: { v: Vendor; vendors: Vendor[]; routing: Routing; agents: Agent[]; cat: Catalog | null }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const endpointVendor = hasEndpoint(v);

  const removeGuard = (id: string, users: Agent[]) => {
    if (!perm.allowed) return perm;
    if (routing.defaultModel === id) return no("This is the factory default model. Pick another default first.");
    if ((routing.fallback ?? []).includes(id)) return no("In the routing fallback order. Remove it there first.");
    if (Object.values(routing.overrides ?? {}).includes(id) || Object.values(routing.classOverrides ?? {}).includes(id)) return no("A routing override uses it. Change that first.");
    if (users.length) return no(`Used by ${users.map((a) => a.name).join(", ")}. Change those agents first.`);
    return null;
  };

  const healthTone = !v.connected ? "warn" : v.health === "healthy" ? "ok" : "warn";
  const spendRatio = v.budget ? (v.mtd || 0) / v.budget : 0;
  return (
    <section className={`card vendor${v.connected ? "" : " is-off"}`} aria-label={v.name} id={`vendor-${v.id}`}>
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
          const users = usedBy(agents, m.id);
          const primaries = users.filter((a) => a.model === m.id);
          const isDefault = routing.defaultModel === m.id;
          const lock = !perm.allowed ? perm
            : !v.connected ? no(`Connect ${v.name} first.`)
            : !m.enabled && m.invocable === false ? no("The model gateway speaks the Anthropic Messages API only, so this vendor's models cannot be switched on yet.")
            : m.enabled && isDefault ? no("This is the factory default model. Pick another default first.")
            : m.enabled && primaries.length ? no(`Primary model of ${primaries.map((a) => a.name).join(", ")}. Change those agents first.`) : null;
          return (
            <label key={m.id} className="check md-model" htmlFor={`mt-${m.id}`} style={{ justifyContent: "space-between", padding: "6px 0", borderBottom: "1px dotted var(--line)" }}>
              <span title={m.id}>{m.name}<span className="sub muted small" style={{ display: "block" }}>{`${fmt.k(m.context || 0)} ctx · $${m.inPrice}/$${m.outPrice} per M`}</span></span>
              <Toggle id={`mt-${m.id}`} checked={m.enabled} label={m.name} decision={lock} onChange={(on) => void (async () => { const r = await ops.setModelEnabled(m.id, on); ui.toast(r.ok ? `${m.name} ${on ? "enabled" : "disabled"}` : r.msg, r.ok ? "ok" : "error"); })()} />
            </label>
          );
        })}
      </div>
      <details className="md-manage">
        <summary className="small">Manage {v.name}</summary>
        <dl className="kv md-kv"><dt>Key</dt><dd className="mono">{v.keyMask || "none"}</dd></dl>
        {v.custom ? <Qualification v={v} cat={cat} /> : null}
        {v.models.length ? null : <div className="small muted">No models yet. Add the models this endpoint serves.</div>}
        {v.models.map((m) => {
          const users = usedBy(agents, m.id);
          const rm = removeGuard(m.id, users);
          return (
            <div key={m.id} className="small muted md-id">
              <span className="mono md-mid">{m.id}</span>
              <span>{users.length ? `Used by ${users.map((a) => a.name + (a.model === m.id ? "" : " (fallback)")).join(", ")}` : "Used by none"}</span>
              {routing.defaultModel === m.id ? <Chip text="factory default" cls="chip-accent md-def" /> : null}
              {m.needsPrice ? <Chip text="needs a price" cls="chip-warn" /> : null}
              <Btn small kind="ghost" icon="x" id={`md-rm-${m.id}`} aria={`Remove ${m.name}`} cls="md-rm" guard={rm} onClick={() => ui.open((close) => <RemoveModelDialog v={v} m={m} close={close} />)} />
              {rm && perm.allowed ? <span className="lockwhy"><Icon name="lock" /> {reasonText(rm)}</span> : null}
            </div>
          );
        })}
        <div className="row md-actions">
          <Btn label={v.connected ? "Update key or settings" : `Connect ${v.name}`} kind={v.connected ? undefined : "primary"} small icon="key" id={`vendor-connect-${v.id}`} guard={perm} onClick={() => ui.open((close) => <ConnectDialog v={v} close={close} />)} />
          <Btn label="Add model" icon="plus" small id={`vendor-addmodel-${v.id}`} guard={perm} onClick={() => ui.open((close) => <AddModelDialog v={v} vendors={vendors} close={close} />)} />
          {v.connected && (v.template || v.custom || v.id === "anthropic") ? <Btn label="Refresh models" icon="refresh" small id={`vendor-refresh-${v.id}`} guard={perm} onClick={() => void (async () => { const r = await ops.discoverVendorModels(v.id); ui.toast(r.msg, r.ok ? "ok" : "error"); })()} /> : null}
          {v.connected ? <Btn label="Disconnect" kind="ghost" small id={`vendor-disc-${v.id}`} guard={perm} onClick={() => ui.open((close) => <DisconnectDialog v={v} routing={routing} agents={agents} close={close} />)} /> : null}
        </div>
      </details>
    </section>
  );
}

/** Spec 10.4 Custom vendors: not qualified for a station until that station's eval suite passed on it. */
function Qualification({ v, cat }: { v: Vendor; cat: Catalog | null }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const stations = cat?.stations ?? [];
  const q = v.qualified ?? {};
  const [station, setStation] = useState(stations.find((s) => !q[s.id])?.id ?? stations[0]?.id ?? "");
  return (
    <div className="md-qual" id={`vendor-qual-${v.id}`}>
      <div className="small muted">Station qualification. A station may use this vendor only after its eval suite has passed on it.</div>
      <div className="md-qual-chips">
        {stations.map((s) => <Chip key={s.id} text={`${s.no} ${s.name}: ${q[s.id] ? "qualified" : "not qualified"}`} cls={q[s.id] ? "chip-ok" : "chip-warn"} />)}
      </div>
      <div className="form-row md-qual-form">
        <Select id={`vendor-qual-station-${v.id}`} aria-label="Station to qualify" disabled={!perm.allowed} options={stations.map((s) => ({ value: s.id, label: `${s.no} ${s.name}` }))} value={station} onChange={setStation} />
        <Btn small label="Record qualification" id={`vendor-qual-go-${v.id}`} guard={perm} onClick={() => void (async () => {
          const r = await ops.qualifyVendor(v.id, station, v.version !== undefined ? { ifMatch: v.version } : undefined);
          ui.toast(r.msg, r.ok ? "ok" : "error");
        })()} />
      </div>
    </div>
  );
}
