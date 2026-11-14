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
import { fmt } from "@gantry/domain";
import { useCan } from "../api/can";
import { useAgents, useProjects, useRouting, useVendors } from "../api/queries";
import { Btn, Empty, ViewHead } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { useCatalog } from "./projects/kit";
import { useAllRepos } from "./govern/data";
import { Callout } from "./models/Callout";
import { AddVendorDialog } from "./models/Templates";
import { BudgetsPanel, PricesPanel } from "./models/Prices";
import { RoutingPanel } from "./models/Routing";
import { VendorPanel } from "./models/Vendor";
import { dec } from "./models/kit";

export default function ModelsView() {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const vq = useVendors();
  const rq = useRouting();
  const vendors = vq.data ?? [];
  const agents = useAgents().data ?? [];
  const projects = useProjects().data ?? [];
  const cat = useCatalog();
  const { repos } = useAllRepos();
  const routing = rq.data;

  const mtd = vendors.reduce((t, v) => t + (v.mtd || 0), 0);
  const bud = vendors.reduce((t, v) => t + (v.budget || 0), 0);
  const enabledN = vendors.reduce((t, v) => t + (v.connected ? v.models.filter((m) => m.enabled).length : 0), 0);
  const degraded = vendors.filter((v) => v.connected && v.health !== "healthy");

  const scrollTo = (id: string) => setTimeout(() => document.getElementById(`vendor-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 60);

  return (
    <div className="view view-models">
      <ViewHead
        kicker="Agents · Sheet 15"
        title="Models"
        sub="Vendors the factory may call, what each costs, where data is processed, and how work is routed between them."
        meta={[["Default", routing?.defaultModel ?? "–"], ["Vendors connected", `${vendors.filter((v) => v.connected).length} / ${vendors.length}`], ["Models on", String(enabledN)], ["Spend MTD", `${fmt.money0(mtd)} / ${fmt.money0(bud)}`]]}
        actions={<Btn label="Add vendor" kind="primary" icon="plus" id="md-add-vendor" guard={perm} onClick={() => ui.open((close) => <AddVendorDialog close={close} onAdded={scrollTo} />)} />}
      />
      {degraded.length ? (
        <Callout warn icon="alert" cls="md-incident" role="status">
          {`${degraded.map((v) => `${v.name} is ${v.health}${v.latency ? ` (p50 ${v.latency} ms)` : ""}.`).join(" ")} Calls to it fall back to the same model on another allowed vendor when it errors.`}
        </Callout>
      ) : null}
      {vq.isError || rq.isError ? <Empty title="Models could not be loaded" text="Reload the page, or try again in a moment." /> : null}
      <div className="vendor-grid">
        {routing ? vendors.map((v) => <VendorPanel key={v.id} v={v} vendors={vendors} routing={routing} agents={agents} cat={cat} />) : null}
      </div>
      {routing ? <RoutingPanel routing={routing} vendors={vendors} agents={agents} repos={repos} projects={projects} cat={cat} /> : null}
      {routing ? <PricesPanel vendors={vendors} /> : null}
      {routing ? <BudgetsPanel projects={projects} /> : null}
    </div>
  );
}
