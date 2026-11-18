/**
 * Notifications (spec 8.8, 12.2), the Control Room screen: tabs Matrix (who hears about what: event by channel switches), Deliveries and
 * Channels (`?tab=`). The route editor, card templates and repo overrides stay one step away, listed under the channels (`?tab=routes|templates|overrides`). Kill and restore cannot be switched off. Destinations are connections from Integrations.
 */
import { useCan } from "../api/can";
import { useDeliveries } from "../api/queries";
import { Btn, Empty, Tabs, type Decision } from "../ui/primitives";
import { Async } from "../ui/async";
import { Page } from "../ui/cr";
import { ChannelsTab } from "./notifications/Channels";
import { DeliveriesTab, dlStatus } from "./notifications/Deliveries";
import { MatrixTab } from "./notifications/Matrix";
import { OverridesTab, TemplatesTab } from "./notifications/Other";
import { RoutesTab } from "./notifications/Routes";
import { useNtData } from "./notifications/kit";
import { oneOf, useUrlState } from "./connect/kit";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });
const MAIN = ["matrix", "deliveries", "channels"] as const;
const MORE = ["routes", "templates", "overrides"] as const;
export const MORE_LABEL = { routes: "Routes and cards", templates: "Card templates", overrides: "Repo overrides" } as const;

export default function NotificationsView() {
  const nt = useNtData();
  const p = nt.project;
  const perm = dec(useCan("notify.edit", p ? { project: p.id } : {}));
  const url = useUrlState({ tab: "matrix", q: "", st: "all", sort: "", dir: "", page: "0", view: "" });
  const tab = oneOf(url.v.tab, [...MAIN, ...MORE], "matrix");
  const dq = useDeliveries({ project: p?.id ?? "", limit: 200 });
  const failed = (Array.isArray(dq.data) ? dq.data : dq.data?.items ?? []).filter((d) => d.status === "failed" && dlStatus(d) === "failed").length;
  if (!nt.me) return null;
  const head = { eyebrow: "Connect", title: "Notifications", sub: "Choose which events reach which channels, and check that they arrived." };
  if (!p) {
    return (
      <Page {...head} cls="nt-view">
        <Async query={nt.projectsQ} what="your projects" id="nt">{() => <Empty title="No projects" text="You have no projects to configure." />}</Async>
      </Page>
    );
  }
  const more = (MORE as readonly string[]).includes(tab);
  return (
    <Page {...head} cls="nt-view">
      {more ? (
        <div className="row" style={{ marginBottom: 12 }}><Btn label="Back to matrix" small kind="ghost" icon="arrow-left" id="nt-back" onClick={() => url.clear()} /><span className="dim">{MORE_LABEL[tab as (typeof MORE)[number]]} on {p.name}</span></div>
      ) : (
        <Tabs idPrefix="nt-tab" active={tab} onChange={(t) => url.set({ tab: t, q: "", st: "all", sort: "", dir: "", page: "0" })} items={[
          { id: "matrix", label: "Matrix" },
          { id: "deliveries", label: "Deliveries", ...(failed ? { count: failed } : {}) },
          { id: "channels", label: "Channels" },
        ]} />
      )}
      <div id="nt-tab-panel" role="tabpanel" aria-labelledby={`nt-tab-${tab}`}>
        {tab === "deliveries" ? <DeliveriesTab p={p} url={url} />
          : tab === "channels" ? <ChannelsTab p={p} nt={nt} perm={perm} onMore={(m) => url.set({ tab: m })} />
          : tab === "routes" ? <RoutesTab key={p.id} p={p} nt={nt} perm={perm} />
          : tab === "templates" ? <TemplatesTab p={p} nt={nt} perm={perm} />
          : tab === "overrides" ? <OverridesTab p={p} nt={nt} />
          : (
            <MatrixTab p={p} nt={nt} perm={perm} />
          )}
      </div>
    </Page>
  );
}
