import { DAYS, fmt, istTime, istToday, type Person, type Project, type Role, type Repo, type SimulationResult, type Action } from "@gantry/domain";
import { Btn, Field, Select } from "../../ui/primitives";
import { Card } from "../../ui/cr";
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
const nextDow = (dow: number) => {
  const today = new Date(Date.now() + 330 * 60000).getUTCDay();
  return istToday(Date.now(), (dow - today + 7) % 7 || 7);
};
export const simTime = (s: Sim) => istTime(s.date, s.time);

/** The legacy example questions. They name seeded people and projects, so only the ones that exist in this org are offered. */
export function presets(people: Person[], projects: Project[], repos: Repo[]): Array<{ label: string; s: () => Sim }> {
  const n = () => nowIst();
  const all: Array<{ label: string; need: string[]; s: () => Sim }> = [
    { label: "Kenji releases Payments on Friday 22:00", need: ["p-kenji", "payments", "payments-api"], s: () => ({ person: "p-kenji", action: "release", project: "payments", repo: "payments-api", date: nextDow(5), time: "22:00" }) },
    { label: "Kenji releases Payments on Wednesday 11:00", need: ["p-kenji", "payments", "payments-api"], s: () => ({ person: "p-kenji", action: "release", project: "payments", repo: "payments-api", date: nextDow(3), time: "11:00" }) },
    { label: "Release payouts-worker during a freeze", need: ["p-kenji", "payments", "payouts-worker"], s: () => ({ person: "p-kenji", action: "release", project: "payments", repo: "payouts-worker", date: istToday(Date.now(), 1), time: "11:00" }) },
    { label: "Priya kills Risk at 02:00", need: ["p-priya", "risk"], s: () => ({ person: "p-priya", action: "kill.project", project: "risk", repo: "", date: istToday(Date.now(), 1), time: "02:00" }) },
    { label: "Lena releases Identity on Sunday 03:00", need: ["p-lena", "identity"], s: () => ({ person: "p-lena", action: "release", project: "identity", repo: "", date: nextDow(0), time: "03:00" }) },
    { label: "Tomás approves a gate in Storefront", need: ["p-tomas", "storefront"], s: () => ({ person: "p-tomas", action: "gate.approve", project: "storefront", repo: "", date: n().date, time: n().time }) },
  ];
  const have = new Set([...people.map((p) => p.id), ...projects.map((p) => p.id), ...repos.map((r) => r.id)]);
  return all.filter((p) => p.need.every((x) => have.has(x)));
}

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

export function Simulator({ roles, people, projects, repos, actions, sim, setSim, evaluated, onEvaluate, onShowRule, presetsList }: {
  roles: Role[]; people: Person[]; projects: Project[]; repos: Repo[]; actions: Action[]; sim: Sim; setSim: (s: Sim) => void; evaluated: Evaluated | null;
  onEvaluate: (s: Sim) => void; onShowRule: (tab: string) => void; presetsList: Array<{ label: string; s: () => Sim }>;
}) {
  const actors = useActors();
  const act = actions.find((a) => a.id === sim.action);
  const scoped = !act || act.scope === "project";
  const set = (k: keyof Sim) => (v: string) => setSim({ ...sim, [k]: v, ...(k === "project" ? { repo: "" } : {}) });
  const r = evaluated;
  const rd = r?.result.decision;
  const ract = r ? actions.find((a) => a.id === r.sim.action) : undefined;
  const rule = rd?.rule as { freeze?: string } | undefined;
  return (
    <Card title="Check access" id="acc-check-card">
      <form
        className="grid g3 sim-form acc-sim-form"
        id="acc-sim-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onEvaluate(sim);
        }}
      >
        <Field label="Person" htmlFor="acc-sim-person"><Select id="acc-sim-person" value={sim.person} onChange={set("person")} options={people.map((p) => ({ value: p.id, label: p.name + (p.status === "invited" ? " (invited)" : "") }))} /></Field>
        <Field label="Permission" htmlFor="acc-sim-action"><Select id="acc-sim-action" value={sim.action} onChange={set("action")} options={actions.map((a) => ({ value: a.id, label: a.name }))} /></Field>
        <div className="field"><span className="lbl">&nbsp;</span><Btn label="Check" kind="primary" type="submit" id="acc-sim-run" /></div>
        <details className="acc-adv" style={{ gridColumn: "1 / -1" }}>
          <summary>Advanced: project, repo and time</summary>
          <div className="grid g3" style={{ marginTop: 12 }}>
            <Field label="Project" htmlFor="acc-sim-project"><Select id="acc-sim-project" value={sim.project} onChange={set("project")} disabled={!scoped} title={scoped ? undefined : "Factory actions apply everywhere"} options={projects.map((p) => ({ value: p.id, label: p.name }))} /></Field>
            <Field label="Repo" htmlFor="acc-sim-repo"><Select id="acc-sim-repo" value={sim.repo} onChange={set("repo")} disabled={!scoped} options={[{ value: "", label: "Any repo" }, ...repos.filter((x) => x.project === sim.project).map((x) => ({ value: x.id, label: x.name }))]} /></Field>
            <div className="field"><span className="lbl">&nbsp;</span><Btn label="Use now" id="acc-sim-now" onClick={() => setSim({ ...sim, ...nowIst() })} /></div>
            <Field label="Date (IST)" htmlFor="acc-sim-date"><input id="acc-sim-date" className="input mono" type="date" value={sim.date} onChange={(e) => setSim({ ...sim, date: e.target.value })} /></Field>
            <Field label="Time (IST)" htmlFor="acc-sim-time"><input id="acc-sim-time" className="input mono" type="time" value={sim.time} onChange={(e) => setSim({ ...sim, time: e.target.value })} /></Field>
          </div>
          {presetsList.length ? (
            <div className="chips acc-presets" style={{ marginTop: 12 }}>
              <span className="kicker">Try</span>
              {presetsList.map((pr, i) => (
                <button key={pr.label} type="button" className="sugg" id={`acc-preset-${i}`} onClick={() => { const s = pr.s(); setSim(s); onEvaluate(s); }}>{pr.label}</button>
              ))}
            </div>
          ) : null}
        </details>
      </form>
      <div id="acc-sim-out" style={{ marginTop: 16 }} role="status">
        {r && rd && ract ? (
          <div className="acc-out">
            <div className={`banner ${rd.allowed ? "ok" : "bad"}`} id="acc-sim-result">
              <Icon name={rd.allowed ? "check" : "lock"} />
              <div className="grow">
                <b>{rd.allowed ? "Allowed." : "Denied."}</b>{" "}
                {(() => {
                  const who = people.find((x) => x.id === r.sim.person);
                  const held = (who?.roles ?? []).filter((g) => g.scope === "factory" || ract.scope === "factory" || g.scope === r.sim.project).map((g) => roles.find((x) => x.id === g.role)?.name ?? g.role);
                  const names = [...new Set(held)].join(", ");
                  const byMatrix = rd.rule.kind === "matrix";
                  return (
                    <>
                      {actors(r.sim.person).name}{names ? ` holds ${names}, which ${rd.allowed ? "includes" : "does not include"} ` : " holds no role here. "}
                      {names ? <><span className="mono">{r.sim.action}</span>.</> : null}
                      {byMatrix && names ? null : ` ${rd.reason}`}
                    </>
                  );
                })()}
                {rd.needs && !rd.allowed ? <span>{` To allow it: ${rd.needs}.`}</span> : null}
              </div>
            </div>
            <div className="decision-rule" style={{ marginTop: 10 }}>
              <span className="kicker">Deciding rule </span>
              <span className="mono strong">{rule?.freeze ? `${rd.rule.id} + ${rule.freeze}` : rd.rule.id}</span>{" "}
              <span>{rd.rule.name}</span>{" "}
              <button type="button" className="linkish" id="acc-sim-show" onClick={() => onShowRule(rule?.freeze ? "freezes" : rd.rule.kind === "policy" ? "policies" : "matrix")}>Show rule</button>
              {!rd.allowed ? <ExplainDenial id="acc-sim-explain" person={r.sim.person} action={r.sim.action} project={ract.scope === "project" ? r.sim.project : null} repo={ract.scope === "project" ? r.sim.repo || null : null} time={r.t} /> : null}
            </div>
            <details className="acc-why" open style={{ marginTop: 10 }}>
              <summary>How the engine got there</summary>
              <Trace lines={r.result.trace} />
            </details>
            <div className="acc-wk-h"><span className="sub-h">Same question, every hour of the next 7 days</span></div>
            <WeekStrip r={r} />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
