/** Settings and Per-project tabs: identity (name), autonomy, staffing and the promotion gate, then per-project overrides. Model, budget, tools and guardrails have their own tabs (proto.tsx). */
import type { ReactNode } from "react";
import { fmt, type Policy, type Project } from "@gantry/domain";
import { Field, Select, type Decision } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useAgentSuites } from "../../api/queries";
import { AUTONOMY, autonomyCheck, useModels, useStations, type AgentRow, type Draft } from "./kit";

export interface TabProps {
  a: AgentRow;
  d: Draft;
  ro: boolean;
  perm: Decision;
  projects: Project[];
  policies: Policy[];
  /** Mutates the draft, then redraws. */
  edit: (fn: () => void) => void;
}

const Sec = ({ title, children, hint, cls }: { title: string; children: ReactNode; hint?: ReactNode; cls?: string }) => (
  <section className={`cfg-sec${cls ? ` ${cls}` : ""}`}>
    <h3 className="cfg-h">{title}</h3>
    {hint ? <p className="muted small">{hint}</p> : null}
    {children}
  </section>
);

export function ConfigTab({ a, d, ro, perm, projects, policies, edit }: TabProps) {
  const st = useStations();
  const suites = useAgentSuites().data ?? [];
  const arr = <T,>(x: T[] | undefined): T[] => x ?? [];
  const live = projects.filter((p) => p.status !== "archived");
  const check = (autonomy: string) => autonomyCheck(policies, projects, { station: a.station, projects: d.projects }, autonomy);

  const allProj = d.projects === "all";
  return (
    <div className="cfg">
      <Sec title="Identity">
        <div className="form-grid">
          <Field label="Name" htmlFor="ag-name"><input id="ag-name" className="input" value={d.name} disabled={ro} onChange={(e) => edit(() => { d.name = e.target.value; })} /></Field>
          <dl className="kv-row ag-ident">
            <div className="kv"><dt className="kv-k">Id</dt><dd className="kv-v mono">{a.id}</dd></div>
            <div className="kv"><dt className="kv-k">Home station</dt><dd className="kv-v">{st.label(a.station, projects)}</dd></div>
            <div className="kv"><dt className="kv-k">Live version</dt><dd className="kv-v mono">{a.version}</dd></div>
          </dl>
        </div>
      </Sec>
      <Sec title="Autonomy" hint="POL-112 limits agents from Plan onward on regulated projects to act with gate.">
        <div className="radio-cards" role="radiogroup" aria-label="Autonomy level">
          {AUTONOMY.map((o) => {
            const chk = check(o[0]);
            const dis = ro || !chk.allowed;
            return (
              <label key={o[0]} className={`radio-card${d.autonomy === o[0] ? " is-on" : ""}${dis ? " is-locked" : ""}`} htmlFor={`ag-aut-${o[0]}`} data-reason={!chk.allowed ? chk.reason : ro ? perm.reason : undefined}>
                <input type="radio" name="ag-autonomy" id={`ag-aut-${o[0]}`} value={o[0]} checked={d.autonomy === o[0]} disabled={dis} onChange={() => edit(() => { d.autonomy = o[0] as Draft["autonomy"]; })} />
                <span className="rc-t">{o[1]}</span>
                <span className="rc-d muted small">{o[2]}</span>
                {!chk.allowed ? <span className="rc-why small neg"><Icon name="lock" /> Blocked by {chk.rule}</span> : null}
              </label>
            );
          })}
        </div>
      </Sec>
      <Sec title="Staffing">
        <div className="form-grid">
          <div className="field">
            <div className="field-label">Stations it may staff</div>
            <div className="check-grid">
              {st.all.map((s) => (
                <label key={s.id} className="check" htmlFor={`ag-st-${s.id}`}>
                  <input type="checkbox" id={`ag-st-${s.id}`} checked={d.stations.includes(s.id)} disabled={ro} onChange={(e) => edit(() => { d.stations = e.target.checked ? [...d.stations, s.id] : d.stations.filter((x) => x !== s.id); })} />
                  <span className="mono muted">{s.no}</span>{s.name}{s.custom ? <span className="tag">{projects.find((p) => p.id === s.project)?.name ?? s.project}</span> : null}
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <div className="field-label">Projects it may work on</div>
            <div>
              <label className="check" htmlFor="ag-proj-all">
                <input type="checkbox" id="ag-proj-all" checked={allProj} disabled={ro} onChange={(e) => edit(() => { d.projects = e.target.checked ? "all" : projects.map((p) => p.id); })} />
                All projects, including new ones
              </label>
              {allProj ? null : (
                <div className="check-grid">
                  {live.map((p) => (
                    <label key={p.id} className="check" htmlFor={`ag-proj-${p.id}`}>
                      <input type="checkbox" id={`ag-proj-${p.id}`} checked={arr(d.projects as string[]).includes(p.id)} disabled={ro} onChange={(e) => edit(() => { const cur = d.projects as string[]; d.projects = e.target.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id); })} />
                      {p.name}{p.regulated ? <span className="tag">regulated</span> : null}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </Sec>
      <Sec title="Promotion gate" cls="ag-wide">
        <Field label="Required eval suite" htmlFor="ag-suite" hint="A version reaches the floor only when its latest run of this suite meets the threshold.">
          <Select id="ag-suite" disabled={ro} value={d.suite} onChange={(v) => edit(() => { d.suite = v; })}
            options={(suites.some((x) => x.id === d.suite) || !d.suite ? suites : [...suites, { id: d.suite, name: "not found", station: null, agent: null, threshold: 0 }]).map((x) => ({ value: x.id, label: `${x.id} · ${x.name} (≥ ${fmt.pct(x.threshold)})` }))} />
        </Field>
      </Sec>
    </div>
  );
}

export function OverridesTab({ a, d, ro, projects, policies, edit }: TabProps) {
  const m = useModels();
  const models = m.list;
  const rows = projects.filter((p) => p.status !== "archived").map((p) => {
    const ov = d.overrides[p.id] ?? {};
    const staffs = d.projects === "all" || (d.projects as string[]).includes(p.id);
    const set = (k: string, v: string | number | "") => edit(() => {
      const o: Record<string, unknown> = { ...(d.overrides[p.id] ?? {}) };
      if (v === "" || v == null) delete o[k]; else o[k] = v;
      if (Object.keys(o).length) d.overrides[p.id] = o as never; else delete d.overrides[p.id];
    });
    const effAut = ov.autonomy ?? d.autonomy;
    const chkEff = autonomyCheck(policies, projects, { station: a.station, projects: d.projects }, effAut, p.id);
    return (
      <tr key={p.id} className={staffs ? "" : "ag-ov-off"}>
        <td><strong>{p.name}</strong>{p.regulated ? <span className="tag">regulated</span> : null}{staffs ? null : <div className="small muted">Not staffed by this agent</div>}</td>
        <td>
          <Select id={`ag-ov-model-${p.id}`} aria-label={`Model on ${p.name}`} disabled={ro || !staffs} value={ov.model ?? ""} onChange={(v) => set("model", v)}
            options={[{ value: "", label: `Inherit (${d.model})` }, ...models.map((x) => ({ value: x.id, label: x.name }))]} />
        </td>
        <td>
          <Select id={`ag-ov-aut-${p.id}`} aria-label={`Autonomy on ${p.name}`} disabled={ro || !staffs} value={ov.autonomy ?? ""} onChange={(v) => set("autonomy", v)}
            options={[{ value: "", label: `Inherit (${d.autonomy})` }, ...AUTONOMY.map((o) => { const c = autonomyCheck(policies, projects, { station: a.station, projects: d.projects }, o[0], p.id); return { value: o[0], label: o[1] + (c.allowed ? "" : " (blocked by POL-112)"), disabled: !c.allowed }; })]} />
        </td>
        <td>
          <input id={`ag-ov-budget-${p.id}`} className="input mono" type="number" min="0" step="0.5" aria-label={`Budget per work order on ${p.name}`} placeholder={`$${d.budget}`} disabled={ro || !staffs}
            value={ov.budget != null ? String(ov.budget) : ""} onChange={(e) => set("budget", e.target.value === "" ? "" : +e.target.value)} />
        </td>
        <td className="small">
          {staffs ? (
            <span>
              <span className="mono">{ov.model ?? d.model}</span>{` · ${effAut} · $${ov.budget != null ? ov.budget : d.budget}`}
              {chkEff.allowed ? null : <div className="neg"><Icon name="lock" /> {chkEff.reason}</div>}
            </span>
          ) : "–"}
        </td>
      </tr>
    );
  });
  return (
    <div className="cfg">
      <section className="cfg-sec ag-wide">
        <h3 className="cfg-h">Per-project overrides</h3>
        <p className="muted small">Change the model, autonomy or budget on one project without a new agent. Overrides are part of the agent and save with it. Routing rules in Models still apply on top: a regulated repo is never sent to a vendor its rule forbids.</p>
        <div className="table-scroll">
          <table className="table table-compact ag-ov">
            <thead><tr>{["Project", "Model", "Autonomy", "Budget / WO", "Effective"].map((x) => <th key={x} scope="col">{x}</th>)}</tr></thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
