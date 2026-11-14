/** The Onboarding agent tab (legacy onboarding.js agentTab): the agent, the factory guidelines with their versions, and the project's additions. */
import { useState } from "react";
import { fmt, type GuidelineItem, type OrgGuidelines, type Project } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useAgents, useGuidelines, useSkills, useVendors } from "../../api/queries";
import { Avatar, Btn, Empty, Field, LockNote, Panel, Toggle } from "../../ui/primitives";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { updatePrefs } from "../../lib/prefs";
import { HistoryList } from "../project-config/history";

interface Item { id: string; text: string; required: boolean }
const clone = (xs: GuidelineItem[]): Item[] => xs.map((x) => ({ id: x.id, text: x.text, required: x.required }));
const newId = (p: string): string => `${p}-n${Date.now().toString(36)}`;

function ItemRow({ it, i, prefix, label, locked, dec, set, remove }: { it: Item; i: number; prefix: string; label: string; locked: boolean; dec: ReturnType<typeof useCan>; set: (p: Partial<Item>) => void; remove: () => void }) {
  return (
    <li>
      <span className="onb-gl-no mono">{prefix === "pg" ? `P${i + 1}` : String(i + 1).padStart(2, "0")}</span>
      <input id={`onb-${prefix}-t-${it.id}`} className="input" value={it.text} disabled={locked} aria-label={`${label} ${i + 1}`} onChange={(e) => set({ text: e.target.value })} />
      <span className="onb-gl-req">
        <Toggle id={`onb-${prefix}-r-${it.id}`} checked={it.required} decision={locked ? dec : null} label="Required for Ready" onChange={(v) => set({ required: v })} />
        <span className="small muted">{it.required ? "Required" : "Advisory"}</span>
      </span>
      <Btn kind="ghost" small icon="x" id={`onb-${prefix}-rm-${it.id}`} aria={`Remove ${label.toLowerCase()} ${i + 1}`} guard={dec} onClick={remove} />
    </li>
  );
}

/** Project Admins' additions on top of the factory guidelines. */
function ProjectGuidelines({ project }: { project: Project }) {
  const ui = useUI();
  const dec = useCan("onboarding.guidelines", { project: project.id });
  const pg = project.guidelines ?? { items: [], notes: "", version: 0, history: [] };
  const key = `${project.id}:${pg.version || 0}`;
  const [state, setState] = useState<{ key: string; items: Item[]; notes: string; note: string }>({ key, items: clone(pg.items), notes: pg.notes || "", note: "" });
  const [err, setErr] = useState("");
  // The server's version moved (somebody saved, or we did): start again from it.
  if (state.key !== key) setState({ key, items: clone(pg.items), notes: pg.notes || "", note: "" });
  const locked = !dec.allowed;
  const upd = (p: Partial<typeof state>) => setState((s) => ({ ...s, ...p }));
  const save = async () => {
    const clean = state.items.map((x) => ({ id: x.id, text: x.text.trim(), required: x.required }));
    if (clean.some((x) => !x.text)) return setErr("Every item needs text, or remove it.");
    if (state.note.trim().length < 3) return setErr("Add a short change note.");
    setErr("");
    const r = await ops.saveGuidelines({ items: clean, notes: state.notes.trim() }, state.note.trim(), project.id, { ifMatch: pg.version || 0 });
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (!r.ok) setErr(r.msg);
  };
  return (
    <Panel cls="onb-gl-panel" title={<span>{`Additions for ${project.name} `}<span className="mono small muted">{pg.version ? `v${pg.version}` : "none yet"}</span></span>}>
      <div className="onb-gl">
        <LockNote decision={dec} what={`${project.name} onboarding additions`} />
        <p className="muted small">{`Project Admins add rules on top of the factory guidelines for repos in ${project.name}. The factory list above still applies. They are written into each repo's AGENTS.md.`}</p>
        {state.items.length ? (
          <ol className="onb-gl-items">
            {state.items.map((it, i) => (
              <ItemRow key={it.id} it={it} i={i} prefix="pg" label="Project guideline" locked={locked} dec={dec} set={(p) => upd({ items: state.items.map((x, k) => (k === i ? { ...x, ...p } : x)) })} remove={() => upd({ items: state.items.filter((_, k) => k !== i) })} />
            ))}
          </ol>
        ) : (
          <p className="muted small">No project-specific items.</p>
        )}
        <Btn label="Add item" small icon="plus" id="onb-pg-add" guard={dec} onClick={() => upd({ items: [...state.items, { id: newId("pg"), text: "", required: true }] })} />
        <Field label="Notes for the agent" htmlFor="onb-pg-notes">
          <textarea id="onb-pg-notes" className="input" rows={2} disabled={locked} placeholder="Anything the Onboarding agent must know about this project" value={state.notes} onChange={(e) => upd({ notes: e.target.value })} />
        </Field>
        <Field label="Change note (audited)" htmlFor="onb-pg-note">
          <input id="onb-pg-note" className="input" value={state.note} disabled={locked} placeholder="What changed and why" onChange={(e) => upd({ note: e.target.value })} />
        </Field>
        <div className="form-err" role="alert" id="onb-pg-err">{err}</div>
        <div className="form-actions"><Btn kind="primary" id="onb-pg-save" label="Save project additions" guard={dec} onClick={() => void save()} /></div>
        <h3 className="sub-h">Audit</h3>
        <HistoryList type="guidelines" id={project.id} project={project.id} limit={6} />
      </div>
    </Panel>
  );
}

function FactoryGuidelines({ g }: { g: OrgGuidelines }) {
  const ui = useUI();
  const actors = useActors();
  const dec = useCan("agent.edit");
  const [d, setD] = useState<{ v: number; items: Item[]; may: string; mayNot: string; dirty: boolean }>({ v: g.version, items: clone(g.items), may: g.may, mayNot: g.mayNot, dirty: false });
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  if (d.v !== g.version) setD({ v: g.version, items: clone(g.items), may: g.may, mayNot: g.mayNot, dirty: false });
  const locked = !dec.allowed;
  const upd = (p: Partial<typeof d>) => setD((s) => ({ ...s, ...p, dirty: true }));
  const reset = () => { setD({ v: g.version, items: clone(g.items), may: g.may, mayNot: g.mayNot, dirty: false }); setNote(""); setErr(""); };
  const save = async () => {
    const clean = d.items.map((x) => ({ id: x.id, text: x.text.trim(), required: x.required }));
    if (clean.some((x) => !x.text)) return setErr("Every item needs text, or remove it.");
    if (note.trim().length < 3) return setErr("Add a short change note.");
    setErr("");
    const r = await ops.saveGuidelines({ items: clean, may: d.may.trim(), mayNot: d.mayNot.trim() }, note.trim(), null, { ifMatch: g.version });
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (r.ok) { setNote(""); } else setErr(r.msg);
  };
  return (
    <Panel cls="onb-gl-panel" title={<span>{"Onboarding guidelines "}<span className="mono small muted">{`v${g.version}`}</span></span>}>
      <div className="onb-gl">
        <LockNote decision={dec} what="The onboarding guidelines" />
        <p className="muted small">{`What Ready means. The Onboarding agent checks every required item and the PR may only touch what is allowed below. ${g.version ? `Last saved by ${actors(g.by).name}, ${fmt.stamp(g.at)}.` : "Not saved yet: these are the built-in defaults."}`}</p>
        <ol className="onb-gl-items">
          {d.items.map((it, i) => (
            <ItemRow key={it.id} it={it} i={i} prefix="gl" label="Guideline" locked={locked} dec={dec} set={(p) => upd({ items: d.items.map((x, k) => (k === i ? { ...x, ...p } : x)) })} remove={() => upd({ items: d.items.filter((_, k) => k !== i) })} />
          ))}
        </ol>
        <Btn label="Add item" small icon="plus" id="onb-gl-add" guard={dec} onClick={() => upd({ items: [...d.items, { id: newId("gl"), text: "", required: true }] })} />
        <Field label="The PR may change" htmlFor="onb-gl-may"><textarea id="onb-gl-may" className="input" rows={2} disabled={locked} value={d.may} onChange={(e) => upd({ may: e.target.value })} /></Field>
        <Field label="The PR may never change" htmlFor="onb-gl-maynot"><textarea id="onb-gl-maynot" className="input" rows={2} disabled={locked} value={d.mayNot} onChange={(e) => upd({ mayNot: e.target.value })} /></Field>
        <Field label="Change note (written to the audit ledger)" htmlFor="onb-gl-note"><input id="onb-gl-note" className="input" value={note} placeholder="What changed and why" disabled={locked} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="form-err" role="alert" id="onb-gl-err">{err}</div>
        <div className="form-actions">
          <Btn id="onb-gl-reset" label="Discard changes" disabledReason={!d.dirty ? "No unsaved changes" : null} onClick={reset} />
          <Btn kind="primary" id="onb-gl-save" label={`Save as v${g.version + 1}`} guard={dec} disabledReason={dec.allowed && !d.dirty ? "No unsaved changes" : null} onClick={() => void save()} />
        </div>
      </div>
    </Panel>
  );
}

export function AgentTab({ project }: { project: Project }) {
  const actors = useActors();
  const g = useGuidelines().data;
  const a = (useAgents().data ?? []).find((x) => x.id === "ag-onboard");
  const skillList = useSkills().data;
  const vendors = useVendors().data;
  const modelName = (id: string): string => (Array.isArray(vendors) ? vendors : []).flatMap((v) => v.models).find((m) => m.id === id)?.name ?? id;
  const skills = a ? a.skills.map((id) => (Array.isArray(skillList) ? skillList : []).find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s) : [];
  const agentPanel = a ? (
    <Panel title="Onboarding agent">
      <div className="onb-agent">
        <div className="onb-agent-id">
          <Avatar id={a.id} size="lg" />
          <div>
            <strong>{a.name}</strong>
            <div className="mono small muted">{`${a.id} · v${a.version} · ${modelName(a.model)}`}</div>
            <div className="small">{`Autonomy: ${a.autonomy} · status ${a.status}`}</div>
          </div>
        </div>
        <h3 className="sub-h">Instructions</h3>
        <p className="onb-instr">{a.instructions}</p>
        <h3 className="sub-h">Skills, in order</h3>
        {skills.length ? (
          <ol className="onb-skills">
            {skills.map((s) => (
              <li key={s.id}><strong>{s.name}</strong><span className="mono small muted">{` v${s.version}`}</span><div className="small muted">{s.when}</div></li>
            ))}
          </ol>
        ) : (
          <p className="muted small">No skills attached.</p>
        )}
        <p className="small">
          Instructions, model and skills are edited on the agent.{" "}
          <a href="#agents" id="onb-agent-link" onClick={() => { updatePrefs({ agent: a.id }); navigate("agents"); }}>Open the Onboarding agent</a>
        </p>
      </div>
    </Panel>
  ) : (
    <Panel title="Onboarding agent"><Empty title="Agent not shown" text="The Onboarding agent could not be read." /></Panel>
  );
  return (
    <div className="onb-agent-grid">
      <div className="onb-col">
        {agentPanel}
        {g ? (
          <Panel title="Guideline versions">
            <div>
              <ol className="onb-vers">
                {g.history.slice().reverse().map((v) => (
                  <li key={v.v}><span className="mono strong">{`v${v.v}`}</span><span>{v.note}</span><span className="muted small">{`${actors(v.by).name}, ${fmt.stamp(v.at)}`}</span></li>
                ))}
                {!g.history.length ? <li><span className="muted small">No version saved yet.</span></li> : null}
              </ol>
              <h3 className="sub-h">Audit</h3>
              <HistoryList type="guidelines" id="onboarding" project="" limit={10} />
            </div>
          </Panel>
        ) : null}
      </div>
      <div className="onb-col">
        {g ? <FactoryGuidelines g={g} /> : <Panel title="Onboarding guidelines"><p className="muted small">Loading…</p></Panel>}
        <ProjectGuidelines project={project} />
      </div>
    </div>
  );
}
