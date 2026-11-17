/**
 * Notifications (spec 8.8, 12.2). Port of legacy/js/views/notifications.js against the routes, card-template and delivery endpoints.
 * Routes per project (event -> destinations -> card template -> conditions), repo overrides, a card designer with field toggles, custom card templates,
 * test sends and the delivery log with retry. Destinations are connections from Integrations. Kill and restore cannot be switched off.
 * Not ported, on purpose: "Delivery is simulated": a test send and a retry queue a real delivery that the worker sends, and the log shows what happened.
 */
import { useState } from "react";
import { navigate } from "../lib/router";
import { useCan } from "../api/can";
import { useDeliveries } from "../api/queries";
import { Btn, Empty, Stat, StatRow, Tabs, ViewHead, type Decision } from "../ui/primitives";
import { Async, qState } from "../ui/async";
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
        <ViewHead title="Notifications" />
        <Async query={nt.projectsQ} what="your projects" id="nt">{() => <Empty title="No projects" text="You have no projects to configure." />}</Async>
      </div>
    );
  }
  return (
    <div className="view cx nt-view">
      <ViewHead
        kicker="Connect"
        title="Notifications"
        sub="Choose which events reach which channels, and check that they arrived."
      />
      <StatRow id="nt-stats">
        <Stat label="Project" value={p.name} sub={`${repos.length} ${repos.length === 1 ? "repo" : "repos"}`} action={<Btn label="Browse" small kind="ghost" id="nt-go-projects" aria={`Browse ${p.name} in Projects`} onClick={() => navigate("projects")} />} />
        <Stat label="Routes" value={`${p.notifications.filter((r) => r.enabled).length} on / ${p.notifications.length}`} sub={p.notifications.length ? `${p.notifications.filter((r) => !r.enabled).length} switched off` : "none yet"} />
        <Stat label="Connections" value={String(nt.destInsts.length)} sub="open to this project" action={<Btn label="Integrations" small kind="ghost" id="nt-go-int" onClick={() => navigate("integrations")} />} />
        <Stat label="Failed deliveries" value={qState(failedQ, () => String(failed))} sub="in the delivery log" tone={failed ? "block" : undefined} action={<Btn label="Delivery log" small kind="ghost" id="nt-go-log" onClick={() => setTab("log")} />} />
        <Stat label="Edit rights" value={perm.allowed ? "yes" : "read-only"} sub={perm.allowed ? "you can change routes" : perm.needs ? `needs ${perm.needs}` : "ask a project admin"} />
      </StatRow>
      {nt.visible.length > 1 ? <p className="muted small nt-switch">Switch project in the top bar to edit another project's routes.</p> : null}
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
