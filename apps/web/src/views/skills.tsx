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
import { Async, useCommand } from "../ui/async";
import { Btn, Chip, Empty, Field, FilterBar, LockNote, Panel, SearchBox, Select, Stat, StatRow, Tabs, Toggle, ViewHead, Who, type Decision } from "../ui/primitives";
import { DataTable, type SortCol } from "../ui/SortTable";
import { Dialog } from "../ui/Overlay";
import { Icon } from "../ui/Icon";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { hashFor, navigate, useHash } from "../lib/router";
import { useCrumbTail } from "../lib/crumb";
import { useOutcome } from "./govern/data";
import { useDraft } from "../lib/useDraft";
import { DraftDot } from "../ui/DraftDot";
import { useLeaveGuard } from "../lib/useLeaveGuard";
import { DraftConflictBanner } from "../ui/DraftConflict";
import { invalidateSlices } from "../api/keys";
import { agentsSelect, EntityHistory, useStations, type AgentRow } from "./agents/kit";

type SkillRow = Skill & { rev: number };
const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

/* screen state, kept across tabs and screens like legacy `ui` */
const ui = { sel: null as string | null, tab: "def", note: "", q: "", filter: "all" };
let tick = 0;
const listeners = new Set<() => void>();
const rerender = (): void => { tick++; listeners.forEach((l) => l()); };
const useSkillsUi = (): number => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => tick);
/** Other screens (learning, agents) open a skill. */
export const skillsSelect = (id: string, tab?: string): void => { ui.sel = id; ui.note = ""; if (tab) ui.tab = tab; rerender(); navigate("skills", id); };

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

type SkillView = "all" | "unused" | "lowcov";

/** The library: view tabs with counts, a filter bar and one table. A row opens the skill's own page. */
function Library({ skills, agents }: { skills: SkillRow[]; agents: AgentRow[] }) {
  const actor = useActors();
  const usedBy = (id: string) => agents.filter((a) => a.skills.includes(id) || (a.liveSkills ?? []).some((l) => l.id === id));
  const q = ui.q.trim().toLowerCase();
  const views: Array<{ id: SkillView; label: string; test: (sk: SkillRow) => boolean }> = [
    { id: "all", label: "All", test: () => true },
    { id: "unused", label: "Unused", test: (sk) => !usedBy(sk.id).length },
    { id: "lowcov", label: "Low coverage", test: (sk) => !(covPct(sk) >= 0.85 && sk.coverage.cases) },
  ];
  const inView = views.find((v) => v.id === ui.filter)?.test ?? views[0]!.test;
  const list = skills.filter((sk) => inView(sk) && (!q || `${sk.name} ${sk.desc} ${sk.when}`.toLowerCase().indexOf(q) >= 0));
  const open = (sk: SkillRow) => navigate("skills", sk.id);
  const cols: SortCol<SkillRow>[] = [
    { key: "name", label: "Skill", sort: (sk) => sk.name.toLowerCase(), render: (sk) => (
      <div className="sk-cell">
        <div className="row"><a className="rl ell sk-name" href={hashFor("skills", sk.id)} onClick={(e) => { e.preventDefault(); open(sk); }}>{sk.name}</a><DraftDot scope="skill" id={sk.id} />{sk.builtin ? <Chip text="built-in" /> : null}</div>
        <span className="dim ell" style={{ fontSize: 12 }} title={`Owner: ${actor(sk.owner).name.replace(" (agent)", "")}`}>{sk.desc}</span>
      </div>
    ) },
    { key: "projects", label: "Projects", render: (sk) => sk.projects === "all" ? "all projects" : sk.projects.length ? `${sk.projects.length} project${sk.projects.length > 1 ? "s" : ""}` : <span className="warn-text">no projects</span> },
    { key: "version", label: "Version", render: (sk) => <span className="mono">{`v${sk.version}`}</span> },
    { key: "used", label: "Used by", sort: (sk) => usedBy(sk.id).length, render: (sk) => { const u = usedBy(sk.id); return u.length ? <span className="row nowrap">{u.map((a) => <span key={a.id} className="tag">{a.name}</span>)}</span> : <span className="dim">{"\u2014"}</span>; } },
    { key: "cov", label: "Eval coverage", sort: (sk) => covPct(sk), render: (sk) => <CovCell sk={sk} /> },
  ];
  return (
    <>
      <FilterBar label="Filter skills" count={`${list.length} of ${skills.length}`}>
        <SearchBox id="sk-search" value={ui.q} onChange={(v) => { ui.q = v; rerender(); }} placeholder="Search skills" label="Filter skills" />
        <Select id="sk-view" aria-label="View" value={ui.filter} onChange={(t) => { ui.filter = t as SkillView; rerender(); }} options={views.map((v) => ({ value: v.id, label: `View: ${v.label} (${skills.filter(v.test).length})` }))} />
      </FilterBar>
      <DataTable id="sk-lib" caption="Skills" columns={cols} rows={list} rowKey={(sk) => sk.id} rowId={(sk) => `sk-row-${sk.id}`} onRow={open} pageSize={12} empty={{ title: "No skills match", text: "Clear the filter to see the whole library." }} />
    </>
  );
}

function DefTab({ sk, perm }: { sk: SkillRow; perm: Decision }) {
  const out = useOutcome();
  const ro = !perm.allowed;
  const saved = { name: sk.name, desc: sk.desc, when: sk.when, body: sk.body, resources: sk.resources.join("\n") };
  // Only the keys changed here are sent, with the revision this draft started from; a colleague's edit to the same field is a conflict, never a silent overwrite.
  const draft = useDraft<typeof saved>({
    scope: "skill", id: sk.id, server: saved, rev: sk.rev,
    save: (p, ifMatch) => {
      const patch: Record<string, unknown> = { ...p };
      if (typeof p.name === "string") patch.name = p.name.trim();
      if (typeof p.resources === "string") patch.resources = p.resources.split("\n").map((x) => x.trim()).filter(Boolean);
      return ops.saveSkill(sk.id, patch, ui.note.trim() || `Edited ${Object.keys(patch).join(", ")}`, { ifMatch });
    },
    refresh: () => invalidateSlices(["skills"]),
  });
  const d = draft.values;
  const dirty = draft.dirty;
  useLeaveGuard(dirty);
  const next = sk.version.split(".").map(Number);
  next[1] = (next[1] ?? 0) + 1;
  next[2] = 0;
  const inp = (id: string, key: keyof typeof saved, rows?: number, ph?: string) => {
    const set = (v: string) => draft.set(key, v);
    return rows
      ? <textarea id={id} className={`input${key === "body" || key === "resources" ? " mono" : ""}`} rows={rows} disabled={ro} placeholder={ph ?? ""} value={d[key]} onChange={(e) => set(e.target.value)} />
      : <input id={id} className="input" disabled={ro} placeholder={ph ?? ""} value={d[key]} onChange={(e) => set(e.target.value)} />;
  };
  const save = () => {
    if (!dirty) { out({ ok: true, msg: "Nothing changed.", status: 200 }); return; }
    if (!d.name.trim()) { out({ ok: false, msg: "Name the skill.", status: 422 }); return; }
    void draft.save().then((r) => { if (r) { out(r); if (r.ok) { ui.note = ""; rerender(); } } });
  };
  return (
    <div className="sk-def">
      <div className="form-grid">
        <Field label="Name" htmlFor="sk-name">{inp("sk-name", "name")}</Field>
        <Field label="Description" htmlFor="sk-desc" hint="One sentence. Shown to agents when they choose a skill.">{inp("sk-desc", "desc", 2)}</Field>
        <Field label="When to use" htmlFor="sk-when">{inp("sk-when", "when", 2)}</Field>
        <Field label="Body" htmlFor="sk-body" hint="The instructions the agent loads when the skill applies.">{inp("sk-body", "body", 7)}</Field>
        <Field label="Resources" htmlFor="sk-res" hint="One file name per line. Files ship with the skill.">{inp("sk-res", "resources", 3, "checklist.md")}</Field>
        <Field label="Change note" htmlFor="sk-note" hint={`Saving creates v${next.join(".")}. It reaches no agent by itself: each agent that runs this skill gets a candidate version, which goes live after its eval suite passes and a person promotes it.`}>
          <input id="sk-note" className="input" disabled={ro} placeholder="What changed, in one line" value={ui.note} onChange={(e) => { ui.note = e.target.value; rerender(); }} />
        </Field>
      </div>
      <DraftConflictBanner id="sk-conflict" conflict={draft.conflict} onKeepMine={draft.keepMine} onDiscard={draft.discard} />
      <div className={`savebar${dirty ? " is-dirty" : ""}`} id="sk-savebar">
        <span className="muted small savebar-text">Every save is a new version with your note.</span>
        <Btn label="Discard" id="sk-discard" guard={ro ? perm : null} onClick={draft.discard} />
        <Btn label={`Save as v${next.join(".")}`} kind="primary" id="sk-save" guard={ro ? perm : null} onClick={save} />
      </div>
    </div>
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

function Detail({ sk, agents }: { sk: SkillRow; agents: AgentRow[] }) {
  const actor = useActors();
  const perm = dec(useCan("skill.edit"));
  const users = agents.filter((a) => a.skills.includes(sk.id));
  const suites = [...new Set(users.map((a) => a.suite).filter(Boolean))];
  const tabs = [{ id: "def", label: "Definition" }, { id: "agents", label: "Agents", count: users.length }, { id: "projects", label: "Projects" }, { id: "versions", label: "Versions", count: sk.versions.length }];
  const body = ui.tab === "agents" ? <AgentsTab sk={sk} agents={agents} /> : ui.tab === "projects" ? <ProjectsTab sk={sk} agents={agents} /> : ui.tab === "versions" ? <VersionsTab sk={sk} /> : <DefTab sk={sk} perm={perm} />;
  return (
    <section className="sk-detail" id="sk-detail" aria-label={sk.name}>
      <a className="back-link" id="sk-back-link" href={hashFor("skills")} onClick={(e) => { e.preventDefault(); navigate("skills"); }}><Icon name="back" />All skills</a>
      <ViewHead kicker={`Skill · ${sk.id}${sk.builtin ? " · built-in" : ""}`} title={sk.name} sub={sk.desc} />
      <StatRow id="sk-stats">
        <Stat label="Version" value={<span className="mono">{`v${sk.version}`}</span>} />
        <Stat label="Owner" value={actor(sk.owner).name.replace(" (agent)", "")} />
        <Stat label="Used by" value={`${users.length} agent${users.length === 1 ? "" : "s"}`} />
        <Stat label="Coverage" value={<CovCell sk={sk} />} />
        <Stat label="Suites" value={<span className="mono small">{suites.join(", ") || "none"}</span>} />
      </StatRow>
      <LockNote decision={perm} what="Skill text" />
      <div className="panel sk-panel">
        <Tabs idPrefix="sk-tab" items={tabs} active={ui.tab} onChange={(t) => { ui.tab = t; rerender(); }} />
        <div className="sk-body">{body}</div>
      </div>
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
              if (created) { ui.sel = created.id; ui.tab = "def"; rerender(); navigate("skills", created.id); }
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
  const route = useHash();
  const q = useSkills();
  const skills = (q.data ?? []) as SkillRow[];
  const agents = (useAgents().data ?? []) as unknown as AgentRow[];
  const perm = dec(useCan("skill.edit"));
  const wanted = route.id === "skills" ? route.param : null;
  useCrumbTail(wanted ? skills.find((s) => s.id === wanted)?.name : null);
  const sub = "Reusable know-how attached to agents. A skill is text plus a version, so a change to it is a reviewed edit, not a code change.";
  const newBtn = <Btn label="New skill" kind="primary" icon="plus" id="sk-new" guard={perm} onClick={() => ui_.open((close) => <NewSkill agents={agents} close={close} />)} />;
  if (q.data === undefined) return <div className="view view-skills"><ViewHead kicker="Workforce" title="Skills" sub={sub} actions={newBtn} /><Async query={q} what="skills" id="skills">{() => null}</Async></div>;
  if (!skills.length) return <div className="view view-skills"><ViewHead kicker="Workforce" title="Skills" sub={sub} actions={newBtn} /><Empty title="No skills yet" text="Create the first skill." /></div>;
  if (wanted) {
    const current = skills.find((s) => s.id === wanted);
    if (!current) {
      return (
        <div className="view view-skills">
          <ViewHead title="Skill not found" sub="This skill does not exist, or it was removed." />
          <Empty title="No skill with that id" text="Pick one from the library." action={<Btn label="Back to skills" icon="back" id="sk-back" onClick={() => navigate("skills")} />} />
        </div>
      );
    }
    ui.sel = current.id;
    return <div className="view view-skills"><Detail sk={current} agents={agents} /></div>;
  }
  return (
    <div className="view view-skills">
      <ViewHead kicker="Workforce" title="Skills" sub={sub} actions={newBtn} />
      <Library skills={skills} agents={agents} />
    </div>
  );
}
