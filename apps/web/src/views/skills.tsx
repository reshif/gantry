/**
 * Skills (spec 8.7) against /api/v1/skills, in the Blueprint layout: the library (search, one flush table) and a right-hand drawer for one skill
 * (`#skills/<id>`: when, owner, used by, body, Edit). Edit and New open one "Edit skill" dialog; every save is a new immutable version.
 * The drawer also keeps what the library needs beyond the prototype: attach to agents, the projects a skill is enabled on, its versions.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { fmt, type Skill } from "@gantry/domain";
import { useCan } from "../api/can";
import { useAgents, useLearningProposals, useProjects, useSkills } from "../api/queries";
import { ops } from "../api/ops";
import { Async, useCommand } from "../ui/async";
import { Btn, Chip, Empty, Field, FilterBar, IconBtn, LockNote, Panel, SearchBox, Toggle, ViewHead, Who, type Decision } from "../ui/primitives";
import { DataTable, type SortCol } from "../ui/SortTable";
import { Dialog } from "../ui/Overlay";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { hashFor, navigate, replaceHash, useHash } from "../lib/router";
import { invalidateSlices } from "../api/keys";
import { agentsSelect, EntityHistory, useStations, type AgentRow } from "./agents/kit";

type SkillRow = Skill & { rev: number };
const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

/* the library's search, kept across opening a skill and coming back */
const ui = { q: "" };
const listeners = new Set<() => void>();
let tick = 0;
const rerender = (): void => { tick++; listeners.forEach((l) => l()); };
const useSkillsUi = (): number => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => tick);
/** Other screens (learning, agents) open a skill. */
export const skillsSelect = (id: string): void => navigate("skills", id);
/** The screen's state, exported so tests can reset it. */
export const skillsUi = ui;

const ownerName = (actor: ReturnType<typeof useActors>, id: string): string => actor(id).name.replace(" (agent)", "");
const usedBy = (agents: AgentRow[], id: string): AgentRow[] => agents.filter((a) => a.skills.includes(id) || (a.liveSkills ?? []).some((l) => l.id === id));

/** The library: search and one flush table. A row opens the skill's drawer. */
function Library({ skills, agents, onEdit }: { skills: SkillRow[]; agents: AgentRow[]; onEdit: (sk: SkillRow) => void }) {
  const actor = useActors();
  const perm = dec(useCan("skill.edit"));
  const q = ui.q.trim().toLowerCase();
  const list = skills.filter((sk) => !q || `${sk.name} ${sk.desc} ${sk.when}`.toLowerCase().includes(q));
  const open = (sk: SkillRow) => navigate("skills", sk.id);
  const clear = (): void => { ui.q = ""; rerender(); };
  const cols: SortCol<SkillRow>[] = [
    { key: "name", label: "Skill", sort: (sk) => sk.name.toLowerCase(), render: (sk) => (
      <div>
        <a className="pri sk-name" href={hashFor("skills", sk.id)} onClick={(e) => { e.preventDefault(); open(sk); }}>{sk.name}</a>
        <span className="sub sk-desc">{sk.desc}</span>
      </div>
    ) },
    { key: "when", label: "When to use", render: (sk) => <span className="small">{sk.when}</span> },
    { key: "used", label: "Used by", sort: (sk) => usedBy(agents, sk.id).length, align: "end", render: (sk) => `${usedBy(agents, sk.id).length} agents` },
    { key: "owner", label: "Owner", render: (sk) => ownerName(actor, sk.owner) },
    { key: "edit", label: "", align: "end", render: (sk) => <Btn label="Edit" small id={`sk-edit-${sk.id}`} aria={`Edit ${sk.name}`} guard={perm} onClick={() => onEdit(sk)} /> },
  ];
  return (
    <Panel flush cls="sk-lib">
      <FilterBar label="Filter skills" count={`${list.length} skill${list.length === 1 ? "" : "s"}${list.length !== skills.length ? ` of ${skills.length}` : ""}`} actions={q ? <Btn label="Clear" small kind="ghost" id="sk-clear" onClick={clear} /> : undefined}>
        <SearchBox id="sk-search" value={ui.q} onChange={(v) => { ui.q = v; rerender(); }} placeholder="Search…" label="Search skills" />
      </FilterBar>
      <DataTable id="sk-lib" caption="Skills" columns={cols} rows={list} rowKey={(sk) => sk.id} rowId={(sk) => `sk-row-${sk.id}`} onRow={open} pageSize={12} pager
        empty={skills.length ? { title: "Nothing matches these filters", text: "Loosen the search or clear the filters.", action: <Btn label="Clear filters" id="sk-clear-empty" onClick={clear} /> } : { title: "Nothing here yet", text: "Items will appear here when they exist." }} />
    </Panel>
  );
}

function AgentsTab({ sk, agents }: { sk: SkillRow; agents: AgentRow[] }) {
  const attach = useCommand((agent: string, on: boolean) => ops.attachSkill(agent, sk.id, on));
  const perm = dec(useCan("agent.edit"));
  const st = useStations();
  return (
    <div>
      <LockNote decision={perm} what="Attaching skills to agents" />
      <p className="muted small sk-p">&quot;Runs with&quot; is what the version on the floor uses. &quot;Attached in draft&quot; is the agent&apos;s working copy: changing it is saved on the agent and audited, and reaches runs only in the next version that passes its eval suite.</p>
      <div className="table-scroll">
        <table className="table table-compact">
          <thead><tr>{["Agent", "Station", "Runs with", "Draft position", "Attached in draft"].map((x) => <th key={x} scope="col">{x}</th>)}</tr></thead>
          <tbody>
            {agents.map((a) => {
              const pos = a.skills.indexOf(sk.id);
              const station = st.find(a.station);
              const liveSk = (a.liveSkills ?? []).find((l) => l.id === sk.id);
              const drift = !!liveSk !== (pos >= 0);
              return (
                <tr key={a.id}>
                  <td><a href="#agents" className="linkish" id={`sk-ag-link-${a.id}`} onClick={(e) => { e.preventDefault(); agentsSelect(a.id, "skills"); }}>{a.name}</a></td>
                  <td className="small">{station ? `${station.no} ${station.name}` : "Off-belt"}</td>
                  <td className="small" id={`sk-live-${a.id}`}>{liveSk ? <Chip text={liveSk.version ? `Live ${a.version} · skill v${liveSk.version}` : `Live ${a.version}`} cls="chip-ok" /> : <span className="muted">Not used by the live version</span>}{drift ? <div className="small warn-text">{pos >= 0 ? "Attached in draft only: runs after the next version is promoted." : "Detached in draft: still runs until the next version is promoted."}</div> : null}</td>
                  <td className="mono small">{pos >= 0 ? `${pos + 1} of ${a.skills.length}` : "–"}</td>
                  <td><Toggle id={`sk-att-${a.id}`} checked={pos >= 0} decision={perm} label={`Attach ${sk.name} to ${a.name} (draft)`} onChange={(v) => { void attach.run(a.id, v); }} /></td>
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
  const setProj = useCommand((v: "all" | string[]) => ops.setSkillProjects(sk.id, v));
  const perm = dec(useCan("skill.edit"));
  const projects = (useProjects().data ?? []).filter((p) => p.status !== "archived");
  const all = sk.projects === "all";
  const setProjects = (v: "all" | string[]) => { void setProj.run(v); };
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


/** New and Edit skill: one dialog with the four prototype fields. Saving an existing skill cuts a new version (If-Match on the revision shown). */
function SkillDialog({ sk, close }: { sk: SkillRow | null; close: () => void }) {
  const ui_ = useUI();
  const perm = dec(useCan("skill.edit"));
  const [f, setF] = useState({ name: sk?.name ?? "", desc: sk?.desc ?? "", when: sk?.when ?? "", body: sk?.body ?? "" });
  const [err, setErr] = useState<Partial<Record<keyof typeof f, string>>>({});
  const [fail, setFail] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const check = (): boolean => {
    const e: typeof err = {};
    const req = (k: keyof typeof f, label: string, min = 0) => {
      const v = f[k].trim();
      if (!v) e[k] = `${label} is required.`; else if (min && v.length < min) e[k] = `${label} needs at least ${min} characters.`;
    };
    req("name", "Name", 3); req("desc", "What it does"); req("when", "When to use"); req("body", "Instructions", 20);
    setErr(e);
    return !Object.keys(e).length;
  };
  const submit = (done: () => void) => {
    if (!check()) return;
    const body = { name: f.name.trim(), desc: f.desc.trim(), when: f.when.trim(), body: f.body };
    const p = sk
      ? (() => { const patch: Record<string, unknown> = {}; (Object.keys(body) as Array<keyof typeof body>).forEach((k) => { if (body[k] !== sk[k]) patch[k] = body[k]; }); return Object.keys(patch).length ? ops.saveSkill(sk.id, patch, `Edited ${Object.keys(patch).join(", ")}`, { ifMatch: sk.rev }) : Promise.resolve({ ok: true as const, msg: "Nothing changed." }); })()
      : ops.saveSkill(null, { ...body, resources: [] });
    void p.then((r) => {
      if (!r.ok) { setFail(r.msg); return; }
      ui_.toast("Skill saved", "ok");
      invalidateSlices(["skills"]);
      done();
    });
  };
  return (
    <Dialog title={sk ? "Edit skill" : "New skill"} wide onClose={close}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what="Skills" />
          <Field label="Name" required htmlFor="sk-name" error={err.name}><input id="sk-name" className="input" value={f.name} onChange={set("name")} /></Field>
          <Field label="What it does" required htmlFor="sk-desc" error={err.desc}><input id="sk-desc" className="input" value={f.desc} onChange={set("desc")} /></Field>
          <Field label="When to use" required htmlFor="sk-when" error={err.when}><input id="sk-when" className="input" value={f.when} onChange={set("when")} /></Field>
          <Field label="Instructions" required htmlFor="sk-body" error={err.body}><textarea id="sk-body" className="input mono" rows={7} value={f.body} onChange={set("body")} /></Field>
          <div className="form-err" role="alert">{fail}</div>
        </div>
      )}
      actions={[{ label: "Cancel" }, { label: "Save", kind: "primary", submit: true, id: "sk-save", guard: perm, onClick: submit }]} />
  );
}

/** The skill drawer: when, owner, used by, the body, and (beyond the prototype) where it is attached and enabled and its versions. */
function SkillDrawer({ sk, agents, close, onEdit }: { sk: SkillRow; agents: AgentRow[]; close: () => void; onEdit: () => void }) {
  const actor = useActors();
  const perm = dec(useCan("skill.edit"));
  const users = agents.filter((a) => a.skills.includes(sk.id));
  return (
    <>
      <header>
        <div style={{ minWidth: 0 }}>
          <div className="micro">SKILL</div>
          <h2>{sk.name}</h2>
          <div className="muted small">{sk.desc}</div>
        </div>
        <IconBtn icon="x" label="Close" className="btn ghost icon drawer-close" onClick={close} />
      </header>
      <div className="body">
        <div className="stack">
          <dl className="kv">
            <dt>When</dt><dd>{sk.when}</dd>
            <dt>Owner</dt><dd>{ownerName(actor, sk.owner)}</dd>
            <dt>Used by</dt><dd>{users.map((a) => a.name).join(", ") || "—"}</dd>
          </dl>
          <pre className="pre">{sk.body}</pre>
          <details className="sk-more">
            <summary>Agents, projects and versions</summary>
            <h3 className="sub-h">Agents</h3>
            <AgentsTab sk={sk} agents={agents} />
            <h3 className="sub-h">Projects</h3>
            <ProjectsTab sk={sk} agents={agents} />
            <h3 className="sub-h">Versions</h3>
            <VersionsTab sk={sk} />
          </details>
        </div>
      </div>
      <footer><Btn label="Edit" id="sk-drawer-edit" guard={perm} onClick={onEdit} /></footer>
    </>
  );
}

export default function SkillsView() {
  useSkillsUi();
  const ui_ = useUI();
  const route = useHash();
  const q = useSkills();
  const skills = (q.data ?? []) as SkillRow[];
  const agentData = useAgents().data;
  const agents = useMemo(() => (agentData ?? []) as unknown as AgentRow[], [agentData]);
  const perm = dec(useCan("skill.edit"));
  const wanted = route.id === "skills" ? route.param : null;
  const sel = wanted ? skills.find((s) => s.id === wanted) ?? null : null;
  const edit = (sk: SkillRow | null) => ui_.open((close) => <SkillDialog sk={sk} close={close} />);

  // `#skills/<id>` is the open drawer: closing it (X, Esc, scrim) puts the URL back to `#skills`.
  useEffect(() => {
    if (!sel) return;
    // a tick later: the route change that brought us here also closes any open drawer
    const t = setTimeout(() => ui_.drawer.open(`skill:${sel.id}`, (close) => <SkillDrawer sk={sel} agents={agents} close={close} onEdit={() => { close(); edit(sel); }} />, () => replaceHash(hashFor("skills"))), 0);
    return () => clearTimeout(t);
    // reopen when the skill or the agents it is used by change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.id, sel?.rev, agents]);

  const sub = "Reusable know-how that agents load when a task calls for it.";
  const newBtn = <Btn label="New skill" kind="primary" icon="plus" id="sk-new" guard={perm} onClick={() => edit(null)} />;
  if (q.data === undefined) return <div className="view view-skills"><ViewHead title="Skills" kicker="All lines" sub={sub} actions={newBtn} /><Async query={q} what="skills" id="skills">{() => null}</Async></div>;
  return (
    <div className="view view-skills">
      <ViewHead title="Skills" kicker="All lines" sub={sub} actions={newBtn} />
      {wanted && !sel ? <Panel><Empty title="Nothing to show" text="That skill does not exist." action={<Btn label="Skills" id="sk-back" onClick={() => navigate("skills")} />} /></Panel> : null}
      <Library skills={skills} agents={agents} onEdit={edit} />
    </div>
  );
}
