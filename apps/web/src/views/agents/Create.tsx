/** Create agent (legacy createAgentDialog): template, model, permissions, staffing, review. The agent starts paused at 0.1.0 with its own eval suite. */
import { useState } from "react";
import type { Policy, Project } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useSkills } from "../../api/queries";
import { Field, LockNote, Select, Toggle, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { AUTONOMY, TEMPLATES, TOOLS, autonomyCheck, rerender, ui, useModels, useStations, type AgentRow, type Tools } from "./kit";

const STEPS = ["Template", "Model", "Permissions", "Staffing", "Review"];

interface New {
  tpl: string; name: string; station: string; model: string; fallbacks: string[]; autonomy: string; tools: Tools; stations: string[]; projects: "all" | string[]; budget: number; instructions: string; skills: string[];
}

export function CreateAgent({ agents, projects, policies, perm, close }: { agents: AgentRow[]; projects: Project[]; policies: Policy[]; perm: Decision; close: () => void }) {
  const ui_ = useUI();
  const m = useModels();
  const st = useStations();
  const skills = useSkills().data ?? [];
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const tplInit = (tplId: string, prev?: New): New => {
    const t = TEMPLATES.find((x) => x.id === tplId)!;
    return {
      ...(prev ?? { fallbacks: [], projects: "all" as const }),
      tpl: t.id, name: t.id === "blank" ? "" : `${t.name} ${agents.filter((a) => a.name.indexOf(t.name) === 0).length + 1}`, station: t.station, stations: [t.station], autonomy: t.autonomy, skills: t.skills.slice(),
      tools: { readRepo: true, writeBranch: !!t.tools.writeBranch, runTests: !!t.tools.runTests, openPR: !!t.tools.openPR, merge: false, postSlack: true, sendEmail: false, readSecrets: false },
      budget: t.budget, instructions: t.instructions, model: m.overrides[t.station] || m.defaultModel,
    } as New;
  };
  const [d, setD] = useState<New>(() => tplInit("builder"));
  const upd = (fn: (x: New) => void) => setD((cur) => { const n = { ...cur, tools: { ...cur.tools }, fallbacks: [...cur.fallbacks], stations: [...cur.stations], skills: [...cur.skills], projects: cur.projects === "all" ? "all" as const : [...cur.projects] }; fn(n); return n; });
  const check = (autonomy: string) => autonomyCheck(policies, projects, { station: d.station, projects: d.projects }, autonomy);
  const live = projects.filter((p) => p.status !== "archived");
  const models = m.list;
  const last = step === STEPS.length - 1;
  const chk = check(d.autonomy);

  const body = (
    <div className="ag-create">
      <LockNote decision={perm} what="Creating agents" />
      <ol className="stepper">{STEPS.map((n, i) => <li key={n} className={i === step ? "is-on" : i < step ? "is-done" : ""}><span className="mono">{String(i + 1)}</span>{n}</li>)}</ol>
      {step === 0 ? (
        <>
          <div className="radio-cards" role="radiogroup" aria-label="Template">
            {TEMPLATES.map((t) => (
              <label key={t.id} className={`radio-card${d.tpl === t.id ? " is-on" : ""}`} htmlFor={`ca-tpl-${t.id}`}>
                <input type="radio" name="ca-tpl" id={`ca-tpl-${t.id}`} checked={d.tpl === t.id} onChange={() => setD((cur) => tplInit(t.id, cur))} />
                <span className="rc-t">{t.name}</span><span className="rc-d muted small">{`${st.label(t.station, projects)}. ${t.instructions || "Start from nothing."}`}</span>
              </label>
            ))}
          </div>
          <div className="form-row">
            <Field label="Name" htmlFor="ca-name"><input id="ca-name" className="input" placeholder="Agent name" value={d.name} onChange={(e) => upd((x) => { x.name = e.target.value; })} /></Field>
            <Field label="Home station" htmlFor="ca-station">
              <Select id="ca-station" value={d.station} options={st.all.map((x) => ({ value: x.id, label: st.label(x.id, projects) }))} onChange={(v) => upd((x) => { x.station = v; if (!x.stations.includes(v)) x.stations.unshift(v); })} />
            </Field>
          </div>
          <Field label="Agent instructions" htmlFor="ca-instr" hint="Layer 3. The factory base and project overlays are added automatically."><textarea id="ca-instr" className="input" rows={3} value={d.instructions} onChange={(e) => upd((x) => { x.instructions = e.target.value; })} /></Field>
        </>
      ) : step === 1 ? (
        <>
          <Field label="Primary model" htmlFor="ca-model" hint={`Routing suggests ${m.overrides[d.station] || m.defaultModel} for ${st.label(d.station, projects)}.`}>
            <Select id="ca-model" value={d.model} options={models.some((x) => x.id === d.model) || !d.model ? models.map((x) => ({ value: x.id, label: `${x.name} · ${x.vendor}` })) : [{ value: d.model, label: `${d.model} (not available)` }, ...models.map((x) => ({ value: x.id, label: `${x.name} · ${x.vendor}` }))]}
              onChange={(v) => upd((x) => { x.model = v; x.fallbacks = x.fallbacks.filter((f) => f !== v); })} />
          </Field>
          <div className="field">
            <div className="field-label">Fallbacks, tick in order of preference</div>
            <div className="check-grid">
              {models.filter((x) => x.id !== d.model).map((x) => {
                const pos = d.fallbacks.indexOf(x.id);
                return (
                  <label key={x.id} className="check" htmlFor={`ca-fb-${x.id}`}>
                    <input type="checkbox" id={`ca-fb-${x.id}`} checked={pos >= 0} onChange={(e) => upd((n) => { n.fallbacks = e.target.checked ? [...n.fallbacks, x.id] : n.fallbacks.filter((f) => f !== x.id); })} />
                    {x.name}{pos >= 0 ? <span className="mono chip">{`#${pos + 1}`}</span> : null}
                  </label>
                );
              })}
            </div>
          </div>
        </>
      ) : step === 2 ? (
        <>
          <div className="radio-cards" role="radiogroup" aria-label="Autonomy">
            {AUTONOMY.map((o) => {
              const c = check(o[0]);
              return (
                <label key={o[0]} className={`radio-card${d.autonomy === o[0] ? " is-on" : ""}${c.allowed ? "" : " is-locked"}`} htmlFor={`ca-aut-${o[0]}`} data-reason={c.allowed ? undefined : c.reason}>
                  <input type="radio" name="ca-aut" id={`ca-aut-${o[0]}`} checked={d.autonomy === o[0]} disabled={!c.allowed} onChange={() => upd((x) => { x.autonomy = o[0]; })} />
                  <span className="rc-t">{o[1]}</span><span className="rc-d muted small">{o[2]}</span>
                  {c.allowed ? null : <span className="rc-why small neg"><Icon name="lock" /> Blocked by POL-112</span>}
                </label>
              );
            })}
          </div>
          <div className="toggle-grid ag-create-tools">
            {TOOLS.map((t) => <div key={t[0]} className="toggle-row"><label htmlFor={`ca-tool-${t[0]}`}>{t[1]}</label><Toggle id={`ca-tool-${t[0]}`} checked={!!d.tools[t[0]]} onChange={(v) => upd((x) => { x.tools[t[0]] = v; })} /></div>)}
          </div>
          <Field label="Budget per work order (USD)" htmlFor="ca-budget"><input id="ca-budget" className="input mono" type="number" min="0" step="0.5" value={String(d.budget)} onChange={(e) => upd((x) => { x.budget = +e.target.value || 0; })} /></Field>
        </>
      ) : step === 3 ? (
        <>
          <div className="field">
            <div className="field-label">Stations it may staff</div>
            <div className="check-grid">
              {st.all.map((s) => (
                <label key={s.id} className="check" htmlFor={`ca-st-${s.id}`}>
                  <input type="checkbox" id={`ca-st-${s.id}`} checked={d.stations.includes(s.id)} onChange={(e) => upd((x) => { x.stations = e.target.checked ? [...x.stations, s.id] : x.stations.filter((y) => y !== s.id); })} />
                  <span className="mono muted">{s.no}</span>{s.name}{s.custom ? <span className="tag">{projects.find((p) => p.id === s.project)?.name ?? s.project}</span> : null}
                </label>
              ))}
            </div>
          </div>
          <Field label="Projects" htmlFor="ca-projects">
            <Select id="ca-projects" value={d.projects === "all" ? "all" : d.projects[0] ?? "all"} options={[{ value: "all", label: "All projects" }, ...live.map((p) => ({ value: p.id, label: `Only ${p.name}${p.regulated ? " (regulated)" : ""}` }))]} onChange={(v) => upd((x) => { x.projects = v === "all" ? "all" : [v]; })} />
          </Field>
          <div className="field">
            <div className="field-label">Skills</div>
            <div className="check-grid">
              {skills.map((sk) => (
                <label key={sk.id} className="check" htmlFor={`ca-sk-${sk.id}`}>
                  <input type="checkbox" id={`ca-sk-${sk.id}`} checked={d.skills.includes(sk.id)} onChange={(e) => upd((x) => { x.skills = e.target.checked ? [...x.skills, sk.id] : x.skills.filter((y) => y !== sk.id); })} />
                  {sk.name}
                </label>
              ))}
            </div>
          </div>
          {chk.allowed ? null : <div className="callout callout-block"><Icon name="lock" /><span>{chk.reason}</span></div>}
        </>
      ) : (
        <>
          <dl className="titleblock ag-review">
            {([
              ["Name", d.name || "(none)"], ["Station", st.label(d.station, projects)], ["Model", d.model], ["Fallbacks", d.fallbacks.join(", ") || "none"], ["Autonomy", d.autonomy], ["Budget / WO", `$${d.budget}`],
              ["Stations", d.stations.map((s) => st.label(s, projects)).join(", ") || "none"], ["Projects", d.projects === "all" ? "All" : d.projects.map((p) => projects.find((x) => x.id === p)?.name ?? p).join(", ")],
              ["Tools", TOOLS.filter((t) => d.tools[t[0]]).map((t) => t[1]).join(", ")], ["Skills", d.skills.map((x) => skills.find((s) => s.id === x)?.name ?? x).join(", ") || "none"],
            ] as Array<[string, string]>).map((r) => <div key={r[0]}><dt>{r[0]}</dt><dd>{r[1]}</dd></div>)}
          </dl>
          <p className="callout"><Icon name="lock" /><span>The agent starts paused at 0.1.0 with its own eval suite. It staffs the floor only after a version passes that suite and someone promotes it.</span></p>
          {chk.allowed ? null : <div className="callout callout-block"><Icon name="lock" /><span>{chk.reason}</span></div>}
        </>
      )}
      <div className="form-err" role="alert">{err}</div>
    </div>
  );

  const next = (done: () => void): void => {
    if (step === 0 && !d.name.trim()) { setErr("Give the agent a name."); return; }
    if (step === 3 && !d.stations.length) { setErr("Pick at least one station."); return; }
    setErr("");
    if (step < STEPS.length - 1) { setStep(step + 1); return; }
    if (!chk.allowed) { setErr(chk.reason ?? ""); return; }
    const stations = d.stations.includes(d.station) ? d.stations : [d.station, ...d.stations];
    void ops.createAgent({ name: d.name.trim(), station: d.station, model: d.model, fallbacks: d.fallbacks, autonomy: d.autonomy, tools: d.tools, stations, projects: d.projects, budget: d.budget, instructions: d.instructions, skills: d.skills }).then((r) => {
      if (!r.ok) { setErr(r.msg); return; }
      const created = (r as unknown as { agent?: AgentRow }).agent;
      if (created) { ui.sel = created.id; ui.draft = null; ui.tab = "config"; rerender(); }
      ui_.toast(r.msg, "ok");
      done();
    });
  };
  return (
    <Dialog title="Create agent" kicker="Agents · new" wide onClose={close} body={body}
      actions={[
        { label: "Cancel", id: "ca-cancel" },
        { label: "Back", id: "ca-back", guard: step === 0 ? { allowed: false, reason: "This is the first step.", needs: "" } : null, onClick: () => { if (step > 0) setStep(step - 1); } },
        { label: last ? "Create agent" : "Next", kind: "primary", submit: true, id: "ca-next", guard: perm, onClick: next },
      ]} />
  );
}
