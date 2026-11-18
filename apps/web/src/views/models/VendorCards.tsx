/** The vendor summary row on the Models tab: one compact card per vendor (name, health, spend against budget, models on, residency, actions menu) and an Add vendor card. A card filters the model table. */
import { fmt, type Agent, type Routing, type Vendor } from "@gantry/domain";
import { useDiscoverModels } from "../../api/modelCommands";
import { useCan } from "../../api/can";
import { navigate } from "../../lib/router";
import { Icon } from "../../ui/Icon";
import { Btn, IconBtn, Meter, Status } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { AddModelDialog, ConnectDialog, DisconnectDialog } from "./Dialogs";
import { dec, enabledCount } from "./kit";

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

/** The actions of a vendor (connect, add model, discover, disconnect), shared by its card menu and its empty group in the table. */
export function useVendorActions(v: Vendor, vendors: Vendor[], routing: Routing, agents: Agent[]) {
  const ui = useUI();
  const discoverCmd = useDiscoverModels();
  return {
    canDiscover: v.connected && !!(v.template || v.custom || v.id === "anthropic"),
    connect: (): void => { ui.open((close) => <ConnectDialog v={v} close={close} />); },
    addModel: (): void => { ui.open((close) => <AddModelDialog v={v} vendors={vendors} close={close} />); },
    discover: (): void => void (async () => { const r = await discoverCmd.run(v.id); if (r) ui.toast(r.msg || (r.ok ? `Checked ${v.name}.` : `Could not check ${v.name}.`), r.ok ? "info" : "error"); })(),
    disconnect: (): void => { ui.open((close) => <DisconnectDialog v={v} routing={routing} agents={agents} close={close} />); },
  };
}

function VendorCard({ v, vendors, routing, agents, selected, onSelect }: { v: Vendor; vendors: Vendor[]; routing: Routing; agents: Agent[]; selected: boolean; onSelect: () => void }) {
  const ui = useUI();
  const act = useVendorActions(v, vendors, routing, agents);
  const perm = dec(useCan("model.edit"));
  const on = enabledCount(v);
  const kind = vendorKind(v);
  const pct = v.budget ? (v.mtd || 0) / v.budget : 0;
  const menu = (anchor: HTMLElement): void => {
    const items = [
      { label: v.connected ? "Update key or settings" : `Connect ${v.name}`, icon: "key", guard: perm, onClick: act.connect },
      { label: "Add model", icon: "plus", guard: perm, onClick: act.addModel },
      ...(act.canDiscover ? [{ label: "Discover models", icon: "refresh", guard: perm, onClick: act.discover }] : []),
      { label: "Vendor details, keys and models", icon: "list", onClick: () => navigate("models", "vendors") },
      ...(v.connected ? [{ sep: true }, { label: "Disconnect", kind: "danger", guard: perm, onClick: act.disconnect }] : []),
    ];
    ui.menu(anchor, v.name, items);
  };
  const sub = [kind, v.connected ? (v.latency ? `Last check ${v.latency} ms` : "No check yet") : ""].filter(Boolean).join(" \u00b7 ");
  return (
    <article className={`md-vc${v.connected ? "" : " is-off"}${selected ? " is-selected" : ""}`} id={`vc-${v.id}`} aria-label={v.name}>
      <Btn cls="md-vc-main" id={`vc-pick-${v.id}`} aria-pressed={selected} aria={`${selected ? "Showing" : "Show"} ${v.name} models`} onClick={onSelect}>
        <span className="md-vc-head">
          <span className="md-vc-name ell">{v.name}</span>
          <Status tone={healthTone(v)}>{healthText(v)}</Status>
        </span>
        <span className="md-vc-kind small muted ell" title={sub}>{sub || "\u00a0"}</span>
        <span className="md-vc-stats">
          <span className="md-vc-cell">
            {!v.connected ? (
              <>
                <span className="small muted">Budget</span>
                <span className="small">{v.budget ? <><b className="mono">{fmt.money0(v.budget)}</b> a month</> : "No budget set"}</span>
              </>
            ) : v.budget ? (
              <>
                <span className="small muted">This month</span>
                <span className="small"><b className="mono">{spendText(v.mtd || 0)}</b> of {fmt.money0(v.budget)}</span>
                <span className="md-vc-meter"><Meter value={v.mtd || 0} max={v.budget} label={`${v.name} spend vs budget`} warnAt={0.8} /><span className={`mono small${pct >= 0.8 ? " warn-text" : ""}`}>{fmt.pct(pct)}</span></span>
              </>
            ) : (
              <>
                <span className="small muted">This month</span>
                <span className="small"><b className="mono">{spendText(v.mtd || 0)}</b></span>
                <span className="small muted">No budget set</span>
              </>
            )}
          </span>
          <span className="md-vc-cell">
            <span className="small muted">Models</span>
            {v.models.length ? <span className="small"><b className="mono">{on}/{v.models.length}</b> enabled</span> : <span className="small">None yet</span>}
          </span>
        </span>
        <span className="md-vc-res small muted"><Icon name="shield" /><span className="ell" title={residencyLine(v)}>{residencyLine(v)}</span></span>
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
      <Btn cls="md-vc md-vc-add" id="md-add-vendor" guard={perm} onClick={onAdd}>
        <Icon name="plus" /><span><b>Add vendor</b><span className="small muted">Pick a template or enter an endpoint</span></span>
      </Btn>
    </section>
  );
}
