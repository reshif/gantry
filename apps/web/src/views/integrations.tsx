/**
 * Integrations (spec 8.8, 12.1). Port of legacy/js/views/integrations.js against GET/POST /integration-types and /integrations.
 * A catalogue of connector types (built-in real connectors, the rest listed as not yet available, and custom types) and the connected instances,
 * several per type, each scoped to projects. A new connection is switched off until someone turns it on (spec 15.3).
 * Not ported, on purpose: the simulated connection test and its footnote. The test calls the service for real.
 */
import { DAY, INTEGRATION_CATEGORIES, type IntegrationInstance } from "@gantry/domain";
import { useCan } from "../api/can";
import { useDeliveries } from "../api/queries";
import { Stat, StatRow, Tabs, ViewHead, type Decision } from "../ui/primitives";
import { useTab } from "./connect/kit";
import { Async, qState } from "../ui/async";
import { Dialog } from "../ui/Overlay";
import { useUI } from "../ui/overlay-context";
import { AddIntegration } from "./integrations/AddDialog";
import { EditIntegration, InstanceDrawer, RemoveIntegration, ToggleIntegration, TypeDrawer } from "./integrations/Instance";
import { CatalogueTab, ConnectedTab, CustomTab } from "./integrations/Tabs";
import { statusOf, useIntegrationData, type TypeRow } from "./integrations/kit";
import { ops } from "../api/ops";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

export default function IntegrationsView() {
  const ui = useUI();
  const d = useIntegrationData();
  const add = dec(useCan("integration.add"));
  const [tab, setTab] = useTab(["connected", "catalogue", "builder"]);
  const failedQ = useDeliveries({ status: "failed", limit: 200 });
  const failedItems = Array.isArray(failedQ.data) ? failedQ.data : failedQ.data?.items ?? [];
  const failedDay = failedItems.filter((x) => x.at > Date.now() - DAY);
  // a failure on a connection makes that connection unhealthy; one with no connection is a routing gap, not a broken integration
  const failed = failedDay.filter((x) => x.integration).length;

  const toggleInst = (i: IntegrationInstance): void => {
    if (!i.connected) {
      void ops.updateIntegration(i.id, { connected: true }, i.version !== undefined ? { ifMatch: i.version } : undefined).then((r) => ui.toast(r.ok ? `${i.name} enabled.` : r.msg, r.ok ? "ok" : "error"));
      return;
    }
    ui.open((c) => <ToggleIntegration inst={i} close={c} />);
  };
  const openInstance = (id: string): void => {
    ui.drawer.open(`int:${id}`, (close) => (
      <InstanceDrawer
        id={id} close={close}
        onEdit={(i: IntegrationInstance) => ui.open((c) => <EditIntegration inst={i} close={c} />)}
        onToggle={(i: IntegrationInstance) => {
          if (!i.connected) {
            void ops.updateIntegration(i.id, { connected: true }, i.version !== undefined ? { ifMatch: i.version } : undefined).then((r) => ui.toast(r.ok ? `${i.name} enabled.` : r.msg, r.ok ? "ok" : "error"));
            return;
          }
          ui.open((c) => <ToggleIntegration inst={i} close={c} />);
        }}
        onRemove={(i: IntegrationInstance) => ui.open((c) => <RemoveIntegration inst={i} close={c} closeDrawer={close} />)}
      />
    ));
  };
  const addDialog = (typeId: string | null): void => {
    ui.open((close) => <AddIntegration typeId={typeId} types={d.types} insts={d.insts} live={d.live} projects={d.projects} close={close} onAdded={(id) => { setTab("connected"); openInstance(id); }} />);
  };
  const openType = (id: string): void => {
    ui.drawer.open(`int-type:${id}`, (close) => (
      <TypeDrawer
        id={id} close={close} onAdd={addDialog} onOpen={openInstance}
        onRemove={(t: TypeRow) => ui.open((c) => (
          <Dialog title={`Remove ${t.name} from the catalogue?`} kicker="Integrations · custom type" onClose={c} actions={[{ label: "Cancel" }, { label: "Remove type", kind: "danger", id: "int-t-remove-go", guard: add, onClick: async () => {
            const r = await ops.removeIntegrationType(t.id);
            ui.toast(r.msg, r.ok ? "ok" : "error");
            if (r.ok) { c(); close(); }
          } }]} body={<p>No connection uses it. New connections of this type can no longer be added. The removal is audited.</p>} />
        ))}
      />
    ));
  };

  const all = d.insts;
  const failing = all.filter((i) => statusOf(i) === "failing").length;
  const off = all.filter((i) => !i.connected).length;
  const tabs = [{ id: "connected", label: "Connected", count: all.length }, { id: "catalogue", label: "Catalogue", count: d.types.length }, { id: "builder", label: "Custom builder" }];

  return (
    <div className="view cx int-view">
      <ViewHead title="Integrations" kicker="All lines" sub="Where Gantry reads requests from and writes results to." />
      <StatRow id="int-stats">
        <Stat label="Connected" value={qState(d.instsQ, () => String(all.length - off))} sub={`of ${all.length}`} tone="done" />
        <Stat label="Needs attention" value={qState(d.instsQ, () => String(failing + off + failed))} tone={failing + off + failed ? "wait" : undefined} />
        <Stat label="Catalogue" value={qState(d.typesQ, () => String(d.types.length))} sub="types" />
        <Stat label="Categories" value={String(INTEGRATION_CATEGORIES.length)} />
      </StatRow>
      <Tabs idPrefix="int-tab" items={tabs} active={tab} onChange={setTab} />
      <div id="int-tab-panel" role="tabpanel" aria-labelledby={`int-tab-${tab}`}>
        {tab === "catalogue" ? (
          <Async query={d.typesQ} what="the integration catalogue" id="int-cat">{() => <CatalogueTab openType={openType} onAdd={addDialog} goBuild={() => setTab("builder")} />}</Async>
        ) : tab === "builder" ? (
          <Async query={d.typesQ} what="custom integration types" id="int-custom">{() => <CustomTab onAddInstance={addDialog} openType={openType} />}</Async>
        ) : (
          <Async query={d.instsQ} what="connected integrations" id="int">{() => <ConnectedTab openInstance={openInstance} onToggle={toggleInst} />}</Async>
        )}
      </div>
    </div>
  );
}
