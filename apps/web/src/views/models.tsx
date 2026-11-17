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
import { Btn, Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
import { navigate, useHash } from "../lib/router";
import { Async, qState } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { useCatalog } from "./projects/kit";
import { useAllRepos } from "./govern/data";
import { Callout } from "./models/Callout";
import { AddVendorDialog } from "./models/Templates";
import { BudgetsPanel, PricesPanel, VendorBudgets } from "./models/Prices";
import { RoutingPanel } from "./models/Routing";
import { VendorPanel } from "./models/Vendor";
import { dec } from "./models/kit";

type Tab = "vendors" | "routing" | "prices";

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

  const mtd = vendors.reduce((t, v) => t + (v.mtd || 0), 0);
  const bud = vendors.reduce((t, v) => t + (v.budget || 0), 0);
  const allN = vendors.reduce((t, v) => t + (v.connected ? v.models.length : 0), 0);
  const enabledN = vendors.reduce((t, v) => t + (v.connected ? v.models.filter((m) => m.enabled).length : 0), 0);
  const degraded = vendors.filter((v) => v.connected && v.health !== "healthy");
  const defaultModel = vendors.flatMap((v) => v.models.map((m) => ({ m, v }))).find((x) => x.m.id === rq.data?.defaultModel);

  const hash = useHash();
  const tab: Tab = hash.id === "models" && (hash.param === "routing" || hash.param === "prices") ? hash.param : "vendors";
  const setTab = (t: string) => navigate("models", t === "vendors" ? null : t);

  const scrollTo = (id: string) => setTimeout(() => document.getElementById(`vendor-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 60);

  return (
    <div className="view view-models">
      <ViewHead
        title="Models"
        sub="Vendors, routing and what each station spends."
        actions={<Btn label="Add vendor" kind="primary" icon="plus" id="md-add-vendor" guard={perm} onClick={() => ui.open((close) => <AddVendorDialog close={close} onAdded={scrollTo} />)} />}
      />
      <StatRow id="md-stats">
        <Stat label="Models on" value={qState(vq, () => `${enabledN} of ${allN}`)} />
        <Stat label="Vendors connected" value={qState(vq, () => `${vendors.filter((v) => v.connected).length} of ${vendors.length}`)} sub={vendors.some((v) => !v.connected) ? `${vendors.filter((v) => !v.connected).length} not connected` : undefined} />
        <Stat label="Spend this month" value={qState(vq, () => fmt.money0(mtd))} sub={bud ? `of ${fmt.money0(bud)} this month` : "month to date"} />
        <Stat label="Default model" value={qState(rq, (r) => defaultModel?.m.name ?? r.defaultModel ?? "–")} sub={defaultModel ? defaultModel.v.name : undefined} />
      </StatRow>
      <Tabs idPrefix="md-tab" active={tab} onChange={setTab} items={[{ id: "vendors", label: "Vendors", count: vq.data ? vendors.length : null }, { id: "routing", label: "Routing" }, { id: "prices", label: "Prices and budgets" }]} />
      <Async query={vq} what="model vendors" id="models">
        {() => (
          <Async query={rq} what="model routing" id="models-routing">
            {(r) => tab === "vendors" ? (
              <>
                {degraded.length ? (
                  <Callout warn icon="alert" cls="md-incident" role="status">
                    {`${degraded.map((v) => `${v.name} is ${v.health}${v.latency ? ` (p50 ${v.latency} ms)` : ""}.`).join(" ")} Calls to it fall back to the same model on another allowed vendor when it errors.`}
                  </Callout>
                ) : null}
                <div className="card-grid vendor-grid">
                  {vendors.map((v) => <VendorPanel key={v.id} v={v} vendors={vendors} routing={r} agents={agents} cat={cat} />)}
                </div>
              </>
            ) : tab === "routing" ? (
              <RoutingPanel routing={r} vendors={vendors} agents={agents} repos={repos} projects={projects} cat={cat} />
            ) : (
              <div className="md-stack">
                <PricesPanel vendors={vendors} />
                <VendorBudgets vendors={vendors} />
                <BudgetsPanel projects={projects} />
              </div>
            )}
          </Async>
        )}
      </Async>
    </div>
  );
}
