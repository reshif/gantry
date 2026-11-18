/** Configuration and Per-project tabs (legacy configTab and overridesTab): identity, model chain, autonomy, tools, staffing, budget and guardrails, promotion gate, per-project overrides. */
import type { ReactNode } from "react";
import { fmt, type Policy, type Project } from "@gantry/domain";
import { Btn, Field, Select, Toggle, type Decision } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useAgentSuites } from "../../api/queries";
import { AUTONOMY, TOOLS, autonomyCheck, useModels, useStations, type AgentRow, type Draft } from "./kit";

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

export type CfgSection = "identity" | "model" | "autonomy" | "tools" | "staffing" | "budget" | "guardrails" | "gate";
const ALL: CfgSection[] = ["identity", "model", "autonomy", "tools", "staffing", "budget", "guardrails", "gate"];

/** The configuration form, one or more sections of it: the prototype spreads these over its Tools, Model and budget and Guardrails tabs. */
export function ConfigTab({ a, d, ro, perm, projects, policies, edit, show = ALL }: TabProps & { show?: CfgSection[] }) {
  const on = (k: CfgSection) => show.includes(k);
  const m = useModels();
  const st = useStations();
  const suites = useAgentSuites().data ?? [];
  const arr = <T,>(x: T[] | undefined): T[] => x ?? [];
  const live = projects.filter((p) => p.status !== "archived");
  const models = m.list;
  const check = (autonomy: string) => autonomyCheck(policies, projects, { station: a.station, projects: d.projects }, autonomy);
  const move = (list: string[], i: number, to: number) => edit(() => { const [x] = list.splice(i, 1); list.splice(to, 0, x as string); });

  const primaryOpts = models.map((x) => ({ value: x.id, label: `${x.name} · ${x.vendor}` })).concat(models.some((x) => x.id === d.model) ? [] : [{ value: d.model, label: `${m.name(d.model)} (not available)` }]);
  const addable = models.filter((x) => x.id !== d.model && !d.fallbacks.includes(x.id));
  const allProj = d.projects === "all";
  return (
    <div className="cfg">
      {on("identity") ? <Sec title="Identity">
        <div className="form-grid">
          <Field label="Name" htmlFor="ag-name"><input id="ag-name" className="input" value={d.name} disabled={ro} onChange={(e) => edit(() => { d.name = e.target.value; })} /></Field>
          <dl className="kv-row ag-ident">
            <div className="kv"><dt className="kv-k">Id</dt><dd className="kv-v mono">{a.id}</dd></div>
            <div className="kv"><dt className="kv-k">Home station</dt><dd className="kv-v">{st.label(a.station, projects)}</dd></div>
            <div className="kv"><dt className="kv-k">Live version</dt><dd className="kv-v mono">{a.version}</dd></div>
          </dl>
        </div>
      </Sec> : null}
      {on("model") ? <Sec title="Model chain">
        <div className="form-grid">
          <Field label="Primary model" htmlFor="ag-model" hint="Only enabled models on connected vendors are listed.">
            <Select id="ag-model" options={primaryOpts} value={d.model} disabled={ro} onChange={(v) => edit(() => { d.model = v; d.fallbacks = d.fallbacks.filter((x) => x !== v); })} />
          </Field>
          <div className="field">
            <div className="field-label">Fallbacks, tried in order</div>
            {d.fallbacks.length ? (
              <ol className="chain">
                {d.fallbacks.map((f, i) => (
                  <li key={f}>
                    <span className="mono chain-n">{i + 1}</span>
                    <span className="mono">{f}</span>
                    {m.usable(f) ? null : <span className="chip chip-warn"><Icon name="alert" />vendor or model off, skipped</span>}
                    <span className="chain-tools">
                      <Btn icon="up" small id={`ag-fb-up-${i}`} aria={`Move ${f} up`} disabledReason={ro ? perm.reason : i === 0 ? "Already first." : null} onClick={() => move(d.fallbacks, i, i - 1)} />
                      <Btn icon="down" small id={`ag-fb-down-${i}`} aria={`Move ${f} down`} disabledReason={ro ? perm.reason : i === d.fallbacks.length - 1 ? "Already last." : null} onClick={() => move(d.fallbacks, i, i + 1)} />
                      <Btn icon="x" small id={`ag-fb-rm-${i}`} aria={`Remove ${f}`} disabledReason={ro ? perm.reason : null} onClick={() => edit(() => { d.fallbacks.splice(i, 1); })} />
                    </span>
                  </li>
                ))}
              </ol>
            ) : <p className="muted small">No fallbacks. If the primary fails, the work order blocks.</p>}
            <Select id="ag-fb-add" aria-label="Add fallback model" disabled={ro || !addable.length} value="" options={[{ value: "", label: "Add fallback model…" }, ...addable.map((x) => ({ value: x.id, label: `${x.name} · ${x.vendor}` }))]} onChange={(v) => { if (v) edit(() => { d.fallbacks.push(v); }); }} />
          </div>
        </div>
      </Sec> : null}
      {on("autonomy") ? <Sec title="Autonomy" hint="POL-112 limits agents from Plan onward on regulated projects to act with gate.">
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
      </Sec> : null}
      {on("tools") ? <Sec title="Tool permissions">
        <div className="toggle-grid">
          {TOOLS.map((t) => (
            <div key={t[0]} className="toggle-row">
              <label htmlFor={`ag-tool-${t[0]}`}><span>{t[1]}</span><span className="muted small ag-tool-d">{t[2]}</span></label>
              <Toggle id={`ag-tool-${t[0]}`} checked={!!d.tools[t[0]]} decision={perm} onChange={(v) => edit(() => { d.tools[t[0]] = v; })} />
            </div>
          ))}
        </div>
      </Sec> : null}
      {on("staffing") ? <Sec title="Staffing">
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
      </Sec> : null}
      {on("budget") ? <Sec title="Budget">
        <div className="form-grid">
          <Field label="Budget per work order (USD)" htmlFor="ag-budget"><input id="ag-budget" className="input mono" type="number" min="0" step="0.1" value={String(d.budget)} disabled={ro} onChange={(e) => edit(() => { d.budget = +e.target.value || 0; })} /></Field>
        </div>
      </Sec> : null}
      {on("guardrails") ? <Sec title="Guardrails">
        <div className="form-grid">
          <Field label="Max diff size (lines)" htmlFor="ag-maxdiff" hint="0 means no limit."><input id="ag-maxdiff" className="input mono" type="number" min="0" step="50" value={String(d.guardrails.maxDiff)} disabled={ro} onChange={(e) => edit(() => { d.guardrails.maxDiff = +e.target.value || 0; })} /></Field>
          <Field label="Paths it must not touch" htmlFor="ag-paths" hint="One glob per line.">
            <textarea id="ag-paths" className="input mono" rows={3} disabled={ro} placeholder="infra/prod/**" value={d.guardrails.paths.join("\n")} onChange={(e) => edit(() => { d.guardrails.paths = e.target.value.split("\n").map((x) => x.trim()).filter(Boolean); })} />
          </Field>
        </div>
      </Sec> : null}
      {on("gate") ? <Sec title="Promotion gate" cls="ag-wide">
        <Field label="Required eval suite" htmlFor="ag-suite" hint="A version reaches the floor only when its latest run of this suite meets the threshold.">
          <Select id="ag-suite" disabled={ro} value={d.suite} onChange={(v) => edit(() => { d.suite = v; })}
            options={(suites.some((x) => x.id === d.suite) || !d.suite ? suites : [...suites, { id: d.suite, name: "not found", station: null, agent: null, threshold: 0 }]).map((x) => ({ value: x.id, label: `${x.id} · ${x.name} (≥ ${fmt.pct(x.threshold)})` }))} />
        </Field>
      </Sec> : null}
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
