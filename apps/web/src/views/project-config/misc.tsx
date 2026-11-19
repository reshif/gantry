/** Project config pieces that more than one tab uses: the notification summary (Overview), spend by station (Budget) and the archive panel (Line control). */
import { fmt, type WorkOrder } from "@gantry/domain";
import { commands as ops } from "../../api/commands";
import { useCan } from "../../api/can";
import { useDeliveries, useKillImpact, useMe, useWorkOrders } from "../../api/queries";
import { canSeeRoute } from "../../lib/routes";
import { navigate } from "../../lib/router";
import { useOpenTraveler } from "../../shell/useTraveler";
import { Btn, Empty, LockNote, Panel } from "../../ui/primitives";
import { DataTable } from "../../ui/DataTable";
import { Async } from "../../ui/async";
import { useUI } from "../../ui/overlay-context";
import { evName, flowOf, useRes } from "../projects/kit";
import { ToggleRow } from "../projects/proto";
import type { PcProps } from "./ctx";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Overview: how many routes this project has, a quick on/off for each, the last few deliveries, and the way to the Notifications screen. */
export function NotificationsSummary({ p }: Pick<PcProps, "p">) {
  const res = useRes();
  const me = useMe();
  const d = useCan("notify.edit", { project: p.id });
  const q = useDeliveries({ project: p.id, limit: 4 });
  const routes = p.notifications;
  const on = routes.filter((r) => r.enabled).length;
  return (
    <Panel title="Notifications" id="pcf-notify" tools={canSeeRoute("notifications", me) ? <Btn small kind="ghost" id="pcf-to-notify" label="Edit routes and cards" onClick={() => navigate("notifications")} /> : null}>
      <div className="stack">
        <LockNote decision={d} what="Notification routes" />
        <p className="small muted" id="pcf-notify-count">{`${routes.length} route${routes.length === 1 ? "" : "s"}, ${on} on.`}</p>
        {routes.length ? (
          <div>
            {routes.map((rt, i) => {
              const lockKill = (rt.event === "kill" || rt.event === "restore") && rt.enabled;
              return (
                <ToggleRow key={rt.id} id={`pcf-nr-${rt.id}`} label={evName(rt.event)} hint={rt.dest.map((x) => `${x.channel} ${x.target}`).join(", ") || "no destination"} checked={rt.enabled}
                  decision={lockKill && d.allowed ? { allowed: false, reason: "Kill and restore notices must stay on.", needs: "" } : d}
                  onChange={async (v) => { const arr = clone(routes); arr[i]!.enabled = v; res(await ops.setProject(p.id, "notifications", arr, { ifMatch: p.version }), `${evName(rt.event)} route ${v ? "on." : "off."}`); }} />
              );
            })}
          </div>
        ) : <Empty title="No routes" text="This project sends no notifications yet. Add routes on the Notifications screen." />}
        <div className="small strong">Recent deliveries</div>
        <Async query={q} what="deliveries" id="pcf-dl" empty={<Empty id="pcf-dl-empty" title="No deliveries yet" text="Deliveries for this project appear here." />}>
          {(raw) => {
            const list = (Array.isArray(raw) ? raw : (raw.items ?? [])) as Array<{ id: string; at: number; event: string; channel: string; target: string; status: string }>;
            return (
              <ul className="plain-list small">
                {list.slice(0, 4).map((x) => (
                  <li key={x.id} className="pcf-dl">
                    <span className="mono muted">{fmt.ist(x.at)}</span>
                    <span>{evName(x.event)}</span>
                    <span className="mono">{`${x.channel} ${x.target}`}</span>
                    <span className={`outcome o-${x.status === "delivered" ? "ok" : "failed"}`}>{x.status}</span>
                  </li>
                ))}
              </ul>
            );
          }}
        </Async>
      </div>
    </Panel>
  );
}

/** Budget: agent spend by station and the most expensive work orders, from the work orders on record (the month-to-date figure above them is the metered one). */
export function SpendBreakdown({ p, cat }: Pick<PcProps, "p" | "cat">) {
  const openTraveler = useOpenTraveler();
  const q = useWorkOrders(p.id, { limit: 200 });
  const stations = flowOf(cat, p).stations;
  return (
    <Async query={q} what="spend by station" id="pcf-spend">
      {(raw) => {
        const wos = (Array.isArray(raw) ? raw : ((raw as { items?: WorkOrder[] }).items ?? [])) as WorkOrder[];
        const byStation = stations.map((s) => ({ s, v: wos.reduce((a, w) => a + (w.history ?? []).filter((e) => e.station === s.id).reduce((x, e) => x + (e.cost || 0), 0), 0) }));
        const onStations = byStation.reduce((a, x) => a + x.v, 0);
        const other = Math.max(0, p.budget.mtd - onStations);
        const max = Math.max(1, other, ...byStation.map((x) => x.v));
        const top = wos.map((w) => ({ w, cost: (w.history ?? []).reduce((a, e) => a + (e.cost || 0), 0) })).sort((a, c) => c.cost - a.cost).slice(0, 5);
        return (
          <div className="cols">
            <Panel title="Spend by station" id="pcf-bud-stations">
              <ul className="hm-bars">
                {byStation.map((x) => {
                  const tip = `${x.s.name}: ${fmt.money(x.v)}`;
                  return (
                    <li key={x.s.id} className="hm-bar-row is-ok" tabIndex={0} data-tip={tip} aria-label={tip} id={`pcf-bud-st-${x.s.id}`}>
                      <span className="hm-bar-l">{`${x.s.no} ${x.s.name}`}</span>
                      <span className="hm-bar-track" aria-hidden="true"><span className="hm-bar-fill" style={{ width: `${((x.v / max) * 100).toFixed(1)}%` }} /></span>
                      <span className="hm-bar-v mono">{fmt.money(x.v)}</span>
                    </li>
                  );
                })}
                <li className="hm-bar-row is-ok" id="pcf-bud-st-other">
                  <span className="hm-bar-l">Not tied to a station</span>
                  <span className="hm-bar-track" aria-hidden="true"><span className="hm-bar-fill" style={{ width: `${((other / max) * 100).toFixed(1)}%` }} /></span>
                  <span className="hm-bar-v mono">{fmt.money(other)}</span>
                </li>
              </ul>
              <p className="small muted" id="pcf-bud-note">{`Stations add up the cost recorded on the ${wos.length} most recent work orders. The rest of the month-to-date figure (${fmt.money(p.budget.mtd)}, metered) is chat, side threads and older work orders, shown as Not tied to a station.`}</p>
            </Panel>
            <Panel title="Most expensive work orders" id="pcf-bud-top" flush>
              <DataTable
                id="pcf-bud-top-table" caption="Most expensive work orders" rows={top} rowKey={(x) => x.w.id}
                empty={{ title: "No spend yet", text: "Work orders with agent cost appear here." }}
                columns={[
                  { key: "id", label: "Work order", render: (x) => <Btn small kind="ghost" cls="mono" id={`pcf-bud-wo-${x.w.id}`} label={x.w.id} aria={`Open ${x.w.id}`} onClick={() => openTraveler(x.w.id)} /> },
                  { key: "t", label: "Title", render: (x) => <span className="small">{x.w.title}</span> },
                  { key: "c", label: "Cost", align: "end", render: (x) => <span className="mono">{fmt.money(x.cost)}</span> },
                ]}
              />
            </Panel>
          </div>
        );
      }}
    </Async>
  );
}

/** Archive and unarchive a project (project.archive), typed confirmation. */
export function ArchivePanel({ p }: { p: PcProps["p"] }) {
  const ui = useUI();
  const res = useRes();
  const imp = useKillImpact("project", p.id).data ?? { workOrders: 0, running: 0, slots: 0, prs: 0 };
  const ad = useCan("project.archive", { project: p.id });
  const archived = p.status === "archived";
  return (
      <section className="panel pcf-dz" id="pcf-archive-panel" aria-label="Archive project">
        <div className="panel-head"><h2 className="panel-title">{archived ? "Archived" : "Archive this project"}</h2></div>
        <div className="panel-body form-grid">
          <p>{archived ? `${p.name} is archived. It is read-only, hidden from people without a factory role, and refuses new work.` : `Archiving makes ${p.name} read-only, hides it from project members and refuses new work orders. In-flight work stops. You must type the project name to confirm.`}</p>
          <LockNote decision={ad} what="Archiving" />
          {archived ? (
            <div className="form-actions"><Btn kind="primary" icon="undo" id="pcf-unarchive" guard={ad} label={`Unarchive ${p.name}`} onClick={async () => res(await ops.unarchiveProject(p.id, { ifMatch: p.version }))} /></div>
          ) : (
            <div className="form-actions">
              <Btn kind="danger" icon="lock" id="pcf-archive" guard={ad} label={`Archive ${p.name}`}
                onClick={() => ui.typedConfirm({
                  title: `Archive ${p.name}`, kicker: "Danger zone", sub: `This stops ${imp.workOrders} work orders and hides the project from its members.`, phrase: p.name, okLabel: "Archive project", guard: ad,
                  onOk: async (text) => { const r = await ops.archiveProject(p.id, text, { ifMatch: p.version }); if (r.ok) ui.toast(r.msg, "warn"); return r.ok ? undefined : { ok: false, msg: r.msg }; },
                })} />
            </div>
          )}
        </div>
      </section>
  );
}
