/**
 * Skills (spec 8.7). Port of legacy/js/views/skills.js against /api/v1/skills: the library with filters and eval coverage, the definition (every save is a new immutable version),
 * the agents it is attached to, the projects it is enabled on and the version history. Attaching goes through the agent (audited there).
 * Not ported, on purpose: the "Resources" are file names only; the files that ship with a skill have no store in this build.
 */
import { useState, useSyncExternalStore } from "react";
import { fmt, type Skill } from "@gantry/domain";
import { useCan } from "../api/can";
import { useAgents, useLearningProposals, useProjects, useSkills } from "../api/queries";
import { ops } from "../api/ops";
import { Async } from "../ui/async";
import { Btn, Chip, Empty, Field, LockNote, Panel, Segmented, Select, Tabs, Toggle, ViewHead, Who, type Decision } from "../ui/primitives";
import { Dialog } from "../ui/Overlay";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { navigate } from "../lib/router";
import { useOutcome } from "./govern/data";
import { agentsSelect, EntityHistory, useStations, type AgentRow } from "./agents/kit";

type SkillRow = Skill & { rev: number };
const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

/* screen state, kept across tabs and screens like legacy `ui` */
const ui = { sel: null as string | null, tab: "def", draft: null as { name: string; desc: string; when: string; body: string; resources: string } | null, draftFor: null as string | null, note: "", q: "", filter: "all" };
let tick = 0;
const listeners = new Set<() => void>();
const rerender = (): void => { tick++; listeners.forEach((l) => l()); };
const useSkillsUi = (): number => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => tick);
/** Other screens (learning, agents) open a skill. */
export const skillsSelect = (id: string, tab?: string): void => { ui.sel = id; ui.draft = null; if (tab) ui.tab = tab; rerender(); };

/** The screen's state, exported so tests can reset it. */
export const skillsUi = ui;
const covPct = (sk: SkillRow): number => (sk.coverage.cases ? sk.coverage.pass / sk.coverage.cases : 0);

function CovCell({ sk }: { sk: SkillRow }) {
  const p = covPct(sk);
  const cls = !sk.coverage.cases ? "sk-cov-none" : p >= 0.9 ? "sk-cov-good" : p >= 0.8 ? "sk-cov-ok" : "sk-cov-low";
  return (
    <span className={`sk-cov ${cls}`} data-tip={sk.coverage.cases ? `${sk.coverage.pass} of ${sk.coverage.cases} cases pass` : "No eval cases exercise this skill"}>
      <span className="sk-cov-bar" aria-hidden="true"><span style={{ width: `${(p * 100).toFixed(0)}%` }} /></span>
      <span className="mono small">{sk.coverage.cases ? `${sk.coverage.pass}/${sk.coverage.cases}` : "none"}</span>
    </span>
  );
}

function Library({ skills, agents }: { skills: SkillRow[]; agents: AgentRow[] }) {
  const actor = useActors();
  const usedBy = (id: string) => agents.filter((a) => a.skills.includes(id));
  const q = ui.q.trim().toLowerCase();
  const list = skills.filter((sk) => {
    if (q && `${sk.name} ${sk.desc} ${sk.when}`.toLowerCase().indexOf(q) < 0) return false;
    if (ui.filter === "unused" && usedBy(sk.id).length) return false;
    if (ui.filter === "lowcov" && covPct(sk) >= 0.85 && sk.coverage.cases) return false;
    return true;
  });
  const open = (id: string) => { ui.sel = id; ui.draft = null; rerender(); };
  return (
    <div>
      <div className="toolbar sk-toolbar">
        <input id="sk-search" className="input" type="search" placeholder="Filter by name or purpose" aria-label="Filter skills" value={ui.q} onChange={(e) => { ui.q = e.target.value; rerender(); }} />
        <Segmented name="sk-filter" label="Show" items={[{ id: "all", label: "All" }, { id: "unused", label: "Unused" }, { id: "lowcov", label: "Low coverage" }]} value={ui.filter} onChange={(v) => { ui.filter = v; rerender(); }} />
      </div>
      <div className="table-scroll" data-keep-scroll="sk-lib">
        <table className="table sk-table">
          <thead><tr>{["Skill", "Version", "Used by", "Eval coverage"].map((x, i) => <th key={x} scope="col" className={i === 2 ? "num" : ""}>{x}</th>)}</tr></thead>
          <tbody>
            {list.length ? list.map((sk) => {
              const n = usedBy(sk.id).length;
              return (
                <tr key={sk.id} className={`row-link${ui.sel === sk.id ? " is-selected" : ""}`} tabIndex={0} id={`sk-row-${sk.id}`} aria-current={ui.sel === sk.id ? "true" : undefined}
                  onClick={() => open(sk.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(sk.id); } }}>
                  <td>
                    <div><strong>{sk.name}</strong>{sk.builtin ? <Chip text="built-in" cls="chip-accent" /> : null}</div><div className="small muted sk-desc">{sk.desc}</div>
                    <div className="small sk-meta">{`${actor(sk.owner).name.replace(" (agent)", "")} · `}{sk.projects === "all" ? "all projects" : sk.projects.length ? `${sk.projects.length} project${sk.projects.length > 1 ? "s" : ""}` : <span className="warn-text">no projects</span>}</div>
                  </td>
                  <td className="mono">{`v${sk.version}`}</td>
                  <td className={`num mono${n ? "" : " muted"}`}>{String(n)}</td>
                  <td><CovCell sk={sk} /></td>
                </tr>
              );
            }) : <tr><td colSpan={4}><Empty id="sk-empty" title="No skills match" text="Clear the filter to see the whole library." /></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DefTab({ sk, perm }: { sk: SkillRow; perm: Decision }) {
  const out = useOutcome();
  const ro = !perm.allowed;
  const saved = { name: sk.name, desc: sk.desc, when: sk.when, body: sk.body, resources: sk.resources.join("\n") };
  if (!ui.draft || ui.draftFor !== sk.id) { ui.draft = { ...saved }; ui.draftFor = sk.id; ui.note = ""; }
  const d = ui.draft;
  const dirty = JSON.stringify(d) !== JSON.stringify(saved);
  const next = sk.version.split(".").map(Number);
  next[1] = (next[1] ?? 0) + 1;
  next[2] = 0;
  const inp = (id: string, key: keyof typeof saved, rows?: number, ph?: string) => {
    const set = (v: string) => { d[key] = v; rerender(); };
    return rows
      ? <textarea id={id} className={`input${key === "body" || key === "resources" ? " mono" : ""}`} rows={rows} disabled={ro} placeholder={ph ?? ""} value={d[key]} onChange={(e) => set(e.target.value)} />
      : <input id={id} className="input" disabled={ro} placeholder={ph ?? ""} value={d[key]} onChange={(e) => set(e.target.value)} />;
  };
  const save = () => {
    const cur = d;
    if (JSON.stringify(cur) === JSON.stringify(saved)) { out({ ok: true, msg: "Nothing changed.", status: 200 }); return; }
    if (!cur.name.trim()) { out({ ok: false, msg: "Name the skill.", status: 422 }); return; }
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "desc", "when", "body"] as const) if (cur[k] !== sk[k]) patch[k] = k === "name" ? cur[k].trim() : cur[k];
    const res = cur.resources.split("\n").map((x) => x.trim()).filter(Boolean);
    if (JSON.stringify(res) !== JSON.stringify(sk.resources)) patch.resources = res;
    void ops.saveSkill(sk.id, patch, ui.note.trim() || `Edited ${Object.keys(patch).join(", ")}`, { ifMatch: sk.rev }).then((r) => { out(r); if (r.ok) { ui.draft = null; rerender(); } });
  };
  return (
    <div className="sk-def">
      <div className="form-grid">
        <Field label="Name" htmlFor="sk-name">{inp("sk-name", "name")}</Field>
        <Field label="Description" htmlFor="sk-desc" hint="One sentence. Shown to agents when they choose a skill.">{inp("sk-desc", "desc", 2)}</Field>
        <Field label="When to use" htmlFor="sk-when">{inp("sk-when", "when", 2)}</Field>
        <Field label="Body" htmlFor="sk-body" hint="The instructions the agent loads when the skill applies.">{inp("sk-body", "body", 7)}</Field>
        <Field label="Resources" htmlFor="sk-res" hint="One file name per line. Files ship with the skill.">{inp("sk-res", "resources", 3, "checklist.md")}</Field>
        <Field label="Change note" htmlFor="sk-note" hint={`Saving creates v${next.join(".")}. Agents pick up the new version on their next work order.`}>
          <input id="sk-note" className="input" disabled={ro} placeholder="What changed, in one line" value={ui.note} onChange={(e) => { ui.note = e.target.value; rerender(); }} />
        </Field>
      </div>
      <div className={`savebar${dirty ? " is-dirty" : ""}`} id="sk-savebar">
        <span className="muted small savebar-text">Every save is a new version with your note.</span>
        <Btn label="Discard" id="sk-discard" guard={ro ? perm : null} onClick={() => { ui.draft = null; rerender(); }} />
        <Btn label={`Save as v${next.join(".")}`} kind="primary" id="sk-save" guard={ro ? perm : null} onClick={save} />
      </div>
    </div>
  );
}

function AgentsTab({ sk, agents }: { sk: SkillRow; agents: AgentRow[] }) {
  const out = useOutcome();
  const perm = dec(useCan("agent.edit"));
  const st = useStations();
  return (
    <div>
      <LockNote decision={perm} what="Attaching skills to agents" />
      <p className="muted small sk-p">Attaching adds the skill at the end of the agent&apos;s skill order. Reorder in Agents. Each change is saved on the agent and audited.</p>
      <div className="table-scroll">
        <table className="table table-compact">
          <thead><tr>{["Agent", "Station", "Position", "Suite", "Attached"].map((x) => <th key={x} scope="col">{x}</th>)}</tr></thead>
          <tbody>
            {agents.map((a) => {
              const pos = a.skills.indexOf(sk.id);
              const station = st.find(a.station);
              return (
                <tr key={a.id}>
                  <td><a href="#agents" className="linkish" id={`sk-ag-link-${a.id}`} onClick={(e) => { e.preventDefault(); agentsSelect(a.id, "skills"); }}>{a.name}</a></td>
                  <td className="small">{station ? `${station.no} ${station.name}` : "Off-belt"}</td>
                  <td className="mono small">{pos >= 0 ? `${pos + 1} of ${a.skills.length}` : "–"}</td>
                  <td className="mono small">{a.suite}</td>
                  <td><Toggle id={`sk-att-${a.id}`} checked={pos >= 0} decision={perm} label={`Attach ${sk.name} to ${a.name}`} onChange={(v) => { void ops.attachSkill(a.id, sk.id, v).then((r) => out(r)); }} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProjectsTab({ sk, agents }: { sk: SkillRow; agents: AgentRow[] }) {
  const out = useOutcome();
  const perm = dec(useCan("skill.edit"));
  const projects = (useProjects().data ?? []).filter((p) => p.status !== "archived");
  const all = sk.projects === "all";
  const setProjects = (v: "all" | string[]) => { void ops.setSkillProjects(sk.id, v).then((r) => out(r)); };
  return (
    <div>
      <LockNote decision={perm} what="Where this skill is enabled" />
      <p className="muted small sk-p">An attached skill is loaded only on projects where it is enabled. Changing this does not create a new version.</p>
      <div className="toggle-row sk-all">
        <label htmlFor="sk-proj-all"><strong>All projects</strong><span className="muted small"> including projects created later</span></label>
        <Toggle id="sk-proj-all" checked={all} decision={perm} onChange={(v) => setProjects(v ? "all" : projects.map((p) => p.id))} />
      </div>
      <div className="table-scroll">
        <table className="table table-compact">
          <thead><tr>{["Project", "Agents using it there", "Enabled"].map((x) => <th key={x} scope="col">{x}</th>)}</tr></thead>
          <tbody>
            {projects.map((p) => {
              const on = all || (sk.projects as string[]).includes(p.id);
              const users = agents.filter((a) => a.skills.includes(sk.id) && (a.projects === "all" || a.projects.includes(p.id)));
              const lock: Decision | null = !perm.allowed ? perm : all ? { allowed: false, needs: "", reason: "Enabled on all projects. Turn off All projects to choose." } : null;
              return (
                <tr key={p.id}>
                  <td>{p.name}{p.regulated ? <span className="tag">regulated</span> : null}</td>
                  <td className="small">{users.length ? users.map((a) => a.name).join(", ") : <span className="muted">none</span>}</td>
                  <td><Toggle id={`sk-proj-${p.id}`} checked={on} decision={lock} label={`Enable on ${p.name}`} onChange={(v) => { const list = all ? [] : (sk.projects as string[]).slice(); setProjects(v ? [...list, p.id] : list.filter((x) => x !== p.id)); }} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VersionsTab({ sk }: { sk: SkillRow }) {
  const lp = (useLearningProposals().data ?? []).filter((x) => x.kind === "skill" && (x.change as { skill?: string } | undefined)?.skill === sk.id);
  return (
    <div>
      <ol className="sk-vers">
        {sk.versions.slice().reverse().map((v, i) => (
          <li key={v.v} className={i === 0 ? "is-current" : ""}>
            <span className="mono strong">{`v${v.v}`}</span>{i === 0 ? <Chip text="current" cls="chip-accent" /> : null}
            <span className="muted small">{fmt.stamp(v.at)}</span><Who id={v.by} /><span className="small">{v.note}</span>
          </li>
        ))}
      </ol>
      {lp.length ? (
        <div>
          <h3 className="sub-h">From the learning loop</h3>
          <ul className="plain-list small">
            {lp.map((x) => <li key={x.id}><a href="#learning" className="linkish" id={`sk-lp-${x.id}`} onClick={(e) => { e.preventDefault(); navigate("learning"); }}>{`${x.id} ${x.title}`}</a>{` · ${x.status}`}</li>)}
          </ul>
        </div>
      ) : null}
      <h3 className="sub-h">Audit history</h3>
      <EntityHistory type="skill" id={sk.id} limit={30} />
    </div>
  );
}

function Detail({ sk, agents }: { sk: SkillRow; agents: AgentRow[] }) {
  const actor = useActors();
  const perm = dec(useCan("skill.edit"));
  const users = agents.filter((a) => a.skills.includes(sk.id));
  const suites = [...new Set(users.map((a) => a.suite).filter(Boolean))];
  const tabs = [{ id: "def", label: "Definition" }, { id: "agents", label: "Agents", count: users.length }, { id: "projects", label: "Projects" }, { id: "versions", label: "Versions", count: sk.versions.length }];
  const body = ui.tab === "agents" ? <AgentsTab sk={sk} agents={agents} /> : ui.tab === "projects" ? <ProjectsTab sk={sk} agents={agents} /> : ui.tab === "versions" ? <VersionsTab sk={sk} /> : <DefTab sk={sk} perm={perm} />;
  return (
    <section className="panel sk-detail" id="sk-detail" aria-label={sk.name}>
      <div className="sk-head">
        <div className="sk-head-main"><div className="kicker">{`Skill · ${sk.id}${sk.builtin ? " · built-in" : ""}`}</div><h2 className="sk-title">{sk.name}</h2><p className="small">{sk.desc}</p></div>
        <dl className="titleblock sk-tb">
          <div><dt>Version</dt><dd className="mono">{`v${sk.version}`}</dd></div>
          <div><dt>Owner</dt><dd>{actor(sk.owner).name.replace(" (agent)", "")}</dd></div>
          <div><dt>Used by</dt><dd>{`${users.length} agent${users.length === 1 ? "" : "s"}`}</dd></div>
          <div><dt>Coverage</dt><dd><CovCell sk={sk} /></dd></div>
          <div><dt>Suites</dt><dd className="mono small">{suites.join(", ") || "none"}</dd></div>
        </dl>
      </div>
      <LockNote decision={perm} what="Skill text" />
      <Tabs idPrefix="sk-tab" items={tabs} active={ui.tab} onChange={(t) => { ui.tab = t; rerender(); }} />
      <div className="sk-body">{body}</div>
    </section>
  );
}

function NewSkill({ agents, close }: { agents: AgentRow[]; close: () => void }) {
  const ui_ = useUI();
  const perm = dec(useCan("skill.edit"));
  const attachGuard = dec(useCan("agent.edit"));
  const [f, setF] = useState({ name: "", desc: "", when: "", body: "", res: "", attach: "" });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Dialog title="New skill" kicker="Build · skills" wide onClose={close} sub="Skills start at v1.0.0, enabled on all projects. Add eval cases in the agent's suite to cover them."
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what="Creating skills" />
          <Field label="Name" htmlFor="sk-new-name"><input id="sk-new-name" className="input" placeholder="e.g. API contract review" value={f.name} onChange={set("name")} /></Field>
          <Field label="Description" htmlFor="sk-new-desc"><input id="sk-new-desc" className="input" value={f.desc} onChange={set("desc")} /></Field>
          <Field label="When to use" htmlFor="sk-new-when"><input id="sk-new-when" className="input" placeholder="e.g. At Design when an endpoint changes" value={f.when} onChange={set("when")} /></Field>
          <Field label="Body" htmlFor="sk-new-body"><textarea id="sk-new-body" className="input mono" rows={5} value={f.body} onChange={set("body")} /></Field>
          <Field label="Resources" htmlFor="sk-new-res"><textarea id="sk-new-res" className="input mono" rows={2} placeholder="one file per line" value={f.res} onChange={set("res")} /></Field>
          <Field label="Attach" htmlFor="sk-new-attach" hint={attachGuard.allowed ? undefined : `Attaching needs Configure agents: ${attachGuard.reason}`}>
            <Select id="sk-new-attach" disabled={!attachGuard.allowed} value={f.attach} options={[{ value: "", label: "Do not attach yet" }, ...agents.map((a) => ({ value: a.id, label: `Attach to ${a.name}` }))]} onChange={(v) => setF((x) => ({ ...x, attach: v }))} />
          </Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      )}
      actions={[
        { label: "Cancel" },
        {
          label: "Create skill", kind: "primary", submit: true, id: "sk-new-ok", guard: perm,
          onClick: (done) => {
            if (!f.name.trim()) { setErr("Name the skill."); return; }
            void ops.saveSkill(null, { name: f.name, desc: f.desc.trim(), when: f.when.trim(), body: f.body, resources: f.res.split("\n").map((x) => x.trim()).filter(Boolean) }).then(async (r) => {
              if (!r.ok) { setErr(r.msg); return; }
              const created = (r as unknown as { skill?: SkillRow }).skill;
              if (created && f.attach) { const r2 = await ops.attachSkill(f.attach, created.id, true); if (!r2.ok) ui_.toast(r2.msg, "error"); }
              if (created) { ui.sel = created.id; ui.tab = "def"; ui.draft = null; rerender(); }
              ui_.toast(r.msg, "ok");
              done();
            });
          },
        },
      ]} />
  );
}

export default function SkillsView() {
  useSkillsUi();
  const ui_ = useUI();
  const q = useSkills();
  const skills = (q.data ?? []) as SkillRow[];
  const agents = (useAgents().data ?? []) as unknown as AgentRow[];
  const perm = dec(useCan("skill.edit"));
  const head = (extra?: { meta?: Array<[string, string]> }) => (
    <ViewHead title="Skills" sub="Reusable know-how that agents load when a task calls for it. Versioned, owned and covered by evals." meta={extra?.meta}
      actions={<Btn label="New skill" kind="primary" icon="plus" id="sk-new" guard={perm} onClick={() => ui_.open((close) => <NewSkill agents={agents} close={close} />)} />} />
  );
  if (q.data === undefined) return <div className="view view-skills">{head()}<Async query={q} what="skills" id="skills">{() => null}</Async></div>;
  if (!skills.length) return <div className="view view-skills">{head()}<Empty title="No skills yet" text="Create the first skill." /></div>;
  if (!ui.sel || !skills.some((s) => s.id === ui.sel)) ui.sel = skills[0]!.id;
  const current = skills.find((s) => s.id === ui.sel) ?? skills[0]!;
  const unused = skills.filter((sk) => !agents.some((a) => a.skills.includes(sk.id))).length;
  const cases = skills.reduce((t, sk) => t + sk.coverage.cases, 0);
  const pass = skills.reduce((t, sk) => t + sk.coverage.pass, 0);
  return (
    <div className="view view-skills">
      {head({ meta: [["Skills", String(skills.length)], ["Unused", String(unused)], ["Eval cases", String(cases)], ["Pass rate", cases ? fmt.pct(pass / cases) : "–"]] })}
      <div className="sk-grid">
        <Panel title="Library" flush cls="sk-lib"><Library skills={skills} agents={agents} /></Panel>
        <Detail sk={current} agents={agents} />
      </div>
    </div>
  );
}
