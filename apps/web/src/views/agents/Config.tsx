/** Configuration and Per-project tabs in the Blueprint layout: Identity (kv list) and Tools side by side, Guardrail paths below; editing happens in place and stays in the draft. */
import { useState, type ReactNode } from "react";
import { fmt, type Policy, type Project } from "@gantry/domain";
import { Btn, Chip, Field, Panel, Select, Toggle, type Decision } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/SortTable";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { Icon } from "../../ui/Icon";
import { useAgentSuites, useEvalsFactory } from "../../api/queries";
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
  /** Instructions tab: save the edited text and cut a candidate version from it. */
  saveAsVersion: () => void;
  /** Instructions tab: put the saved text back. */
  revert: () => void;
}

/** A value shown as plain text with a small Edit button that reveals its control. */
function InPlace({ id, label, text, ro, perm, children }: { id: string; label: string; text: ReactNode; ro: boolean; perm: Decision; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ag-inplace">
      <div className="row">
        <span>{text}</span>
        <Btn label={open ? "Done" : "Edit"} small kind="ghost" id={`${id}-edit`} aria={`${open ? "Close" : "Edit"} ${label}`} guard={ro ? perm : null} onClick={() => setOpen(!open)} />
      </div>
      {open && !ro ? <div className="ag-inplace-body">{children}</div> : null}
    </div>
  );
}

export function ConfigTab({ a, d, ro, perm, projects, policies, edit }: TabProps) {
  const m = useModels();
  const st = useStations();
  const suites = useAgentSuites().data ?? [];
  const arr = <T,>(x: T[] | undefined): T[] => x ?? [];
  const live = projects.filter((p) => p.status !== "archived");
  const models = m.list;
  const check = (autonomy: string) => autonomyCheck(policies, projects, { station: a.station, projects: d.projects }, autonomy);
  const move = (list: string[], i: number, to: number) => edit(() => { const [x] = list.splice(i, 1); list.splice(to, 0, x as string); });
  const modelOpts = models.map((x) => ({ value: x.id, label: x.name })).concat(models.some((x) => x.id === d.model) ? [] : [{ value: d.model, label: `${m.name(d.model)} (not available)` }]);
  const addable = models.filter((x) => x.id !== d.model && !d.fallbacks.includes(x.id));
  const autoValues = [...new Set([...AUTONOMY.map((o) => o[0]), d.autonomy])];
  const allProj = d.projects === "all";
  const station = st.find(a.station);
  const paths = d.guardrails.paths;
  const [editPaths, setEditPaths] = useState(false);
  return (
    <>
      <div className="cols">
        <Panel title="Identity">
          <dl className="kv">
            <dt>Station</dt><dd>{station?.name ?? "Roaming"}</dd>
            <dt>Model</dt>
            <dd><Select id="ag-model" aria-label="Model" disabled={ro} options={modelOpts} value={d.model} onChange={(v) => edit(() => { d.model = v; d.fallbacks = d.fallbacks.filter((x) => x !== v); })} /></dd>
            <dt>Fallbacks</dt>
            <dd>
              <InPlace id="ag-fb" label="fallbacks" ro={ro} perm={perm} text={d.fallbacks.length ? d.fallbacks.join(", ") : "None"}>
                {d.fallbacks.length ? (
                  <ol className="chain">
                    {d.fallbacks.map((f, i) => (
                      <li key={f}>
                        <span className="mono chain-n">{i + 1}</span>
                        <span className="mono">{f}</span>
                        {m.usable(f) ? null : <span className="chip chip-warn"><Icon name="alert" />vendor or model off, skipped</span>}
                        <span className="chain-tools">
                          <Btn icon="up" small id={`ag-fb-up-${i}`} aria={`Move ${f} up`} disabledReason={i === 0 ? "Already first." : null} onClick={() => move(d.fallbacks, i, i - 1)} />
                          <Btn icon="down" small id={`ag-fb-down-${i}`} aria={`Move ${f} down`} disabledReason={i === d.fallbacks.length - 1 ? "Already last." : null} onClick={() => move(d.fallbacks, i, i + 1)} />
                          <Btn icon="x" small id={`ag-fb-rm-${i}`} aria={`Remove ${f}`} onClick={() => edit(() => { d.fallbacks.splice(i, 1); })} />
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : null}
                <Select id="ag-fb-add" aria-label="Add fallback model" disabled={!addable.length} value="" options={[{ value: "", label: "Add fallback model…" }, ...addable.map((x) => ({ value: x.id, label: `${x.name} · ${x.vendor}` }))]} onChange={(v) => { if (v) edit(() => { d.fallbacks.push(v); }); }} />
              </InPlace>
            </dd>
            <dt>Autonomy</dt>
            <dd>
              <Select id="ag-autonomy" aria-label="Autonomy" disabled={ro} value={d.autonomy}
                options={autoValues.map((v) => { const c = check(v); return { value: v, label: c.allowed ? v : `${v} (blocked by ${c.rule})`, disabled: !c.allowed && v !== d.autonomy }; })}
                onChange={(v) => edit(() => { d.autonomy = v as Draft["autonomy"]; })} />
              {!check(d.autonomy).allowed ? <div className="small neg"><Icon name="lock" /> {check(d.autonomy).reason}</div> : null}
            </dd>
            <dt>Budget / run</dt>
            <dd>
              <InPlace id="ag-budget" label="budget per run" ro={ro} perm={perm} text={`$${d.budget}`}>
                <Field label="Budget per work order (USD)" htmlFor="ag-budget-in"><input id="ag-budget-in" className="input mono" type="number" min="0" step="0.1" value={String(d.budget)} onChange={(e) => edit(() => { d.budget = +e.target.value || 0; })} /></Field>
              </InPlace>
            </dd>
            <dt>Max diff</dt>
            <dd>
              <InPlace id="ag-maxdiff" label="max diff" ro={ro} perm={perm} text={d.guardrails.maxDiff ? `${d.guardrails.maxDiff} lines` : "No code changes"}>
                <Field label="Max diff size (lines)" htmlFor="ag-maxdiff-in" hint="0 means no code changes."><input id="ag-maxdiff-in" className="input mono" type="number" min="0" step="50" value={String(d.guardrails.maxDiff)} onChange={(e) => edit(() => { d.guardrails.maxDiff = +e.target.value || 0; })} /></Field>
              </InPlace>
            </dd>
            <dt>Eval suite</dt>
            <dd>
              <InPlace id="ag-suite" label="eval suite" ro={ro} perm={perm} text={d.suite || "—"}>
                <Select id="ag-suite-in" aria-label="Required eval suite" value={d.suite}
                  options={(suites.some((x) => x.id === d.suite) || !d.suite ? suites : [...suites, { id: d.suite, name: "not found", station: null, agent: null, threshold: 0 }]).map((x) => ({ value: x.id, label: `${x.id} · ${x.name} (≥ ${fmt.pct(x.threshold)})` }))}
                  onChange={(v) => edit(() => { d.suite = v; })} />
              </InPlace>
            </dd>
          </dl>
        </Panel>
        <Panel title="Tools">
          <div>
            {TOOLS.map((t) => (
              <label key={t[0]} className="check ag-tool-row" htmlFor={`ag-tool-${t[0]}`} style={{ justifyContent: "space-between", padding: "6px 0", borderBottom: "1px dotted var(--line)" }}>
                <span>{t[0]}</span>
                <Toggle id={`ag-tool-${t[0]}`} checked={!!d.tools[t[0]]} decision={perm} label={t[0]} onChange={(v) => edit(() => { d.tools[t[0]] = v; })} />
              </label>
            ))}
          </div>
        </Panel>
      </div>
      <Panel title="Guardrail paths" tools={<Btn label={editPaths ? "Done" : "Edit paths"} small kind="ghost" id="ag-paths-edit" guard={ro ? perm : null} onClick={() => setEditPaths(!editPaths)} />}>
        {paths.length ? <pre className="pre">{paths.join("\n")}</pre> : <div className="empty">No protected paths for this agent.</div>}
        {editPaths && !ro ? (
          <Field label="Paths it must not touch" htmlFor="ag-paths" hint="One glob per line.">
            <textarea id="ag-paths" className="input mono" rows={3} placeholder="infra/prod/**" value={paths.join("\n")} onChange={(e) => edit(() => { d.guardrails.paths = e.target.value.split("\n").map((x) => x.trim()).filter(Boolean); })} />
          </Field>
        ) : null}
      </Panel>
      <Panel title="Staffing">
        <div className="form-grid">
          <div className="field">
            <div className="field-label">Stations it may staff</div>
            <div className="check-grid">
              {st.all.map((s) => (
                <label key={s.id} className="check" htmlFor={`ag-st-${s.id}`}>
                  <input type="checkbox" id={`ag-st-${s.id}`} checked={d.stations.includes(s.id)} disabled={ro} onChange={(e) => edit(() => { d.stations = e.target.checked ? [...d.stations, s.id] : d.stations.filter((x) => x !== s.id); })} />
                  <span className="mono muted">{s.no}</span>{s.name}
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <div className="field-label">Projects it may work on</div>
            <label className="check" htmlFor="ag-proj-all">
              <input type="checkbox" id="ag-proj-all" checked={allProj} disabled={ro} onChange={(e) => edit(() => { d.projects = e.target.checked ? "all" : projects.map((p) => p.id); })} />
              All projects, including new ones
            </label>
            {allProj ? null : (
              <div className="check-grid">
                {live.map((p) => (
                  <label key={p.id} className="check" htmlFor={`ag-proj-${p.id}`}>
                    <input type="checkbox" id={`ag-proj-${p.id}`} checked={arr(d.projects as string[]).includes(p.id)} disabled={ro} onChange={(e) => edit(() => { const cur = d.projects as string[]; d.projects = e.target.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id); })} />
                    {p.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </Panel>
    </>
  );
}

type Ov = { model?: string; autonomy?: string; budget?: number };

function OverrideDialog({ a, d, p, policies, projects, edit, close }: { a: AgentRow; d: Draft; p: Project; policies: Policy[]; projects: Project[]; edit: (fn: () => void) => void; close: () => void }) {
  const m = useModels();
  const cur = (d.overrides[p.id] ?? {}) as Ov;
  const [model, setModel] = useState(cur.model ?? "");
  const [aut, setAut] = useState(cur.autonomy ?? "");
  const [budget, setBudget] = useState(cur.budget != null ? String(cur.budget) : "");
  const apply = (done: () => void) => {
    const o: Record<string, unknown> = {};
    if (model) o.model = model;
    if (aut) o.autonomy = aut;
    if (budget !== "") o.budget = +budget;
    edit(() => { if (Object.keys(o).length) d.overrides[p.id] = o as never; else delete d.overrides[p.id]; });
    done();
  };
  return (
    <Dialog title={`Override on ${p.name}`} kicker="Agent · per-project" onClose={close}
      sub="Change the model, autonomy or budget on one project without a new agent. Routing rules in Models still apply on top."
      body={(
        <div className="form-grid">
          <Field label="Model" htmlFor={`ag-ov-model-${p.id}`}><Select id={`ag-ov-model-${p.id}`} value={model} onChange={setModel} options={[{ value: "", label: `Inherit (${d.model})` }, ...m.list.map((x) => ({ value: x.id, label: x.name }))]} /></Field>
          <Field label="Autonomy" htmlFor={`ag-ov-aut-${p.id}`}><Select id={`ag-ov-aut-${p.id}`} value={aut} onChange={setAut} options={[{ value: "", label: `Inherit (${d.autonomy})` }, ...AUTONOMY.map((o) => { const c = autonomyCheck(policies, projects, { station: a.station, projects: d.projects }, o[0], p.id); return { value: o[0], label: o[1] + (c.allowed ? "" : " (blocked by POL-112)"), disabled: !c.allowed }; })]} /></Field>
          <Field label="Budget per work order (USD)" htmlFor={`ag-ov-budget-${p.id}`}><input id={`ag-ov-budget-${p.id}`} className="input mono" type="number" min="0" step="0.5" placeholder={`$${d.budget}`} value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
        </div>
      )}
      actions={[{ label: "Cancel" }, { label: "Apply to draft", kind: "primary", submit: true, id: "ag-ov-ok", onClick: apply }]} />
  );
}

export function OverridesTab({ a, d, ro, perm, projects, policies, edit }: TabProps) {
  const ui = useUI();
  const heat = useEvalsFactory().data?.heat?.[a.id];
  const rows = projects.filter((p) => p.status !== "archived");
  const cols: SortCol<Project>[] = [
    { key: "p", label: "Project", render: (p) => p.name },
    { key: "o", label: "Override", render: (p) => (d.overrides[p.id] ? <Chip text="custom" cls="info" /> : <span className="muted">Uses default</span>) },
    { key: "sc", label: "Eval", align: "end", render: (p) => { const v = heat?.[p.id]; return v == null ? "—" : <span className="num">{fmt.pct(v)}</span>; } },
    { key: "act", label: "", align: "end", render: (p) => <Btn label="Edit" small id={`ag-ov-edit-${p.id}`} aria={`Edit override on ${p.name}`} guard={ro ? perm : null} onClick={() => ui.open((close) => <OverrideDialog a={a} d={d} p={p} policies={policies} projects={projects} edit={edit} close={close} />)} /> },
  ];
  return (
    <Panel title="Overrides" flush>
      <DataTable id="ag-ov" caption="Per-project overrides" columns={cols} rows={rows} rowKey={(p) => p.id} pageSize={12} pager />
    </Panel>
  );
}
