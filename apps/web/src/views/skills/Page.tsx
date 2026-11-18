/** The skill page (`#skills/<id>?page=1`): Definition, Agents, Projects and Versions tabs, in the prototype's header, stat row and tab strip. */
import { fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import { useProjects } from "../../api/queries";
import { commands } from "../../api/commands";
import { hashFor, navigate } from "../../lib/router";
import { useRouteTab } from "../../lib/routeQuery";
import { useActors } from "../../ui/actors";
import { useCommand } from "../../ui/async";
import { Btn, Chip, LockNote, Panel, Stat, StatRow, Tabs, Toggle, ViewHead, type Decision } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/SortTable";
import type { Skill } from "@gantry/domain";
import type { AgentRow } from "../agents/kit";

type SkillRow = Skill & { rev: number };
const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });
const ownerName = (actor: ReturnType<typeof useActors>, id: string): string => actor(id).name.replace(" (agent)", "");

function AgentsTab({ sk, agents }: { sk: SkillRow; agents: AgentRow[] }) {
  const attach = useCommand((agent: string, on: boolean) => commands.attachSkill(agent, sk.id, on));
  const perm = dec(useCan("agent.edit"));
  const cols: SortCol<AgentRow>[] = [
    { key: "a", label: "Agent", render: (a) => <a className="pri" href={hashFor("agents", a.id)} onClick={(e) => { e.preventDefault(); navigate("agents", a.id); }}>{a.name}</a> },
    { key: "live", label: "Runs with", render: (a) => { const l = (a.liveSkills ?? []).find((x) => x.id === sk.id); return l ? <Chip text={l.version ? `Live ${a.version} · skill v${l.version}` : `Live ${a.version}`} cls="ok" /> : <span className="muted small">Not in the live version</span>; } },
    { key: "on", label: "Attached in draft", align: "end", render: (a) => <Toggle id={`sk-att-${a.id}`} checked={a.skills.includes(sk.id)} decision={perm} label={`Attach ${sk.name} to ${a.name} (draft)`} onChange={(v) => { void attach.run(a.id, v); }} /> },
  ];
  return (
    <Panel title="Agents" flush>
      <LockNote decision={perm} what="Attaching skills to agents" />
      <DataTable id="sk-agents" caption="Agents that can use this skill" columns={cols} rows={agents} rowKey={(a) => a.id} pageSize={12} pager sortSelect={false} />
    </Panel>
  );
}

function ProjectsTab({ sk, agents }: { sk: SkillRow; agents: AgentRow[] }) {
  const setProj = useCommand((v: "all" | string[]) => commands.setSkillProjects(sk.id, v));
  const perm = dec(useCan("skill.edit"));
  const projects = (useProjects().data ?? []).filter((p) => p.status !== "archived");
  const all = sk.projects === "all";
  const list = all ? [] : (sk.projects as string[]);
  return (
    <Panel title="Projects">
      <LockNote decision={perm} what="Where this skill is enabled" />
      <p className="muted small">An attached skill is loaded only on projects where it is enabled. Changing this does not create a new version.</p>
      <div className="row" style={{ padding: "8px 0" }}>
        <label htmlFor="sk-proj-all"><strong>All projects</strong><span className="muted small"> including projects created later</span></label>
        <span className="spacer" />
        <Toggle id="sk-proj-all" checked={all} decision={perm} label="Enable on all projects" onChange={(v) => { void setProj.run(v ? "all" : projects.map((p) => p.id)); }} />
      </div>
      {projects.map((p) => {
        const users = agents.filter((a) => a.skills.includes(sk.id) && (a.projects === "all" || a.projects.includes(p.id)));
        const lock: Decision | null = !perm.allowed ? perm : all ? { allowed: false, needs: "", reason: "Enabled on all projects. Turn off All projects to choose." } : null;
        return (
          <div key={p.id} className="row" style={{ padding: "6px 0", borderTop: "1px dotted var(--line)" }}>
            <span>{p.name}<span className="sub muted small" style={{ display: "block" }}>{users.length ? users.map((a) => a.name).join(", ") : "No agent uses it here"}</span></span>
            <span className="spacer" />
            <Toggle id={`sk-proj-${p.id}`} checked={all || list.includes(p.id)} decision={lock} label={`Enable on ${p.name}`} onChange={(v) => { void setProj.run(v ? [...list, p.id] : list.filter((x) => x !== p.id)); }} />
          </div>
        );
      })}
    </Panel>
  );
}

export function SkillPage({ sk, agents, onEdit }: { sk: SkillRow; agents: AgentRow[]; onEdit: () => void }) {
  const actor = useActors();
  const perm = dec(useCan("skill.edit"));
  const [tab, setTab] = useRouteTab(["def", "agents", "projects", "versions"], "def");
  const users = agents.filter((a) => a.skills.includes(sk.id));
  const vers = sk.versions.slice().reverse();
  const vcols: SortCol<(typeof vers)[number]>[] = [
    { key: "v", label: "Version", render: (v) => <span className="mono">v{v.v}{v.v === vers[0]?.v ? <> <Chip text="current" cls="info" /></> : null}</span> },
    { key: "at", label: "Date", render: (v) => fmt.stamp(v.at) },
    { key: "by", label: "By", render: (v) => ownerName(actor, v.by) },
    { key: "n", label: "Change", render: (v) => v.note },
  ];
  return (
    <section className="sk-detail" id="sk-detail" aria-label={sk.name}>
      <ViewHead crumbs={[{ label: "Skills", href: hashFor("skills"), onClick: () => navigate("skills") }, { label: sk.name }]} title={sk.name} sub={sk.desc}
        actions={<Btn label="Edit" id="sk-page-edit" guard={perm} onClick={onEdit} />} />
      <StatRow id="sk-stats">
        <Stat label="Version" value={`v${sk.version}`} />
        <Stat label="Owner" value={ownerName(actor, sk.owner)} />
        <Stat label="Used by" value={`${users.length} agent${users.length === 1 ? "" : "s"}`} />
        <Stat label="Projects" value={sk.projects === "all" ? "All" : String(sk.projects.length)} />
      </StatRow>
      <Tabs idPrefix="sk-tab" active={tab} onChange={setTab} items={[{ id: "def", label: "Definition" }, { id: "agents", label: "Agents", count: users.length }, { id: "projects", label: "Projects" }, { id: "versions", label: "Versions", count: sk.versions.length }]} />
      <div className="stack">
        {tab === "agents" ? <AgentsTab sk={sk} agents={agents} />
          : tab === "projects" ? <ProjectsTab sk={sk} agents={agents} />
          : tab === "versions" ? <Panel title="Versions" flush><DataTable id="sk-vers" caption="Skill versions" columns={vcols} rows={vers} rowKey={(v) => v.v} pageSize={12} pager sortSelect={false} /></Panel>
          : (
            <Panel title="Definition">
              <dl className="kv"><dt>When to use</dt><dd>{sk.when}</dd><dt>Owner</dt><dd>{ownerName(actor, sk.owner)}</dd></dl>
              <pre className="pre">{sk.body}</pre>
            </Panel>
          )}
      </div>
    </section>
  );
}
