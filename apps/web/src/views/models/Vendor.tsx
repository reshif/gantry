/** One vendor card (legacy vendorPanel): health and latency and spend from real calls, residency, models with their toggles, and the actions. */
import { useState } from "react";
import { fmt, type Agent, type Catalog, type Routing, type Vendor } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Chip, Meter, Select, Status, Toggle, reasonText } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { AddModelDialog, ConnectDialog, DisconnectDialog, RemoveModelDialog } from "./Dialogs";
import { dec, hasEndpoint, no, usedBy } from "./kit";

export function VendorPanel({ v, vendors, routing, agents, cat }: { v: Vendor; vendors: Vendor[]; routing: Routing; agents: Agent[]; cat: Catalog | null }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const pct = v.budget ? (v.mtd || 0) / v.budget : 0;
  const endpointVendor = hasEndpoint(v);

  const removeGuard = (id: string, users: Agent[]) => {
    if (!perm.allowed) return perm;
    if (routing.defaultModel === id) return no("This is the factory default model. Pick another default first.");
    if ((routing.fallback ?? []).includes(id)) return no("In the routing fallback order. Remove it there first.");
    if (Object.values(routing.overrides ?? {}).includes(id) || Object.values(routing.classOverrides ?? {}).includes(id)) return no("A routing override uses it. Change that first.");
    if (users.length) return no(`Used by ${users.map((a) => a.name).join(", ")}. Change those agents first.`);
    return null;
  };

  return (
    <section className={`panel vendor${v.connected ? "" : " is-off"}`} aria-label={v.name} id={`vendor-${v.id}`}>
      <div className="vendor-head">
        <div>
          <div className="kicker">{v.product || (v.custom ? "Custom vendor · OpenAI-compatible" : "Vendor")}</div>
          <h2 className="vendor-name">{v.name}</h2>
        </div>
        <Status tone={!v.connected ? "neutral" : v.health === "healthy" ? "done" : v.health === "degraded" ? "wait" : "block"}>{v.connected ? v.health.charAt(0).toUpperCase() + v.health.slice(1) : "Not connected"}</Status>
      </div>
      <div className="vendor-facts">
        <dl className="kv tb-vendor">
          <div><dt>Latency p50</dt><dd className="mono">{!v.connected ? "–" : v.latency ? `${v.latency} ms` : "Not measured yet"}</dd></div>
          <div><dt>{endpointVendor ? "Endpoint" : "Region"}</dt><dd className="mono" title={endpointVendor ? v.endpoint : v.region}>{(endpointVendor ? v.endpoint : v.region) || "–"}</dd></div>
          <div><dt>Key</dt><dd className="mono">{v.keyMask || "none"}</dd></div>
          <div><dt>Spend MTD</dt><dd className="mono">{fmt.money0(v.mtd || 0) + (v.budget ? ` / ${fmt.money0(v.budget)}` : "")}</dd></div>
        </dl>
        <div className="vendor-side">
          {v.budget ? (
            <div className="budget-row md-budget">
              <span className="small muted">Month to date vs budget</span>
              <Meter value={v.mtd} max={v.budget} label={`${v.name} spend vs budget`} warnAt={0.8} />
              <span className={`mono small${pct >= 0.8 ? " warn-text" : ""}`}>{fmt.pct(pct)}</span>
            </div>
          ) : (
            <div className="budget-row md-budget"><span className="small muted">{v.custom ? "No monthly budget set" : "No per-token cost"}</span></div>
          )}
          <p className="residency small">
            <Icon name="shield" />
            <span>
              {v.residency || (v.endpoint ? `Data goes to ${v.endpoint.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}${v.region ? ` in ${v.region}` : ""}. Check where that endpoint runs before routing regulated work to it.` : "No residency information.")}
              {v.retention && v.retention !== "standard" ? ` Data retention: ${v.retention}.` : ""}
            </span>
          </p>
        </div>
      </div>
      {v.custom ? <Qualification v={v} cat={cat} /> : null}
      <div className="table-scroll">
        <table className="table table-compact">
          <thead><tr><th scope="col">Model</th><th scope="col">On</th><th scope="col" className="num">Context</th><th scope="col" className="num">$ in / out per Mtok</th><th scope="col">Used by</th></tr></thead>
          <tbody>
            {v.models.length ? null : <tr><td colSpan={5} className="small muted">No models yet. Add the models this endpoint serves.</td></tr>}
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
                <tr key={m.id} className={m.enabled && v.connected ? "" : "md-off"}>
                  <td>
                    <div>{m.name}{isDefault ? <Chip text="factory default" cls="chip-accent md-def" /> : null}{m.needsPrice ? <Chip text="needs a price" cls="chip-warn" /> : null}{m.invocable === false ? <Chip text="gateway cannot call it yet" cls="chip-warn" /> : null}</div>
                    <div className="mono muted small md-id">
                      {m.id}
                      <Btn small kind="ghost" icon="x" id={`md-rm-${m.id}`} aria={`Remove ${m.name}`} cls="md-rm" guard={removeGuard(m.id, users)} onClick={() => ui.open((close) => <RemoveModelDialog v={v} m={m} close={close} />)} />
                    </div>
                    {lock && perm.allowed ? <div className="lockwhy small muted"><Icon name="lock" /><span>{reasonText(lock)}</span></div> : null}
                  </td>
                  <td>
                    <Toggle id={`mt-${m.id}`} checked={m.enabled} label={`Enable ${m.name}`} decision={lock} onChange={(on) => void (async () => { const r = await ops.setModelEnabled(m.id, on); ui.toast(r.msg, r.ok ? "ok" : "error"); })()} />
                  </td>
                  <td className="num mono">{fmt.k(m.context || 0)}</td>
                  <td className="num mono">{m.inPrice || m.outPrice ? `$${m.inPrice} / $${m.outPrice}` : m.needsPrice ? "enter a price" : "self-hosted"}</td>
                  <td>
                    {users.length ? (
                      <span className="md-users">{users.map((a) => <span key={a.id} className={`chip${a.model === m.id ? " chip-accent" : ""}`}>{a.name + (a.model === m.id ? "" : " (fallback)")}</span>)}</span>
                    ) : <span className="muted small">none</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="panel-actions md-actions">
        <Btn label={v.connected ? "Update key or settings" : `Connect ${v.name}`} kind={v.connected ? undefined : "primary"} icon="key" id={`vendor-connect-${v.id}`} guard={perm} onClick={() => ui.open((close) => <ConnectDialog v={v} close={close} />)} />
        <Btn label="Add model" icon="plus" id={`vendor-addmodel-${v.id}`} guard={perm} onClick={() => ui.open((close) => <AddModelDialog v={v} vendors={vendors} close={close} />)} />
        {v.connected && (v.template || v.custom || v.id === "anthropic") ? <Btn label="Refresh models" icon="refresh" id={`vendor-refresh-${v.id}`} guard={perm} onClick={() => void (async () => { const r = await ops.discoverVendorModels(v.id); ui.toast(r.msg, r.ok ? "ok" : "error"); })()} /> : null}
        {v.connected ? <Btn label="Disconnect" kind="ghost" id={`vendor-disc-${v.id}`} guard={perm} onClick={() => ui.open((close) => <DisconnectDialog v={v} routing={routing} agents={agents} close={close} />)} /> : null}
      </div>
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
