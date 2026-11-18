/** The vendor summary row on the Models tab: one compact card per vendor (name, health, spend against budget, models on, residency, actions menu) and an Add vendor card. A card filters the model table. */
import { fmt, type Agent, type Routing, type Vendor } from "@gantry/domain";
import { useDiscoverModels } from "../../api/modelCommands";
import { useCan } from "../../api/can";
import { navigate } from "../../lib/router";
import { Icon } from "../../ui/Icon";
import { Btn, IconBtn, Meter, Status } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { AddModelDialog, ConnectDialog, DisconnectDialog } from "./Dialogs";
import { dec } from "./kit";

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
/** The product or kind of a vendor, only when it says something its name does not. */
export const vendorKind = (v: Vendor): string => {
  const p = (v.product || (v.custom ? "Custom vendor · OpenAI-compatible" : "")).trim();
  return !p || same(p, v.name) ? "" : p;
};
/** Money with cents while small, so a first dollar of spend is not shown as "$0". */
export const spendText = (n: number): string => (n > 0 && n < 100 ? fmt.money(n) : fmt.money0(n));
const healthText = (v: Vendor): string => (!v.connected ? "Not connected" : v.health.charAt(0).toUpperCase() + v.health.slice(1));
const healthTone = (v: Vendor) => (!v.connected ? "neutral" : v.health === "healthy" ? "done" : v.health === "degraded" ? "wait" : "block") as "neutral" | "done" | "wait" | "block";

/** Where the data goes, in one line. */
export function residencyLine(v: Vendor): string {
  if (v.residency) return v.residency;
  if (v.endpoint) return `Data goes to ${v.endpoint.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}${v.region ? ` in ${v.region}` : ""}.`;
  return "No residency information.";
}

function VendorCard({ v, vendors, routing, agents, selected, onSelect }: { v: Vendor; vendors: Vendor[]; routing: Routing; agents: Agent[]; selected: boolean; onSelect: () => void }) {
  const ui = useUI();
  const discoverCmd = useDiscoverModels();
  const perm = dec(useCan("model.edit"));
  const on = v.connected ? v.models.filter((m) => m.enabled).length : 0;
  const kind = vendorKind(v);
  const pct = v.budget ? (v.mtd || 0) / v.budget : 0;
  const menu = (anchor: HTMLElement): void => {
    const items = [
      { label: v.connected ? "Update key or settings" : `Connect ${v.name}`, icon: "key", guard: perm, onClick: () => ui.open((close) => <ConnectDialog v={v} close={close} />) },
      { label: "Add model", icon: "plus", guard: perm, onClick: () => ui.open((close) => <AddModelDialog v={v} vendors={vendors} close={close} />) },
      ...(v.connected && (v.template || v.custom || v.id === "anthropic") ? [{ label: "Discover models", icon: "refresh", guard: perm, onClick: () => void (async () => { const r = await discoverCmd.run(v.id); if (r) ui.toast(r.msg || (r.ok ? `Checked ${v.name}.` : `Could not check ${v.name}.`), r.ok ? "info" : "error"); })() }] : []),
      { label: "Vendor details, keys and models", icon: "list", onClick: () => navigate("models", "vendors") },
      ...(v.connected ? [{ sep: true }, { label: "Disconnect", kind: "danger", guard: perm, onClick: () => ui.open((close) => <DisconnectDialog v={v} routing={routing} agents={agents} close={close} />) }] : []),
    ];
    ui.menu(anchor, v.name, items);
  };
  return (
    <article className={`md-vc${v.connected ? "" : " is-off"}${selected ? " is-selected" : ""}`} id={`vc-${v.id}`} aria-label={v.name}>
      <Btn cls="md-vc-main" id={`vc-pick-${v.id}`} aria-pressed={selected} aria={`${selected ? "Showing" : "Show"} ${v.name} models`} onClick={onSelect}>
        <span className="md-vc-head">
          <span className="md-vc-name ell">{v.name}</span>
          <Status tone={healthTone(v)}>{healthText(v)}</Status>
        </span>
        {kind ? <span className="md-vc-kind small muted ell">{kind}</span> : null}
        <span className="md-vc-line small">
          {v.connected ? (v.latency ? `Last check ${v.latency} ms` : "No check yet") : "Connect to use its models"}
        </span>
        <span className="md-vc-spend">
          {v.budget ? (
            <>
              <span className="small"><b className="mono">{spendText(v.mtd || 0)}</b> of {fmt.money0(v.budget)} this month</span>
              <Meter value={v.mtd || 0} max={v.budget} label={`${v.name} spend vs budget`} warnAt={0.8} />
              <span className={`mono small${pct >= 0.8 ? " warn-text" : ""}`}>{fmt.pct(pct)} of budget</span>
            </>
          ) : (
            <span className="small"><b className="mono">{spendText(v.mtd || 0)}</b> this month <span className="muted">&middot; No budget set</span></span>
          )}
        </span>
        <span className="md-vc-line small"><b className="mono">{on}/{v.models.length}</b> models enabled</span>
        <span className="md-vc-res small muted"><Icon name="shield" /><span className="ell2">{residencyLine(v)}</span></span>
      </Btn>
      <IconBtn icon="dots" className="md-vc-menu" id={`vc-menu-${v.id}`} label={`Actions for ${v.name}`} aria-haspopup="menu" onClick={() => { const el = document.getElementById(`vc-menu-${v.id}`); if (el) menu(el); }} />
    </article>
  );
}

export function VendorCards({ vendors, routing, agents, selected, onSelect, onAdd }: { vendors: Vendor[]; routing: Routing; agents: Agent[]; selected: string; onSelect: (id: string) => void; onAdd: () => void }) {
  const perm = dec(useCan("model.edit"));
  return (
    <section className="md-vcs" id="md-vendors" aria-label="Vendors">
      {vendors.map((v) => <VendorCard key={v.id} v={v} vendors={vendors} routing={routing} agents={agents} selected={selected === v.id} onSelect={() => onSelect(selected === v.id ? "" : v.id)} />)}
      <Btn cls="md-vc md-vc-add" id="md-add-vendor-card" guard={perm} onClick={onAdd}>
        <Icon name="plus" /><span><b>Add vendor</b><span className="small muted">Pick a template or enter an endpoint</span></span>
      </Btn>
    </section>
  );
}
