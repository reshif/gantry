/** Project config: Notifications, MCP, Budget, History and Danger zone tabs (legacy project-config.js). */
import { useState } from "react";
import { fmt, type WorkOrder } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useDeliveries, useKillImpact, useMcpServers, useMe, useWorkOrders } from "../../api/queries";
import { canSeeRoute } from "../../lib/routes";
import { navigate } from "../../lib/router";
import { makeStopActions } from "../../shell/stopActions";
import { useOpenTraveler } from "../../shell/useTraveler";
import { Btn, Empty, Field, LockNote, Meter, Panel, Select, Toggle } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { NumInput, evName, flowOf, useRes } from "../projects/kit";
import { HistoryList } from "./history";
import type { PcProps } from "./ctx";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function NotificationsTab({ p }: PcProps) {
  const res = useRes();
  const me = useMe();
  const d = useCan("notify.edit", { project: p.id });
  const dl = useDeliveries({ project: p.id, limit: 6 }).data;
  const deliveries = (Array.isArray(dl) ? dl : ((dl as { items?: typeof dl } | undefined)?.items ?? [])) as Array<{ id: string; at: number; event: string; channel: string; target: string; status: string }>;
  const routes = p.notifications;
  return (
    <div className="pcf-stack">
      <LockNote decision={d} what="Notification routes" />
      <Panel title="Routes" flush tools={canSeeRoute("notifications", me) ? <Btn small kind="ghost" id="pcf-to-notify" label="Edit routes and cards" onClick={() => navigate("notifications")} /> : null}>
        <div className="table-scroll">
          <table className="table table-compact">
            <thead><tr><th>Event</th><th>Destinations</th><th>Conditions</th><th>On</th></tr></thead>
            <tbody>
              {routes.map((rt, i) => {
                const c = rt.cond;
                const lockKill = (rt.event === "kill" || rt.event === "restore") && rt.enabled;
                return (
                  <tr key={rt.id}>
                    <td>{evName(rt.event)}<div className="mono small muted">{rt.id}</div></td>
                    <td className="small">{rt.dest.map((x, j) => <div key={j} className="mono">{`${x.channel} ${x.target}`}</div>)}</td>
                    <td className="small">{[c.classes.length ? c.classes.join(", ") : "any class", c.priority.length ? c.priority.join(", ") : "any priority", c.hours === "business" ? "business hours" : "any time"].join(" · ")}</td>
                    <td>
                      <Toggle id={`pcf-nr-${rt.id}`} checked={rt.enabled} label={`${evName(rt.event)} route on`} decision={lockKill && d.allowed ? { allowed: false, reason: "Kill and restore notices must stay on.", needs: "" } : d}
                        onChange={async (v) => { const arr = clone(routes); arr[i]!.enabled = v; res(await ops.setProject(p.id, "notifications", arr), `${evName(rt.event)} route ${v ? "on." : "off."}`); }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Recent deliveries">
        {deliveries.length ? (
          <ul className="plain-list small">
            {deliveries.map((x) => (
              <li key={x.id} className="pcf-dl">
                <span className="mono muted">{fmt.ist(x.at)}</span>
                <span>{evName(x.event)}</span>
                <span className="mono">{`${x.channel} ${x.target}`}</span>
                <span className={`outcome o-${x.status === "delivered" ? "ok" : "failed"}`}>{x.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No deliveries yet" text="Deliveries for this project appear here." />
        )}
      </Panel>
    </div>
  );
}

export function McpTab({ p }: PcProps) {
  const res = useRes();
  const me = useMe();
  const d = useCan("project.config", { project: p.id });
  const servers = useMcpServers().data ?? [];
  return (
    <div className="pcf-stack">
      <LockNote decision={d} what="MCP servers for this project" />
      <Panel title={`MCP servers available to ${p.name}`} flush tools={canSeeRoute("mcp", me) ? <Btn small kind="ghost" id="pcf-to-mcp" label="Manage servers" onClick={() => navigate("mcp")} /> : null}>
        <div className="table-scroll">
          <table className="table table-compact">
            <thead><tr><th>Server</th><th>Health</th><th>Sensitivity</th><th className="num">Tools</th><th>Factory scope</th><th>Enabled here</th></tr></thead>
            <tbody>
              {servers.map((s) => {
                const on = p.mcp.includes(s.id);
                const scopeOk = s.projects === "all" || s.projects.includes(p.id);
                const dec = d.allowed && !scopeOk && !on ? { allowed: false, reason: `${s.name} is not scoped to ${p.name}. Change its scope in MCP servers first.`, needs: "" } : d;
                return (
                  <tr key={s.id}>
                    <th scope="row">{s.name}<div className="mono small muted">{s.url}</div></th>
                    <td><span className={`pcf-health pcf-h-${s.health}`}><Icon name={s.health === "healthy" ? "st-done" : "alert"} />{s.health}</span></td>
                    <td className="small">{s.sensitivity}</td>
                    <td className="num mono">{`${s.tools.length} (${s.tools.filter((t) => t.write).length} write)`}</td>
                    <td className="small">{s.projects === "all" ? "all projects" : `${s.projects.length} projects`}</td>
                    <td><Toggle id={`pcf-mcp-${s.id}`} checked={on} label={`${s.name} enabled for ${p.name}`} decision={dec} onChange={async (v) => res(await ops.setProject(p.id, "mcp", v ? [...p.mcp, s.id] : p.mcp.filter((x) => x !== s.id)), `${s.name}${v ? " enabled for " : " disabled for "}${p.name}.`)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

export function BudgetTab({ p, cat }: PcProps) {
  const res = useRes();
  const d = useCan("project.config", { project: p.id });
  const openTraveler = useOpenTraveler();
  const raw = useWorkOrders(p.id, { limit: 200 }).data;
  const wos = (Array.isArray(raw) ? raw : ((raw as { items?: WorkOrder[] } | undefined)?.items ?? [])) as WorkOrder[];
  const b = p.budget;
  const [now] = useState(() => Date.now());
  void now;
  const stations = flowOf(cat, p).stations;
  const byStation = stations.map((s) => ({ s, v: wos.reduce((a, w) => a + (w.history ?? []).filter((e) => e.station === s.id).reduce((x, e) => x + (e.cost || 0), 0), 0) }));
  const max = Math.max(1, ...byStation.map((x) => x.v));
  const top = wos.map((w) => ({ w, cost: (w.history ?? []).reduce((a, e) => a + (e.cost || 0), 0) })).sort((a, c) => c.cost - a.cost).slice(0, 5);
  const ratio = b.monthly ? b.mtd / b.monthly : 0;
  return (
    <div className="two-col">
      <Panel title="Monthly budget">
        <div className="form-grid">
          <LockNote decision={d} what="Budget" />
          <div className="pcf-bud-big"><span className="big-num">{fmt.money0(b.mtd)}</span><span className="muted">{` of ${fmt.money0(b.monthly)} this month · ${fmt.pct(ratio)}`}</span></div>
          <Meter value={b.mtd} max={b.monthly} label="Budget used" warnAt={b.alertAt} />
          {ratio >= b.alertAt && b.monthly ? <div className="callout callout-warn small"><Icon name="alert" /><span>Past the alert line. Project admins are emailed by the budget route.</span></div> : null}
          <div className="form-row">
            <Field label="Monthly budget (USD)" htmlFor="pcf-bud-monthly"><NumInput id="pcf-bud-monthly" value={b.monthly} min={100} max={100000} locked={!d.allowed} label="Monthly budget" onCommit={async (v) => res(await ops.setProject(p.id, "budget.monthly", v), `Monthly budget set to ${fmt.money0(v)}.`)} /></Field>
            <Field label="Alert at" htmlFor="pcf-bud-alert"><Select id="pcf-bud-alert" disabled={!d.allowed} options={[0.5, 0.7, 0.8, 0.9, 1].map((x) => ({ value: String(x), label: fmt.pct(x) }))} value={String(b.alertAt)} onChange={async (v) => res(await ops.setProject(p.id, "budget.alertAt", parseFloat(v)), `Budget alert at ${fmt.pct(parseFloat(v))}.`)} /></Field>
          </div>
        </div>
      </Panel>
      <div className="pcf-stack">
        <Panel title="Agent spend by station (work orders on record)">
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
          </ul>
        </Panel>
        <Panel title="Most expensive work orders" flush>
          <table className="table table-compact">
            <tbody>
              {top.map((x) => (
                <tr key={x.w.id}>
                  <td><button type="button" className="linkish mono" id={`pcf-bud-wo-${x.w.id}`} onClick={() => openTraveler(x.w.id)}>{x.w.id}</button></td>
                  <td className="small">{x.w.title}</td>
                  <td className="num mono">{fmt.money(x.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}

export function HistoryTab({ p }: PcProps) {
  return (
    <Panel title={`History for ${p.name}`}>
      <HistoryList type="project" id={p.id} project={p.id} limit={80} />
    </Panel>
  );
}

export function DangerTab({ p }: PcProps) {
  const ui = useUI();
  const res = useRes();
  const me = useMe();
  const actor = useActors();
  const imp = useKillImpact("project", p.id).data ?? { workOrders: 0, running: 0, slots: 0, prs: 0 };
  const kd = useCan("kill.project", { project: p.id });
  const rd = useCan("restore.project", { project: p.id });
  const ad = useCan("project.archive", { project: p.id });
  const archived = p.status === "archived";
  const factoryKilled = !!me?.factory.killed;
  const stop = me ? makeStopActions(ui, me) : null;
  const k = p.killed;
  return (
    <div className="pcf-stack pcf-danger">
      <section className={`panel pcf-dz${k ? " is-killed" : ""}`} aria-label="Project kill switch">
        <div className="panel-head"><h2 className="panel-title">{k ? "Project killed" : "Kill this project"}</h2><span className="mono small muted">kill.project · restore.project</span></div>
        <div className="panel-body form-grid">
          {k ? (
            <div className="pcf-kill-state"><Icon name="st-kill" /><div><strong>KILLED</strong>{` by ${actor(k.by).name}, ${fmt.stamp(k.at)}. ${k.reason} · work ${k.mode === "cancel" ? "cancelled" : "held in place"}`}</div></div>
          ) : (
            <p>{`A hard stop for ${p.name}: ${imp.workOrders} work orders, ${imp.running} running agents, ${imp.slots} coding slots and ${imp.prs} open PRs. New submissions are refused until someone restores it. For a soft pause, pull the andon cord on the floor.`}</p>
          )}
          {factoryKilled ? <div className="callout callout-block small"><Icon name="st-kill" /><span>The whole factory is killed. Restore it from the admin home.</span></div> : null}
          <LockNote decision={k ? rd : kd} what={k ? "Restoring this project" : "This kill switch"} />
          <div className="form-actions">
            {k ? (
              <Btn kind="primary" icon="power" id="pcf-restore" guard={rd} label={`Restore ${p.name}`} onClick={() => stop?.restore("project", p.id)} />
            ) : (
              <Btn kind="danger" icon="st-kill" id="pcf-kill" guard={archived ? { allowed: false, reason: `${p.name} is archived.`, needs: "" } : kd} label={`Kill ${p.name}`} onClick={() => stop?.kill("project", p.id)} />
            )}
          </div>
        </div>
      </section>
      <section className="panel pcf-dz" aria-label="Archive project">
        <div className="panel-head"><h2 className="panel-title">{archived ? "Archived" : "Archive this project"}</h2><span className="mono small muted">project.archive</span></div>
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
    </div>
  );
}
