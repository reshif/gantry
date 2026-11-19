/**
 * Notifications (spec 8.8, 12.2), in the Blueprint prototype's layout: stat strip, four tabs held in the URL (Routes, Card templates, Repo overrides,
 * Delivery log), a route list with a switch and a trash button per row, an "Add a route" dialog, the three built-in card previews drawn by the server,
 * repos that change the routes, and the delivery log across all projects with Retry.
 * Kept from the working build and reached from a row: the full route editor, the card designer, test sends and custom card templates.
 * Delivery is not simulated: a test send and a retry queue a real delivery that the worker sends, and the log shows what happened.
 */
import { useCan } from "../api/can";
import { usePrefs } from "../lib/prefs";
import { useDeliveries } from "../api/queries";
import { Empty, Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import { CardsTab, DeliveriesTab, OverridesTab } from "./notifications/Other";
import { RoutesTab } from "./notifications/Routes";
import { useNtData } from "./notifications/kit";
import { dec, useTab } from "./connect/kit";
import "../styles/views/notifications.css";

export default function NotificationsView() {
  const nt = useNtData();
  const allLines = usePrefs().scopeAll; // the switcher says "All projects": the page still edits one project, and says which
  const p = nt.project;
  const perm = dec(useCan("notify.edit", p ? { project: p.id } : {}));
  const [tab, setTab] = useTab(["routes", "templates", "overrides", "log"]);
  // one read across every project, counted here (the prototype counts the whole log)
  const logQ = useDeliveries({ limit: 200 });
  const log = Array.isArray(logQ.data) ? logQ.data : logQ.data?.items ?? [];
  const delivered = log.filter((x) => x.status === "delivered").length;
  const failed = log.filter((x) => x.status === "failed").length;
  if (!nt.me) return null;
  if (!p) {
    return (
      <div className="view cx nt-view">
        <ViewHead title="Notifications" kicker="All lines" />
        <Async query={nt.projectsQ} what="your projects" id="nt">{() => <Empty title="No projects" text="You have no projects to configure." />}</Async>
      </div>
    );
  }
  return (
    <div className="view cx nt-view">
      <ViewHead title="Notifications" kicker={allLines ? "All lines" : p.key} sub={allLines ? `Routes, cards and the delivery log. Showing ${p.name}; pick a project in the switcher to edit another.` : `Routes, cards and the delivery log for ${p.name}.`} />
      <StatRow id="nt-stats">
        <Stat label="Routes" value={String(p.notifications.length)} sub={`${p.notifications.filter((r) => r.enabled).length} on`} tone="info" />
        <Stat label="Delivered" value={qState(logQ, () => String(delivered))} sub="last 24 h" tone="done" />
        <Stat label="Failed" value={qState(logQ, () => String(failed))} sub="need a retry" tone={failed ? "block" : undefined} />
        <Stat label="Channels" value={String(new Set(p.notifications.flatMap((r) => r.dest.map((d) => d.channel))).size)} />
      </StatRow>
      <Tabs idPrefix="nt-tab" active={tab} onChange={setTab} items={[
        { id: "routes", label: "Routes", count: p.notifications.length },
        { id: "templates", label: "Card templates", count: 3 },
        { id: "overrides", label: "Repo overrides" },
        { id: "log", label: "Delivery log", count: logQ.data ? log.length : null },
      ]} />
      <div id="nt-tab-panel" role="tabpanel" aria-labelledby={`nt-tab-${tab}`}>
        {tab === "overrides" ? <OverridesTab p={p} nt={nt} /> : tab === "log" ? <DeliveriesTab p={p} nt={nt} /> : tab === "templates" ? <CardsTab p={p} /> : <RoutesTab key={p.id} p={p} nt={nt} perm={perm} />}
      </div>
    </div>
  );
}
