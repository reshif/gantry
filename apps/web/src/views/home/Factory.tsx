import { fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import { useMe, useProjects } from "../../api/queries";
import { Btn, Meter, ViewHead } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { Spark } from "../../ui/charts";
import { getPrefs } from "../../lib/prefs";
import { hasCommand, runCommand } from "../../lib/commands";
import { navigate } from "../../lib/router";
import { Portfolio } from "../projects/portfolio";
import type { PView } from "../projects/kit";
import { ActivityPanel, AttentionPanel, OnboardingPanel, SpendPanel } from "./Panels";
import { ControlPanel } from "./Control";
import { HumanPanel } from "./Human";
import type { HomeFull } from "./data";
import { useActivity } from "../../api/queries";
import type { AuditRow } from "../audit/data";

function Stat({ k, v, sub, tone, id, children }: { k: string; v: string; sub?: React.ReactNode; tone?: string | null; id: string; children?: React.ReactNode }) {
  return (
    <div className={`stat hm-stat${tone ? ` tone-${tone}` : ""}`} id={id}>
      <div className="stat-k">{k}</div>
      <div className="stat-v">{v}</div>
      {children}
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

/** From Home to the New project wizard on the Projects screen, once that screen has mounted and registered it. */
export function openNewProject(): void {
  navigate("projects");
  let tries = 0;
  const t = setInterval(() => {
    tries += 1;
    if (hasCommand("newProject")) {
      clearInterval(t);
      runCommand("newProject");
    } else if (tries > 40) clearInterval(t);
  }, 50);
}

const layoutOf = (who: string): string => {
  const all = getPrefs().portfolio as Record<string, { ctx?: Record<string, { layout?: string }> }> | undefined;
  return all?.[who]?.ctx?.["hm-pf"]?.layout ?? "cards";
};

/** The factory overview for Factory Admins and the Auditor (legacy factoryView). */
export function FactoryView({ home, onMine }: { home: HomeFull; onMine: () => void }) {
  const me = useMe();
  const projects = ((useProjects().data ?? []) as PView[]).slice();
  const create = useCan("project.create");
  const activity = ((useActivity().data as unknown as { items?: AuditRow[] } | undefined)?.items ?? []).slice(0, 14);
  const f = home.figures;
  const control = home.control;
  if (!me || !f || !control || !home.human || !home.onboarding || !home.spend) return null;
  const items = home.attention ?? [];
  const crit = items.filter((x) => x.sev === 0);
  const killed = control.killed;
  const sentence = `${killed ? "Factory killed. " : "Factory running. "}${f.projects.active} projects, ${f.inFlight} work orders in flight, ${f.gatesWaiting} waiting on approvers${items.length ? `, ${items.length} item${items.length > 1 ? "s" : ""} need attention` : ""}.`;
  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? id;
  const isAdmin = me.person.roles.some((g) => g.role === "factory_admin");
  const stops = f.stops;
  return (
    <div className="view hm">
      <ViewHead
        kicker={`Factory${me.org?.plant ? ` · ${me.org.plant}` : ""}`} title={`${me.org?.name ?? "Gantry"} factory`} sub={sentence}
        meta={[["Signed in", me.person.name], ["Role", isAdmin ? "Factory Admin" : "Auditor (read-only)"], ["Projects", `${f.projects.active} active · ${f.projects.archived} archived`]]}
        actions={
          <>
            <Btn label="New project" kind="primary" icon="plus" id="hm-new-project" guard={create} onClick={openNewProject} />
            <Btn label="My work" kind="ghost" icon="user" id="hm-to-mine" onClick={onMine} />
          </>
        }
      />
      <div className="stats hm-kpis" role="group" aria-label="Factory KPIs">
        <Stat id="hm-kpi-flight" k="In flight" v={String(f.inFlight)} sub={`${f.running} running · ${f.inBays} in bays`} />
        <Stat id="hm-kpi-shipped" k="Shipped" v={`${f.shippedToday} / ${f.shippedWeek}`} sub="today / last 7 days" />
        <Stat id="hm-kpi-gates" k="Gates waiting" v={String(f.gatesWaiting)} tone={f.lateGates ? "wait" : null} sub={f.gatesWaiting ? `oldest ${fmt.dur(f.oldestWaitMs)}${f.lateGates ? ` · ${f.lateGates} past SLA` : ""}` : "none"} />
        <Stat id="hm-kpi-stops" k="Halted or killed" v={String(stops.length)} tone={stops.length ? "block" : null} sub={stops.length ? stops.slice(0, 2).join(", ") + (stops.length > 2 ? ` +${stops.length - 2}` : "") : f.killedWorkOrders ? `${f.killedWorkOrders} killed work orders` : "all running"} />
        <Stat id="hm-kpi-spend" k="Spend vs budget" v={fmt.pct(f.spent / (f.budget || 1))} sub={`${fmt.money0(f.spent)} of ${fmt.money0(f.budget)}`}>
          <Meter value={f.spent} max={f.budget} label="Factory spend this month" warnAt={0.8} />
        </Stat>
        <Stat id="hm-kpi-success" k="Agent success" v={f.agentSuccess === null ? "–" : fmt.pct(f.agentSuccess)} sub={f.agentSuccess === null ? "no scored runs yet" : "task success"}>
          {f.agentSuccessTrend.length > 1 ? <Spark values={f.agentSuccessTrend} w={96} h={20} label={`Agent success trend, latest ${fmt.pct(f.agentSuccess ?? 0)}`} /> : null}
        </Stat>
      </div>
      {crit.length ? (
        <div className="callout callout-block hm-crit" role="status">
          <Icon name="alert" />
          <span>{`${crit.length} critical: ${crit.map((x) => x.title).join(", ")}.`}</span>
        </div>
      ) : null}
      <div className={`hm-grid${layoutOf(me.person.id) === "rows" ? " hm-grid-wide" : ""}`}>
        <section className="hm-projects" aria-label="Projects">
          <div className="hm-sec-head">
            <h2 className="panel-title">Portfolio</h2>
            <a href="#projects" className="linkish small" id="hm-all-projects">All projects and templates</a>
          </div>
          <Portfolio ctx="hm-pf" projects={projects} defaultLayout="cards" />
          <p className="hm-legend small muted">
            <span className="hm-lg-seg" aria-hidden="true" />{"station, darker = more WIP  "}<span className="hm-lg-gate" aria-hidden="true" />{"gate waiting  "}<span className="hm-lg-x" aria-hidden="true" />{"blocked work. Select a belt to open its floor."}
          </p>
          <SpendPanel data={home.spend} />
        </section>
        <div className="hm-side">
          <ControlPanel control={control} />
          <HumanPanel human={home.human} />
          <AttentionPanel items={items} />
        </div>
      </div>
      <div className="hm-grid3">
        <ActivityPanel items={activity} projectName={projectName} />
        <OnboardingPanel data={home.onboarding} projectName={projectName} />
      </div>
    </div>
  );
}
