import { useState } from "react";
import { DAYS, fmt, istTime, type Person, type Project, type Repo, type SimulationResult, type Action } from "@gantry/domain";
import { ops } from "../../api/ops";
import { Btn, Field, Panel, Select } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { useQS } from "../govern/kit";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { ExplainDenial } from "../console/ExplainDenial";

export interface Sim {
  person: string;
  action: string;
  project: string;
  repo: string;
  date: string;
  time: string;
}
export interface Evaluated {
  sim: Sim;
  t: number;
  result: SimulationResult;
}

export const nowIst = () => {
  const d = new Date(Date.now() + 330 * 60000).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
};
export const simTime = (s: Sim) => istTime(s.date, s.time);

function Trace({ lines }: { lines: string[] }) {
  return (
    <ul className="checklist acc-trace">
      {lines.map((l, i) => {
        const [head, ...rest] = l.split(/:(.*)/s);
        const tail = (rest.join("") || "").trim();
        let kind = "pending";
        if (l.startsWith("Roles in scope")) kind = l.includes("none.") ? "bad" : "ok";
        else if (l.startsWith("Role matrix grants")) kind = l.includes(": no.") ? "bad" : "ok";
        else if (l.startsWith("Freeze on")) kind = l.includes(" until ") ? "bad" : "ok";
        else if (l.startsWith("Policies on this action")) kind = l.includes("none,") ? "ok" : "warn";
        else if (l.startsWith("To allow it") || l.startsWith("Roles that include")) kind = "warn";
        return (
          <li key={i} className={kind}>
            <Icon name={kind === "ok" ? "check" : kind === "bad" ? "x" : kind === "warn" ? "alert" : "dots"} />
            <span className="strong">{tail ? head : l}</span>
            {tail ? <span className="muted">{tail}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

function WeekStrip({ r }: { r: Evaluated }) {
  return (
    <div className="wk" role="img" aria-label="When this is allowed over the next seven days, hour by hour">
      <div className="wk-row wk-axis">
        <span className="wk-d" />
        <span className="wk-cells mono">
          {[0, 6, 12, 18].map((x) => <span key={x} className="wk-tick" style={{ gridColumn: `${x + 1} / span 6` }}>{String(x).padStart(2, "0")}</span>)}
        </span>
      </div>
      {r.result.week.map((row) => (
        <div key={row.day0} className="wk-row">
          <span className="wk-d mono">{fmt.istDate(row.day0 + 6 * 3600000)}</span>
          <span className="wk-cells">
            {row.cells.map((c) => (
              <span key={c.hour} className={`wk-c ${c.allowed ? "is-yes" : "is-no"}${c.selected ? " is-sel" : ""}`} title={`${DAYS[row.dow]} ${String(c.hour).padStart(2, "0")}:00 · ${c.allowed ? "Allowed" : "Denied"} · ${c.rule}`} />
            ))}
          </span>
        </div>
      ))}
      <div className="wk-legend small muted">
        <span className="wk-c is-yes" /> allowed <span className="wk-c is-no" /> denied <span className="wk-c is-sel is-no" /> the time you picked
      </div>
    </div>
  );
}

export function Simulator({ people, projects, repos, actions, defaults }: { people: Person[]; projects: Project[]; repos: Repo[]; actions: Action[]; defaults: Sim }) {
  const ui = useUI();
  const actors = useActors();
  const [person, setPerson] = useQS("acc.person", defaults.person);
  const [action, setAction] = useQS("acc.action", defaults.action);
  const [project, setProject] = useQS("acc.project", defaults.project);
  const [extra, setExtra] = useState({ repo: "", date: defaults.date, time: defaults.time });
  const [r, setR] = useState<Evaluated | null>(null);
  const sim: Sim = { person, action, project, ...extra };
  const act = actions.find((a) => a.id === action);
  const scoped = !act || act.scope === "project";

  const check = async () => {
    const t = simTime(sim);
    const res = await ops.simulateAccess({ person, action, ...(scoped ? { project, ...(sim.repo ? { repo: sim.repo } : {}) } : {}), time: t });
    if (!res.ok) return void ui.toast(res.msg, "error");
    setR({ sim, t, result: res as unknown as SimulationResult });
  };

  const rd = r?.result.decision;
  const ract = r ? actions.find((a) => a.id === r.sim.action) : undefined;
  const rp = r ? projects.find((p) => p.id === r.sim.project) : undefined;
  const rule = rd?.rule as { freeze?: string } | undefined;
  return (
    <Panel title="Can this person do this?">
      <form id="acc-sim-form" onSubmit={(e) => { e.preventDefault(); void check(); }}>
        <div className="cols w3">
          <Field label="Person" htmlFor="acc-sim-person"><Select id="acc-sim-person" value={person} onChange={setPerson} options={people.map((p) => ({ value: p.id, label: p.name + (p.status === "invited" ? " (invited)" : "") }))} /></Field>
          <Field label="Action" htmlFor="acc-sim-action"><Select id="acc-sim-action" value={action} onChange={setAction} options={actions.map((a) => ({ value: a.id, label: a.name }))} /></Field>
          <Field label="Project" htmlFor="acc-sim-project"><Select id="acc-sim-project" value={project} onChange={(v) => { setProject(v); setExtra({ ...extra, repo: "" }); }} disabled={!scoped} title={scoped ? undefined : "Factory actions apply everywhere"} options={projects.map((p) => ({ value: p.id, label: p.name }))} /></Field>
        </div>
        <details className="acc-adv" style={{ margin: "8px 0" }}>
          <summary>Repo, date and time</summary>
          <div className="cols w3">
            <Field label="Repo" htmlFor="acc-sim-repo"><Select id="acc-sim-repo" value={extra.repo} onChange={(v) => setExtra({ ...extra, repo: v })} disabled={!scoped} options={[{ value: "", label: "Any repo" }, ...repos.filter((x) => x.project === project).map((x) => ({ value: x.id, label: x.name }))]} /></Field>
            <Field label="Date (IST)" htmlFor="acc-sim-date"><input id="acc-sim-date" className="input mono" type="date" value={extra.date} onChange={(e) => setExtra({ ...extra, date: e.target.value })} /></Field>
            <Field label="Time (IST)" htmlFor="acc-sim-time"><input id="acc-sim-time" className="input mono" type="time" value={extra.time} onChange={(e) => setExtra({ ...extra, time: e.target.value })} /></Field>
          </div>
          <Btn label="Use now" small id="acc-sim-now" onClick={() => setExtra({ ...extra, ...nowIst() })} />
        </details>
        <Btn label="Check" kind="primary" type="submit" id="acc-sim-run" />
      </form>
      <div style={{ marginTop: 12 }} aria-live="polite">
        {r && rd && ract ? (
          <div id="acc-sim-result">
            <div className={`callout ${rd.allowed ? "ok" : "bad"}`}>
              <b>{rd.allowed ? "Allowed" : "Denied"}</b>
              {`${actors(r.sim.person).name} \u00b7 ${ract.name.toLowerCase()}${ract.scope === "project" ? ` \u00b7 ${rp?.name ?? r.sim.project}` : " \u00b7 factory-wide"} \u00b7 ${fmt.stamp(r.t)}. ${rd.reason}`}
              {rd.needs && !rd.allowed ? ` To allow it: ${rd.needs}.` : ""}
            </div>
            <div className="small muted" style={{ marginTop: 8 }}>{`Deciding rule ${rule?.freeze ? `${rd.rule.id} + ${rule.freeze}` : rd.rule.id}${rd.rule.name ? `: ${rd.rule.name}` : ""}`}</div>
            {!rd.allowed ? <ExplainDenial id="acc-sim-explain" person={r.sim.person} action={r.sim.action} project={ract.scope === "project" ? r.sim.project : null} repo={ract.scope === "project" ? r.sim.repo || null : null} time={r.t} /> : null}
            <details className="acc-why">
              <summary>How the engine got there</summary>
              <Trace lines={r.result.trace} />
              <div className="acc-wk-h"><span className="sub-h">Same question, every hour of the next 7 days</span></div>
              <WeekStrip r={r} />
            </details>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
