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
import { useDiscoverModels } from "../api/modelCommands";
import { Btn } from "../ui/primitives";
import { Page, Stats } from "../ui/cr";
import { navigate, useHash } from "../lib/router";
import { Async, qState } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { useCatalog } from "./projects/kit";
import { useAllRepos } from "./govern/data";
import { Callout } from "./models/Callout";
import { AddVendorDialog } from "./models/Templates";
import { BudgetsPanel, PricesPanel, VendorBudgets } from "./models/Prices";
import { RoutingPanel } from "./models/Routing";
import { ModelCatalog } from "./models/Catalog";
import { VendorPanel } from "./models/Vendor";
import { dec } from "./models/kit";

type Tab = "models" | "vendors" | "routing" | "prices";

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
  const allN = vendors.reduce((t, v) => t + v.models.length, 0);
  const enabledN = vendors.reduce((t, v) => t + (v.connected ? v.models.filter((m) => m.enabled).length : 0), 0);
  const needsPriceN = vendors.reduce((t, v) => t + v.models.filter((m) => m.needsPrice).length, 0);
  const degraded = vendors.filter((v) => v.connected && v.health !== "healthy");

  const hash = useHash();
  const tab: Tab = hash.id === "models" && (hash.param === "vendors" || hash.param === "routing" || hash.param === "prices") ? hash.param : "models";
  
  const discoverCmd = useDiscoverModels();
  const discover = (): void => {
    const targets = vendors.filter((v) => v.connected && (v.template || v.custom || v.id === "anthropic"));
    if (!targets.length) { ui.toast("No connected vendor can list its models.", "warn"); return; }
    void (async () => { for (const v of targets) { const r = await discoverCmd.run(v.id); if (r) ui.toast(r.msg || (r.ok ? `Checked ${v.name}.` : `Could not check ${v.name}.`), r.ok ? "info" : "error"); } })();
  };
  const scrollTo = (id: string) => setTimeout(() => document.getElementById(`vendor-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 60);

  const openAddVendor = (): void => { ui.open((close) => <AddVendorDialog close={close} onAdded={(id) => { navigate("models", "vendors"); scrollTo(id); }} />); };

  return (
    <Page eyebrow="Workforce" title="Models" cls="view-models"
        sub="Which models agents may use, what they cost and where they are used."
        acts={tab === "models" ? <><Btn label="Discover models" icon="refresh" id="md-discover" guard={perm} onClick={discover} /><Btn label="Add vendor" kind="primary" icon="plus" id="md-add-vendor" guard={perm} onClick={openAddVendor} /></> : <>
          <Btn label="All models" id="md-back" onClick={() => navigate("models")} />
          {tab === "vendors" ? <Btn label="Add vendor" kind="primary" icon="plus" id="md-add-vendor" guard={perm} onClick={() => ui.open((close) => <AddVendorDialog close={close} onAdded={scrollTo} />)} /> : null}
        </>}>
      <Stats id="md-stats" items={[
        { l: "Enabled", v: qState(vq, () => `${enabledN}/${allN}`), tone: "ok" },
        { l: "Needs a price", v: qState(vq, () => needsPriceN), tone: "warn" },
        { l: "Spend, 30 days", v: qState(vq, () => fmt.money0(mtd)), tone: "agent" },
        { l: "Fallbacks fired", v: "\u2014", tone: "info" },
      ]} />
      {tab === "models" ? (
        <div className="row md-manage" id="md-manage">
          {/* KEEP: vendors, routing and prices stay one click away from the catalog (owner, 2026-11-18), as quiet links, not header actions */}
          <Btn label="Vendors" kind="ghost" small id="md-go-vendors" onClick={() => navigate("models", "vendors")} />
          <Btn label="Routing" kind="ghost" small id="md-go-routing" onClick={() => navigate("models", "routing")} />
          <Btn label="Prices" kind="ghost" small id="md-go-prices" onClick={() => navigate("models", "prices")} />
          <Btn label="Add vendor" kind="ghost" small icon="plus" id="md-add-vendor-link" guard={perm} onClick={openAddVendor} />
        </div>
      ) : null}
      <Async query={vq} what="model vendors" id="models">
        {() => (
          <Async query={rq} what="model routing" id="models-routing">
            {(r) => tab === "models" ? (
              <ModelCatalog vendors={vendors} routing={r} agents={agents} />
            ) : tab === "vendors" ? (
              <>
                {degraded.length ? (
                  <Callout warn icon="alert" cls="md-incident" role="status">
                    {`${degraded.map((v) => `${v.name} is ${v.health}${v.latency ? ` (last check ${v.latency} ms)` : ""}.`).join(" ")} Calls to it fall back to the same model on another allowed vendor when it errors.`}
                  </Callout>
                ) : null}
                <div className="vendor-grid">
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
    </Page>
  );
}
