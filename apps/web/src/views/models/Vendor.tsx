/** Vendor summary cards (Models, Blueprint): one card per vendor that links to the vendor's page, a "+ Add vendor" card at the end. The models live on the vendor page. */
import type { Vendor } from "@gantry/domain";
import { discoverVendorModels } from "./commands";
import { useCan } from "../../api/can";
import { Btn, Chip } from "../../ui/primitives";
import { AddVendorDialog } from "./Templates";
import { useUI } from "../../ui/overlay-context";
import { dec, usd, vendorHref } from "./kit";

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

export function VendorCard({ v }: { v: Vendor }) {
  const hasBudget = (v.budget || 0) > 0;
  const ratio = hasBudget ? (v.mtd || 0) / v.budget : 0;
  const enabled = v.models.filter((m) => m.enabled).length;
  const product = productLine(v);
  const tone = !v.connected || v.health !== "healthy" ? "warn" : "ok";
  return (
    <section className="card vendor md-vcard" aria-label={v.name} id={`vendor-${v.id}`}>
      <div className="row vendor-head md-vhead">
        <div className="md-vtitle">
          <span className="vendor-name">{v.name}</span>
          {product ? <span className="small muted">{product}</span> : null}
        </div>
        <Chip text={v.connected ? v.health : "offline"} cls={tone} />
      </div>
      <dl className="kv tb-vendor md-kv">
        <dt>{hasBudget ? "Spend this month" : "Spend"}</dt>
        <dd>{hasBudget ? `${usd(v.mtd || 0)} / ${usd(v.budget)}` : <>{usd(v.mtd || 0)} <span className="muted">· No budget set</span></>}</dd>
        <dt>Models</dt><dd>{`${enabled} of ${v.models.length} enabled`}</dd>
        <dt>Last check</dt><dd>{v.connected && v.latency ? `${v.latency} ms` : "No calls yet"}</dd>
      </dl>
      {hasBudget ? <div className={`meter${ratio > 0.8 ? " warn" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, ratio) * 100)} aria-label={`${v.name} spend vs budget`}><i style={{ width: `${Math.min(1, ratio) * 100}%` }} /></div> : null}
      <div className="small muted residency md-resid" title={residencyLine(v)}>{residencyLine(v)}</div>
      <div className="md-vfoot">
        <a className="md-vopen" id={`vendor-open-${v.id}`} href={vendorHref(v.id)}><span className="sr">{`Open ${v.name}: `}</span>{`${v.models.length} model${v.models.length === 1 ? "" : "s"}`}<span aria-hidden="true"> →</span></a>
      </div>
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
