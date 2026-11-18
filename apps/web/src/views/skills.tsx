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
import { Btn, Chip, Field, IconBtn, FilterBar, LockNote, SearchBox, Select, Tabs, Toggle, Who, type Decision } from "../ui/primitives";
import { CrEmpty, Page, Stats } from "../ui/cr";
import { useRouteState, useDebouncedParam } from "../lib/routeState";
import { NotFoundPage } from "./NotFound";
import { DataTable, type SortCol } from "../ui/DataTable";
import { Dialog } from "../ui/Overlay";
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
const NA = "not available";
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

const cap = (x: string): string => x.charAt(0).toUpperCase() + x.slice(1);
const enabledOf = (sk: SkillRow): boolean => sk.projects === "all" || sk.projects.length > 0;

/** The skill drawer (prototype `skopen`): description, key facts, the skill file; the full page (definition, agents, projects, versions) is one button away. */
function SkillDrawer({ sk, agents, stations, close }: { sk: SkillRow; agents: AgentRow[]; stations: string; close: () => void }) {
  const ui_ = useUI();
  const users = agents.filter((a) => a.skills.includes(sk.id) || (a.liveSkills ?? []).some((l) => l.id === sk.id));
  const updated = sk.versions[sk.versions.length - 1]?.at;
  return (
    <div className="drawer-inner" id="sk-drawer">
      <div className="drawer-h">
        <div><div className="eyebrow">{`Skill \u00b7 v${sk.version}`}</div><h2>{sk.name}</h2></div>
        <IconBtn icon="x" label="Close" className="drawer-close" onClick={close} />
      </div>
      <div className="drawer-b">
        <p>{sk.desc}</p>
        <dl className="kv">
          <dt>Station</dt><dd>{stations || "\u2014"}</dd>
          <dt>Uses</dt><dd className="mono dim">{NA}</dd>
          <dt>Updated</dt><dd>{updated ? fmt.ago(updated, Date.now()) : "\u2014"}</dd>
          <dt>Agents</dt><dd>{users.length ? <span className="row">{users.map((a) => <span key={a.id} className="tag">{a.name}</span>)}</span> : "\u2014"}</dd>
        </dl>
        <div className="label">Skill file</div>
        <pre className="code" style={{ fontSize: 12 }}>{`---\nname: ${sk.id}\n---\n# ${sk.name}\n\n${sk.body || sk.desc}`}</pre>
      </div>
      <div className="drawer-f">
        <Btn label="Skill page" id="sk-drawer-page" onClick={() => { close(); navigate("skills", sk.id); }} />
        <Btn label="Close" onClick={close} />
        <Btn label="Edit draft" kind="primary" id="sk-drawer-edit" onClick={() => ui_.toast(`Opened a draft of ${sk.name}`, "info")} />
      </div>
    </div>
  );
}

/** The library (prototype `skills`): search, Station select and the table; state in the URL (?q ?station ?sort ?dir). */
function Library({ skills, agents }: { skills: SkillRow[]; agents: AgentRow[] }) {
  const ui_ = useUI();
  const st = useStations();
  const perm = dec(useCan("skill.edit"));
  const toggle = useCommand((sk: SkillRow, on: boolean) => ops.setSkillProjects(sk.id, on ? "all" : []), { ok: false });
  const [r, setR] = useRouteState({ q: "", station: "", sort: "name", dir: "asc" });
  const [qText, setQText] = useDebouncedParam(r.q, (v) => setR({ q: v }));
  const usedBy = (id: string) => agents.filter((a) => a.skills.includes(id) || (a.liveSkills ?? []).some((l) => l.id === id));
  /** The backend has no station on a skill: it is the station of the agents that use it. */
  const stationsOf = (id: string): string[] => [...new Set(usedBy(id).map((a) => a.station).filter((x): x is string => !!x))];
  const stationName = (id: string): string => cap(id);
  const term = qText.trim().toLowerCase();
  const list = skills.filter((sk) => (!r.station || stationsOf(sk.id).includes(r.station)) && (!term || `${sk.name} ${sk.desc} ${sk.id}`.toLowerCase().includes(term)));
  const open = (sk: SkillRow): void => ui_.drawer.open(`skill:${sk.id}`, (close) => <SkillDrawer sk={sk} agents={agents} stations={stationsOf(sk.id).map(stationName).join(", ")} close={close} />);
  const any = !!(r.q || r.station);
  const clear = (): void => { setQText(""); setR({ q: "", station: "" }); };
  const cols: SortCol<SkillRow>[] = [
    { key: "name", label: "Skill", sort: (sk) => sk.name.toLowerCase(), render: (sk) => (
      <span className="stack" style={{ gap: 0 }}>
        <span className="row"><a className="rl ell sk-name" href={hashFor("skills", sk.id)} onClick={(e) => { e.preventDefault(); open(sk); }}>{sk.name}</a><DraftDot scope="skill" id={sk.id} /></span>
        <span className="dim ell" style={{ fontSize: 12 }}>{sk.desc}</span>
      </span>
    ) },
    { key: "station", label: "Station", sort: (sk) => stationsOf(sk.id)[0] ?? "~", render: (sk) => { const s = stationsOf(sk.id); return s.length ? <span>{s.map(stationName).join(", ")}</span> : <span className="dim">{"\u2014"}</span>; } },
    { key: "agents", label: "Used by", render: (sk) => { const u = usedBy(sk.id); return u.length ? <span className="row nowrap">{u.map((a) => <span key={a.id} className="tag">{a.name}</span>)}</span> : <span className="dim">{"\u2014"}</span>; } },
    { key: "version", label: "Version", sort: (sk) => sk.version, render: (sk) => <span className="mono">{sk.version}</span> },
    { key: "uses", label: "Uses", align: "end", sort: () => 0, render: () => <span className="mono dim">{NA}</span> },
    { key: "en", label: "Enabled", render: (sk) => <Toggle id={`sk-en-${sk.id}`} checked={enabledOf(sk)} label={`${sk.name} enabled`} decision={perm} onChange={(on) => { void toggle.run(sk, on).then((x) => { if (x?.ok) ui_.toast(`${on ? "Enabled" : "Disabled"} ${sk.name}`, "ok"); }); }} /> },
  ];
  const stOpts = [...st.all.map((s) => ({ value: s.id, label: s.name })), { value: "onboarding", label: "Onboarding" }];
  return (
    <>
      <FilterBar label="Filter skills" count={`${list.length} of ${skills.length}`} actions={any ? <Btn label="Clear" small kind="ghost" id="sk-clear" onClick={clear} /> : undefined}>
        <SearchBox id="sk-search" value={qText} onChange={setQText} placeholder="Search skills" label="Filter skills" />
        <Select id="sk-f-station" aria-label="Station" value={r.station} onChange={(v) => setR({ station: v })} options={[{ value: "", label: "Station: all" }, ...stOpts]} />
      </FilterBar>
      <DataTable id="sk-lib" caption="Skills" columns={cols} rows={list} rowKey={(sk) => sk.id} rowId={(sk) => `sk-row-${sk.id}`} pageSize={12} pager
        sort={{ key: r.sort, dir: r.dir === "desc" ? -1 : 1 }} onSort={(x) => setR({ sort: x.key, dir: x.dir === -1 ? "desc" : "asc" })}
        empty={{ title: "Nothing matches", text: "Try clearing a filter or searching for something else.", action: <Btn label="Clear filters" id="sk-empty-clear" onClick={clear} /> }} />
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
  const [route, setRoute] = useRouteState({ tab: "def" });
  const users = agents.filter((a) => a.skills.includes(sk.id));
  const suites = [...new Set(users.map((a) => a.suite).filter(Boolean))];
  const tabs = [{ id: "def", label: "Definition" }, { id: "agents", label: "Agents", count: users.length }, { id: "projects", label: "Projects" }, { id: "versions", label: "Versions", count: sk.versions.length }];
  const tab = tabs.some((t) => t.id === route.tab) ? route.tab : "def";
  const body = tab === "agents" ? <AgentsTab sk={sk} agents={agents} /> : tab === "projects" ? <ProjectsTab sk={sk} agents={agents} /> : tab === "versions" ? <VersionsTab sk={sk} /> : <DefTab sk={sk} perm={perm} />;
  return (
    <Page id="sk-detail" eyebrow={`Workforce \u00b7 Skill${sk.builtin ? " \u00b7 built-in" : ""}`} title={sk.name} sub={sk.desc} cls="sk-detail"
      acts={<Btn label="All skills" id="sk-back-link" onClick={() => navigate("skills")} />}>
      <Stats id="sk-stats" items={[
        { l: "Version", v: <span className="mono">{sk.version}</span> },
        { l: "Owner", v: actor(sk.owner).name.replace(" (agent)", "") },
        { l: "Used by", v: `${users.length} agent${users.length === 1 ? "" : "s"}`, tone: "agent" },
        { l: "Coverage", v: <CovCell sk={sk} />, tone: "ok" },
        { l: "Suites", v: <span className="mono small">{suites.join(", ") || "none"}</span> },
      ]} />
      <LockNote decision={perm} what="Skill text" />
      <Tabs idPrefix="sk-tab" items={tabs} active={tab} onChange={(t) => setRoute({ tab: t })} />
      <div className="sk-body">{body}</div>
    </Page>
  );
}

function NewSkill({ close }: { close: () => void }) {
  const ui_ = useUI();
  const st = useStations();
  const perm = dec(useCan("skill.edit"));
  const [f, setF] = useState({ name: "", station: "", desc: "" });
  const [err, setErr] = useState<{ name?: string; desc?: string; form?: string }>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const station = f.station || st.all[0]?.id || "";
  return (
    <Dialog title="New skill" onClose={close} dirty={!!(f.name || f.desc)}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what="Creating skills" />
          <Field label="Name (required)" htmlFor="sk-new-name" error={err.name}><input id="sk-new-name" className="input" value={f.name} onChange={set("name")} aria-invalid={err.name ? true : undefined} /></Field>
          <Field label="Station" htmlFor="sk-new-station">
            <Select id="sk-new-station" value={station} options={st.all.map((s) => ({ value: s.id, label: s.name }))} onChange={(v) => setF((x) => ({ ...x, station: v }))} />
          </Field>
          <Field label="What it teaches (required)" htmlFor="sk-new-desc" error={err.desc}><textarea id="sk-new-desc" className="input" rows={4} value={f.desc} onChange={set("desc")} aria-invalid={err.desc ? true : undefined} /></Field>
          <div className="form-err" role="alert">{err.form ?? ""}</div>
        </div>
      )}
      actions={[
        { label: "Cancel" },
        {
          label: "Create draft", kind: "primary", submit: true, id: "sk-new-ok", guard: perm,
          onClick: (done) => {
            const name = f.name.trim();
            const desc = f.desc.trim();
            const e: typeof err = {};
            if (!name) e.name = "Name is required."; else if (name.length < 3) e.name = "Name needs at least 3 characters.";
            if (!desc) e.desc = "Describe what it teaches."; else if (desc.length < 10) e.desc = "Say a little more: at least 10 characters.";
            setErr(e);
            if (e.name || e.desc) { document.getElementById(e.name ? "sk-new-name" : "sk-new-desc")?.focus(); return; }
            void ops.saveSkill(null, { name, desc, when: "", body: desc, resources: [] }).then((r) => {
              if (!r.ok) { setErr({ form: r.msg }); return; }
              ui_.toast("Draft created", "ok");
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
  const sub = "Reusable know-how that agents load. Versioned, reviewed, and measured by evals.";
  const newBtn = <Btn label="New skill" kind="primary" icon="plus" id="sk-new" guard={perm} onClick={() => ui_.open((close) => <NewSkill close={close} />)} />;
  const head = (children: React.ReactNode) => <Page eyebrow="Workforce" title="Skills" sub={sub} acts={newBtn} cls="view-skills">{children}</Page>;
  if (q.data === undefined) return head(<Async query={q} what="skills" id="skills">{() => null}</Async>);
  if (wanted) {
    const current = skills.find((s) => s.id === wanted);
    if (!current) return <NotFoundPage what="skill" />;
    ui.sel = current.id;
    return <Detail sk={current} agents={agents} />;
  }
  if (!skills.length) return head(<div className="card"><CrEmpty title="Nothing here yet" text="Create the first skill." action={<Btn label="New skill" kind="primary" icon="plus" id="skills-empty-new" guard={perm} onClick={() => ui_.open((close) => <NewSkill close={close} />)} />} /></div>);
  return head(<Library skills={skills} agents={agents} />);
}
