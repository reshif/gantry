/**
 * Models (spec 8.7 Models row, 10.4, 10.5). Port of legacy/js/views/models.js against /api/v1/vendors, /models, /routing, /prices and /budgets: the vendor hub
 * (key sealed and shown masked, region or endpoint, health and latency from real calls, spend against budget, residency, model toggles, used-by) and the routing
 * policy editor (default, station and class overrides, fallback order, residency rules, route preview from the gateway's own resolver).
 * New beyond the legacy screen, because the spec asks for it: data-retention per vendor, station qualification for custom vendors, the per-project policy
 * (allowed vendors, regions, retention, cross-model opt-in), the factory switch for cross-model fallback (off in a new install), price versions with effective
 * dates and the per-work-order cost cap.
 * Not ported, on purpose: the "Test connection" button (it only simulated an answer; health and latency now come from the metering of real calls), the simulated
 * wording of the connect dialogs, and the client-side route resolver (the preview asks GET /routing/resolve).
 */
import { useProjects, useRouting, useVendors } from "../api/queries";
import { useCan } from "../api/can";
import { useUI } from "../ui/overlay-context";
import { Btn, Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
import { useRouteTab } from "../lib/routeQuery";
import { Async, qState } from "../ui/async";
import { useCatalog } from "./projects/kit";
import { ModelPrices, PriceVersions, ProjectBudgets, VendorBudgets } from "./models/Prices";
import { AddVendorDialog } from "./models/Templates";
import { RoutingPanel } from "./models/Routing";
import { AddVendorCard, VendorCard } from "./models/Vendor";
import VendorPage from "./models/VendorPage";
import { useHash } from "../lib/router";
import { dec, usd, vendorHref, vendorOfParam } from "./models/kit";


export default function ModelsView() {
  const vendorId = vendorOfParam(useHash().param);
  return vendorId ? <VendorPage id={vendorId} /> : <ModelsHome />;
}

/** After a vendor is added, its page opens: that is where its models are. */
const openVendor = (id: string): void => { window.location.hash = vendorHref(id); };

function ModelsHome() {
  const vq = useVendors();
  const rq = useRouting();
  const vendors = vq.data ?? [];
  const projects = useProjects().data ?? [];
  const cat = useCatalog();
  const ui = useUI();
  const perm = dec(useCan("model.edit"));

  const mtd = vendors.reduce((t, v) => t + (v.mtd || 0), 0);
  const bud = vendors.reduce((t, v) => t + (v.budget || 0), 0);
  const allN = vendors.reduce((t, v) => t + v.models.length, 0);
  const enabledN = vendors.reduce((t, v) => t + v.models.filter((m) => m.enabled).length, 0);
  const defaultModel = vendors.flatMap((v) => v.models.map((m) => ({ m, v }))).find((x) => x.m.id === rq.data?.defaultModel);

  const [tab, setTab] = useRouteTab(["vendors", "routing", "prices"], "vendors");

  return (
    <div className="view view-models">
      <ViewHead
        title="Models"
        kicker="All lines"
        sub="Vendors, routing and what each station spends."
        actions={<Btn label="Add vendor" kind="primary" icon="plus" id="md-add-vendor" guard={perm} onClick={() => ui.open((close) => <AddVendorDialog close={close} onAdded={openVendor} />)} />}
      />
      <StatRow id="md-stats">
        <Stat label="Models" value={qState(vq, () => String(allN))} sub={`${enabledN} enabled`} tone="info" />
        <Stat label="Vendors" value={qState(vq, () => String(vendors.length))} sub={`${vendors.filter((v) => v.connected).length} connected`} />
        <Stat label="Spend MTD" value={qState(vq, () => usd(mtd))} sub={bud ? `of ${usd(bud)}` : "month to date"} />
        <Stat label="Default" value={qState(rq, (r) => defaultModel?.m.name ?? r.defaultModel ?? "–")} sub="unless overridden" />
      </StatRow>
      <Tabs idPrefix="md-tab" active={tab} onChange={setTab} items={[{ id: "vendors", label: "Vendors", count: vq.data ? vendors.length : null }, { id: "routing", label: "Routing" }, { id: "prices", label: "Prices and budgets" }]} />
      <Async query={vq} what="model vendors" id="models">
        {() => (
          <Async query={rq} what="model routing" id="models-routing">
            {(r) => tab === "vendors" ? (
              <div className="stack md-stack">
              <div className="card-grid vendor-grid">
                {vendors.map((v) => <VendorCard key={v.id} v={v} />)}
                <AddVendorCard onAdded={openVendor} />
              </div>
              </div>
            ) : tab === "routing" ? (
              <RoutingPanel routing={r} vendors={vendors} cat={cat} />
            ) : (
              <div className="stack md-stack">
                <ModelPrices vendors={vendors} />
                <PriceVersions />
                <VendorBudgets vendors={vendors} />
                <ProjectBudgets projects={projects} />
              </div>
            )}
          </Async>
        )}
      </Async>
    </div>
  );
}
