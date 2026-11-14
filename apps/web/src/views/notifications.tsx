/**
 * Notifications (spec 8.8, 12.2). Port of legacy/js/views/notifications.js against the routes, card-template and delivery endpoints.
 * Routes per project (event -> destinations -> card template -> conditions), repo overrides, a card designer with field toggles, custom card templates,
 * test sends and the delivery log with retry. Destinations are connections from Integrations. Kill and restore cannot be switched off.
 * Not ported, on purpose: "Delivery is simulated": a test send and a retry queue a real delivery that the worker sends, and the log shows what happened.
 */
import { useState } from "react";
import { useCan } from "../api/can";
import { useDeliveries } from "../api/queries";
import { Empty, Tabs, ViewHead, type Decision } from "../ui/primitives";
import { useProjectRepos } from "./floor/kit";
import { DeliveriesTab, OverridesTab, TemplatesTab } from "./notifications/Other";
import { RoutesTab } from "./notifications/Routes";
import { TPL, useNtData } from "./notifications/kit";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

export default function NotificationsView() {
  const nt = useNtData();
  const p = nt.project;
  const perm = dec(useCan("notify.edit", p ? { project: p.id } : {}));
  const [tab, setTab] = useState("routes");
  const repos = useProjectRepos(p?.id);
  const ovN = repos.reduce((n, r) => n + (r.notifyOverrides ?? []).length, 0);
  const failedQ = useDeliveries({ project: p?.id ?? "", status: "failed", limit: 200 });
  const failed = p ? (Array.isArray(failedQ.data) ? failedQ.data : failedQ.data?.items ?? []).length : 0;
  if (!nt.me) return null;
  if (!p) {
    return (
      <div className="view cx nt-view">
        <ViewHead kicker="Connect · Notifications" title="Notifications" />
        <Empty title="No projects" text="You have no projects to configure." />
      </div>
    );
  }
  return (
    <div className="view cx nt-view">
      <ViewHead
        kicker="Connect · Notifications"
        title="Notifications"
        sub="Which events reach which people, through which connection, with which card. Per project, with repo overrides. Every notification comes from a committed event and is delivered at least once."
        meta={[["Project", p.name], ["Routes", `${p.notifications.filter((r) => r.enabled).length} on / ${p.notifications.length}`], ["Connections", String(nt.destInsts.length)], ["Failed deliveries", String(failed)], ["Edit rights", perm.allowed ? "yes" : "read-only"]]}
        actions={nt.visible.length > 1 ? <span className="muted small">Switch project in the top bar to edit another project's routes.</span> : undefined}
      />
      <Tabs idPrefix="nt-tab" active={tab} onChange={setTab} items={[
        { id: "routes", label: "Routes", count: p.notifications.length },
        { id: "templates", label: "Card templates", count: Object.keys(TPL).length + nt.customCards.length },
        { id: "overrides", label: "Repo overrides", count: ovN },
        { id: "log", label: failed ? `Delivery log (${failed} failed)` : "Delivery log" },
      ]} />
      <div id="nt-tab-panel" role="tabpanel" aria-labelledby={`nt-tab-${tab}`}>
        {tab === "overrides" ? <OverridesTab p={p} nt={nt} /> : tab === "log" ? <DeliveriesTab p={p} nt={nt} /> : tab === "templates" ? <TemplatesTab p={p} nt={nt} perm={perm} /> : <RoutesTab key={p.id} p={p} nt={nt} perm={perm} />}
      </div>
    </div>
  );
}
