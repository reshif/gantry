/**
 * People & teams (spec 8.9). Port of legacy/js/views/people.js: org tree, member detail with factory role, roles per
 * project, effective permissions (decided by the server's can(), compact cells) and history.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fmt, type Person, type Project, type Role, type Team } from "@gantry/domain";
import { api, get } from "../api/client";
import { ops } from "../api/ops";
import { useAccessMatrix, useMe, usePeople, useProjects } from "../api/queries";
import { useCan } from "../api/can";
import { navigate } from "../lib/router";
import { ExplainDenial } from "./console/ExplainDenial";
import { Avatar, Btn, LockNote, Panel, Select, Toggle, ViewHead, Empty, type Decision } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import { Icon, Logo } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";
import { useActors } from "../ui/actors";
import { lockd, useAllRepos, useOutcome, useTeams } from "./govern/data";
import { useInviteDialog } from "./people/InviteDialog";
import { useTeamDialogs } from "./people/TeamDialog";
import { TeamRoles } from "./people/TeamRoles";
import { HistoryList } from "./people/History";
import type { EffectivePermissions } from "./people/types";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

export default function PeopleView() {
  const me = useMe();
  const peopleQ = usePeople();
  const teamsQ = useTeams();
  const people = peopleQ.data ?? [];
  const teams = teamsQ.data ?? [];
  const projects = useProjects().data ?? me?.projects ?? [];
  const matrix = useAccessMatrix().data;
  const { repos } = useAllRepos();
  const roles = matrix?.roles ?? [];
  const perm = dec(useCan("people.manage"));
  const view = dec(useCan("people.view"));
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const viewerId = me?.person.id ?? "";
  
  const selected = people.find((p) => p.id === sel) ?? people.find((p) => p.id === viewerId) ?? people[0];
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const admins = people.filter((p) => p.status === "active" && p.roles.some((g) => g.role === "factory_admin"));
  const sec = useQuery({ queryKey: ["security"], queryFn: () => get<{ domains: string[] }>(api("security")), retry: false });
  const invite = useInviteDialog({ perm, teams, projects: projects as Project[], roles, domains: sec.data?.domains ?? [], onDone: setSel });
  const teamDlg = useTeamDialogs(perm);

  if (!me) return null;
  // Default deny: the directory is itself a right. The server refuses the reads too; this shows why instead of an empty screen.
  if (!view.allowed) return <div className="view view-people"><ViewHead title="People & teams" sub="" /><Empty id="people-no-access" title="No access to people and teams" text={`${view.reason} ${view.needs ? `${view.needs}. ` : ""}Ask a Factory Admin or Project Admin to give you a role that can see people.`} /></div>;
  const invited = people.filter((p) => p.status === "invited").length;
  const org = me.org;

  return (
    <div className="view view-people">
      <ViewHead
        title="People & teams"
        sub="Teams group people. Roles are granted on the factory or on one project, so a person can be an Engineer here and a Reviewer there."
        meta={[["People", qState(peopleQ, () => String(people.length))], ["Teams", qState(teamsQ, () => String(teams.length))], ["Factory Admins", qState(peopleQ, () => String(admins.length))], ["Custom roles", String(roles.filter((r) => r.custom).length)], ["Invites pending", qState(peopleQ, () => String(invited))]]}
        actions={<><Btn label="Invite person" kind="primary" icon="plus" id="ppl-invite" guard={perm} onClick={() => invite()} /><Btn label="New team" icon="teams" id="ppl-team-new" guard={perm} onClick={teamDlg.create} /></>}
      />
      <LockNote decision={perm} what="Invites, teams and roles" />
      <p className="ppl-defaults muted small" id="ppl-defaults">
        <Icon name="shield" /> <strong>Default for new people: no access until granted.</strong> Give access to a team (every member inherits it while they are in it) or to one person. A person's effective roles are their own grants plus their teams' grants.
      </p>
      <Async query={peopleQ} what="people" id="ppl">{() => (
      <div className="people-grid">
        <Panel title="Organisation" cls="ppl-tree">
          <OrgTree people={people} teams={teams} projects={projects as Project[]} repos={repos} roles={roles} sel={selected?.id ?? null} onSel={setSel} q={q} setQ={setQ} perm={perm} invite={invite} teamDlg={teamDlg} orgName={org?.name ?? ""} plant={org?.plant ?? ""} />
        </Panel>
        {selected ? <MemberDetail key={selected.id} p={selected} teams={teams} projects={projects as Project[]} roles={roles} perm={perm} admins={admins} viewerId={viewerId} roleName={roleName} /> : <Empty title="No people yet" />}
      </div>
      )}</Async>
    </div>
  );
}

/* ---------- org tree ---------- */

function grantLabel(g: { role: string; scope: string; via?: string | undefined }, roleName: (id: string) => string, projects: Project[], teamName?: (id: string) => string): string {
  return `${roleName(g.role)} · ${g.scope === "factory" ? "Factory" : projects.find((p) => p.id === g.scope)?.name ?? g.scope}${g.via ? ` (via ${teamName ? teamName(g.via) : g.via})` : ""}`;
}

function Member({ p, teamId, sel, onSel, roleName, projects, teamName }: { p: Person; teamId: string; sel: string | null; onSel: (id: string) => void; roleName: (id: string) => string; projects: Project[]; teamName: (id: string) => string }) {
  const fr = p.roles.find((x) => x.scope === "factory" && !x.via);
  const summary = p.roles.length ? p.roles.map((g) => grantLabel(g, roleName, projects, teamName)).join(", ") : "No roles yet";
  return (
    <li>
      <button
        type="button"
        className={`member${sel === p.id ? " is-on" : ""}`}
        id={`ppl-mem-${teamId}-${p.id}`}
        aria-pressed={sel === p.id ? "true" : "false"}
        onClick={() => {
          onSel(p.id);
          if (window.innerWidth < 1100) setTimeout(() => document.querySelector(".member-detail")?.scrollIntoView?.({ block: "start" }), 60);
        }}
      >
        <Avatar id={p.id} size="sm" />
        <span className="member-main">
          <span className="ppl-name">{p.name}{fr ? <span className="ppl-frole">{roleName(fr.role)}</span> : null}</span>
          <span className="muted small">{summary}</span>
        </span>
        <span className="ppl-flags">
          {p.status === "invited" ? <span className="chip chip-warn"><Icon name="mail" />invited</span> : null}
          {p.oncall ? <span className="chip chip-accent"><Icon name="clock" />on call</span> : null}
          {p.away && p.away.to > Date.now() ? <span className="chip"><Icon name="swap" />away</span> : null}
        </span>
      </button>
    </li>
  );
}

function OrgTree({ people, teams, projects, repos, roles, sel, onSel, q, setQ, perm, invite, teamDlg, orgName, plant }: {
  people: Person[]; teams: Team[]; projects: Project[]; repos: Array<{ team: string }>; roles: Role[]; sel: string | null;
  onSel: (id: string) => void; q: string; setQ: (v: string) => void; perm: Decision; invite: (p: { team?: string }) => void; teamDlg: ReturnType<typeof useTeamDialogs>; orgName: string; plant: string;
}) {
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const matches = (p: Person) => {
    const s = q.trim().toLowerCase();
    return !s || `${p.name} ${p.email} ${p.title} ${p.roles.map((g) => grantLabel(g, roleName, projects)).join(" ")}`.toLowerCase().includes(s);
  };
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const noTeam = people.filter((p) => !p.teams?.length).filter(matches);
  return (
    <div className="org-tree">
      <div className="org-root">
        <Logo />
        <div><div className="kicker">{`Organisation · ${plant}`}</div><strong>{orgName}</strong></div>
        <span className="mono muted small">{`${people.length} people`}</span>
      </div>
      <div className="ppl-search">
        <input id="ppl-q" className="input" type="search" placeholder="Find a person, role or project" value={q} autoComplete="off" aria-label="Find a person" onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="teams">
        {teams.map((t) => {
          const members = people.filter((p) => (p.teams ?? []).includes(t.id));
          const shown = members.filter(matches);
          if (q && !shown.length) return null;
          const projs = projects.filter((p) => (p as Project & { teams?: string[] }).teams?.includes(t.id));
          const owns = repos.filter((r) => r.team === t.id);
          return (
            <li key={t.id} className="team">
              <div className="team-head">
                <h3 className="team-name">{t.name}<span className="mono muted ppl-count">{members.length}</span></h3>
                <span className="muted small">{t.desc}</span>
              </div>
              <div className="team-lines">
                <span className="kicker">Projects</span>
                {projs.length ? projs.map((p) => <span key={p.id} className="chip">{p.name}</span>) : <span className="muted small">none</span>}
                <span className="kicker ppl-owns">Repos</span>
                <span className="mono small">{owns.length}</span>
              </div>
              <TeamRoles team={t} roles={roles} projects={projects} perm={perm} members={members.length} />
              <ul className="members">{shown.map((p) => <Member key={p.id} p={p} teamId={t.id} sel={sel} onSel={onSel} roleName={roleName} projects={projects} teamName={teamName} />)}</ul>
              <div className="team-actions">
                <Btn label={`Invite to ${t.name}`} small kind="ghost" icon="plus" id={`ppl-inv-${t.id}`} guard={perm} onClick={() => invite({ team: t.id })} />
                <Btn label="Edit" small kind="ghost" icon="tag" id={`ppl-team-edit-${t.id}`} guard={perm} onClick={() => teamDlg.edit(t)} />
                <Btn
                  label="Delete" small kind="ghost" icon="x" id={`ppl-team-del-${t.id}`}
                  guard={projs.length || owns.length ? { allowed: false, reason: `${t.name} owns ${projs.length} project${projs.length === 1 ? "" : "s"} and ${owns.length} repo${owns.length === 1 ? "" : "s"}. Move them to another team first.` } : perm}
                  onClick={() => void teamDlg.remove(t, members.length)}
                />
              </div>
            </li>
          );
        })}
        {noTeam.length ? (
          <li className="team">
            <div className="team-head"><h3 className="team-name">No team</h3></div>
            <ul className="members">{noTeam.map((p) => <Member key={p.id} p={p} teamId="none" sel={sel} onSel={onSel} roleName={roleName} projects={projects} teamName={teamName} />)}</ul>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/* ---------- member detail ---------- */

function TeamsForm({ p, teams, perm, onSave }: { p: Person; teams: Array<{ id: string; name: string }>; perm: Decision; onSave: (fn: () => Promise<boolean>) => void }) {
  const [picked, setPicked] = useState<string[]>(p.teams ?? []);
  const [err, setErr] = useState("");
  const outcome = useOutcome();
  onSave(async () => {
    if (!picked.length) {
      setErr("Keep at least one team.");
      return false;
    }
    const r = outcome(await ops.setTeams(p.id, picked));
    if (!r.ok) setErr(r.msg);
    return r.ok;
  });
  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Team membership" />
      <div className="check-grid">
        {teams.map((t) => (
          <label key={t.id} className="check" htmlFor={`ppl-tm-${t.id}`}>
            <input type="checkbox" id={`ppl-tm-${t.id}`} value={t.id} checked={picked.includes(t.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, t.id] : picked.filter((x) => x !== t.id))} />
            {t.name}
          </label>
        ))}
      </div>
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

function MemberDetail({ p, teams, projects, roles, perm, admins, viewerId, roleName }: {
  p: Person; teams: Array<{ id: string; name: string }>; projects: Project[]; roles: Role[]; perm: Decision; admins: Person[]; viewerId: string; roleName: (id: string) => string;
}) {
  const ui = useUI();
  const outcome = useOutcome();
  const actors = useActors();
  const [effProject, setEffProject] = useState("all");
  const [cell, setCell] = useState<{ action: string; project: string } | null>(null);
  const eff = useQuery({ queryKey: ["people", "effective", p.id], queryFn: () => get<EffectivePermissions>(api(`people/${encodeURIComponent(p.id)}/effective-permissions`)) });
  const away = p.away && p.away.to > Date.now() ? p.away : null;
  const visible = projects.filter((x) => x.status !== "archived");
  const frRole = p.roles.find((g) => g.scope === "factory" && !g.via)?.role ?? "";
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const direct = p.roles.filter((g) => !g.via);
  const inherited = p.roles.filter((g) => g.via);
  const scopeName = (s: string) => (s === "factory" ? "Factory" : projects.find((x) => x.id === s)?.name ?? s);
  const factoryRoles = roles.filter((r) => r.level === "factory");
  const projectRoles = roles.filter((r) => r.level !== "factory");

  let factGuard: Decision = perm;
  if (perm.allowed && p.id === viewerId) factGuard = lockd("You cannot change your own factory role. Ask another Factory Admin.");
  else if (perm.allowed && frRole === "factory_admin" && admins.length < 2) factGuard = lockd(`${p.name} is the only Factory Admin. Make someone else a Factory Admin first.`);

  const changeFactoryRole = async (v: string) => {
    let r: { ok: boolean; msg: string } = { ok: true, msg: "" };
    if (frRole && frRole !== v) r = outcome(await ops.setFactoryRole(p.id, frRole, false));
    if (r.ok && v) r = outcome(await ops.setFactoryRole(p.id, v, true), `${p.name} is now ${roleName(v)} across the factory.`);
    else if (r.ok) ui.toast(`${p.name} has no factory role now.`, "ok");
  };

  const openTeams = () => {
    let save: () => Promise<boolean> = async () => false;
    ui.dialog({
      title: `Teams for ${p.name}`, kicker: "People", sub: "Teams group people and own repos. Permissions come from roles, not teams.",
      body: <TeamsForm p={p} teams={teams} perm={perm} onSave={(fn) => (save = fn)} />,
      actions: [{ label: "Cancel" }, { label: "Save teams", kind: "primary", submit: true, id: "ppl-tm-save", guard: perm, onClick: (close) => void save().then((ok) => ok && close()) }],
    });
  };

  const selDecision = useSelectedCell(p.id, cell);

  return (
    <section className="panel member-detail" aria-label={p.name}>
      <div className="ad-head">
        <Avatar id={p.id} size="lg" />
        <div className="ppl-who">
          <div className="kicker">{`${(p.teams ?? []).map((t) => teams.find((x) => x.id === t)?.name ?? t).join(", ")} · ${p.status === "invited" ? "invite pending" : "active"}`}</div>
          <h2 className="ad-title">{p.name}</h2>
          <div className="ad-meta">{`${p.title} · `}<span className="mono">{p.email}</span>{p.github ? <span className="mono">{` · github ${p.github}`}</span> : null}</div>
          <div className="ppl-badges">
            <span className="chip"><Icon name="shield" />{p.mfa ? "MFA enrolled" : "No MFA"}</span>
            {p.oncall ? <span className="chip chip-accent"><Icon name="clock" />On call</span> : null}
            {away ? <span className="chip chip-warn"><Icon name="swap" />{`Away until ${fmt.istDate(away.to)}, delegate ${actors(away.delegate).name}`}</span> : null}
          </div>
        </div>
        <div className="ad-tools">
          {p.status === "invited" ? <Btn label="Mark invite accepted" small icon="check" id="ppl-accept" guard={perm} onClick={async () => void outcome(await ops.acceptInvite(p.id))} /> : null}
          <Btn label={p.oncall ? "Take off call" : "Put on call"} small icon="clock" id="ppl-oncall" guard={perm} onClick={async () => void outcome(await ops.setOncall(p.id, !p.oncall))} />
          <Btn label="Edit teams" small kind="ghost" icon="teams" id="ppl-teams" guard={perm} onClick={openTeams} />
        </div>
      </div>

      <h3 className="sub-h">Roles held</h3>
      <div className="ppl-pad ppl-held" id="ppl-held">
        <div>
          <span className="kicker">Direct</span>
          {direct.length ? <ul className="ppl-held-list">{direct.map((g) => <li key={`${g.role}-${g.scope}`} className="chip">{`${roleName(g.role)} · ${scopeName(g.scope)}`}</li>)}</ul> : <span className="muted small">None granted to {p.name} personally.</span>}
        </div>
        <div>
          <span className="kicker">Inherited from teams</span>
          {inherited.length ? (
            <ul className="ppl-held-list">{inherited.map((g) => <li key={`${g.role}-${g.scope}-${g.via}`} className="chip chip-accent">{`${roleName(g.role)} · ${scopeName(g.scope)} · via ${teamName(g.via!)}`}</li>)}</ul>
          ) : <span className="muted small">None. Roles held by {p.name}'s teams would show here; change them on the team.</span>}
        </div>
      </div>

      <h3 className="sub-h">Factory role</h3>
      <div className="ppl-pad">
        <div className="ppl-frole-row">
          <Select
            id="ppl-frole"
            value={frRole}
            aria-label={`Factory role for ${p.name}`}
            disabled={!factGuard.allowed}
            onChange={(v) => void changeFactoryRole(v)}
            options={[{ value: "", label: "None (project roles only)" }, ...factoryRoles.map((r) => ({ value: r.id, label: roleName(r.id) + (r.id === "factory_admin" ? ": everything, every project" : r.id === "auditor" ? ": read everything, change nothing" : r.custom ? ` (custom): ${r.desc || "custom factory role"}` : "") }))]}
          />
          {!factGuard.allowed ? <span className="muted small">{(factGuard.needs ? `${factGuard.needs}. ` : "") + factGuard.reason}</span> : null}
        </div>
      </div>

      <h3 className="sub-h">Roles per project</h3>
      <p className="muted small ppl-pad">One person can hold different roles in each project. A switch is locked where you cannot manage that project's members.</p>
      <div className="table-scroll" data-keep-scroll="ppl-proles">
        <table className="table table-compact ppl-roles">
          <caption className="sr">{`Project roles for ${p.name}`}</caption>
          <thead>
            <tr>
              <th scope="col">Project</th>
              {projectRoles.map((r) => (
                <th key={r.id} scope="col" className={`ppl-rcol${r.custom ? " is-custom" : ""}`} title={r.desc}>{r.name}{r.custom ? <span className="ppl-custom mono">custom</span> : null}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((pr) => (
              <ProjectRoleRow key={pr.id} p={p} project={pr} roles={projectRoles} viewerId={viewerId} teamName={teamName} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="ppl-eff-head">
        <h3 className="sub-h">Effective permissions now</h3>
        <span className="mono muted small">{`${fmt.ist(Date.now())} IST`}</span>
        <Select id="ppl-eff-proj" aria-label="Project for effective permissions" value={effProject} onChange={setEffProject} options={[{ value: "all", label: "All projects" }, ...visible.map((x) => ({ value: x.id, label: x.name }))]} />
      </div>
      <p className="muted small ppl-pad">Roles, scope, release windows, on-call rules and freezes combined, as the policy engine decides them right now. Hover or focus a cell for the deciding rule and where the role comes from. P-numbers mark cells decided by a policy; T marks cells allowed only through a team.</p>
      <Async query={eff} what="effective permissions" id="ppl-eff" rows={4}>{(effData) => (
        <>
          <EffTable p={p} eff={effData} project={effProject} cell={cell} onPick={setCell} />
          <CellDetail p={p} eff={effData} cell={cell} decision={selDecision.data} />
          <h3 className="sub-h">Factory-wide</h3>
          <ul className="caps caps-grid ppl-pad">
            {effData.actions.filter((a) => a.scope === "factory").map((a) => {
              const d = effData.factory[a.id];
              const ok = !!d?.allowed;
              return (
                <li key={a.id} className={ok ? "ok" : "no"} data-tip={d?.reason + (ok && d?.sources?.length ? ` Role ${sourceText(d.sources, effData.teams)}.` : "")} tabIndex={0}>
                  <Icon name={ok ? "check" : "lock"} />
                  <span>{a.name}{ok && d?.sources?.length && !d.sources.includes("direct") ? <span className="muted small">{` · ${sourceText(d.sources, effData.teams)}`}</span> : null}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}</Async>
      <h3 className="sub-h">History</h3>
      <div className="ppl-pad"><HistoryList id={p.id} limit={8} /></div>
    </section>
  );
}

function ProjectRoleRow({ p, project, roles, viewerId, teamName }: { p: Person; project: Project; roles: Role[]; viewerId: string; teamName: (id: string) => string }) {
  const outcome = useOutcome();
  const perm = dec(useCan("project.members", { project: project.id }));
  const held = p.roles.filter((g) => g.scope === project.id && !g.via).map((g) => g.role);
  const viaTeams = (role: string) => [...new Set(p.roles.filter((g) => g.scope === project.id && g.role === role && g.via).map((g) => teamName(g.via!)))];
  return (
    <tr className={held.length ? "is-member" : ""}>
      <th scope="row"><span className="ppl-pname">{project.name}</span><span className="mono muted small">{(project as Project & { key?: string }).key}</span></th>
      {roles.map((r) => {
        const on = held.includes(r.id);
        let guard: Decision = perm;
        if (perm.allowed && on && p.id === viewerId && r.id === "project_admin") guard = lockd("You cannot remove your own Project Admin role. Ask another Project Admin or a Factory Admin.");
        return (
          <td key={r.id} className={`ppl-rcell${on ? " is-on" : ""}`}>
            <Toggle id={`ppl-r-${project.id}-${r.id}`} checked={on} decision={guard} label={`${r.name} on ${project.name}`} onChange={async (v) => void outcome(await ops.setMemberRole(p.id, project.id, r.id, v))} />
            {viaTeams(r.id).length ? <span className="ppl-via mono small" title={`Also held through ${viaTeams(r.id).join(", ")}. Change it on the team.`}>{`via ${viaTeams(r.id).join(", ")}`}</span> : null}
          </td>
        );
      })}
    </tr>
  );
}

/** "granted directly" / "via Payments" / "granted directly and via Payments": where the granting role comes from. */
function sourceText(sources: string[] | undefined, teams: Record<string, string> | undefined): string {
  if (!sources?.length) return "";
  const parts = [...(sources.includes("direct") ? ["granted directly"] : []), ...sources.filter((s) => s !== "direct").map((s) => `via ${teams?.[s] ?? s}`)];
  return parts.join(" and ");
}

/** The reason behind one cell: the simulator answers it (same can()). */
function useSelectedCell(person: string, cell: { action: string; project: string } | null) {
  return useQuery({
    queryKey: ["people", "cell", person, cell?.action, cell?.project],
    enabled: !!cell,
    queryFn: async () => {
      const r = await ops.simulateAccess({ person, action: cell!.action, project: cell!.project, time: Date.now() });
      if (!r.ok) throw new Error(r.msg);
      return r as unknown as { decision: { allowed: boolean; reason: string; needs?: string; rule: { id: string; name?: string; kind: string } } };
    },
  });
}

function EffTable({ p, eff, project, cell, onPick }: { p: Person; eff: EffectivePermissions; project: string; cell: { action: string; project: string } | null; onPick: (c: { action: string; project: string }) => void }) {
  const shown = project === "all" ? eff.projects : eff.projects.filter((x) => x.id === project);
  const acts = eff.actions.filter((a) => a.scope === "project");
  const groups = useMemo(() => [...new Set(acts.map((a) => a.group))], [acts]);
  return (
    <div className="table-scroll" data-keep-scroll="ppl-eff">
      <table className="table table-compact eff-table">
        <caption className="sr">{`Effective permissions for ${p.name}`}</caption>
        <thead>
          <tr>
            <th scope="col">Action</th>
            {shown.map((pr) => <th key={pr.id} scope="col" className="eff-col">{pr.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {groups.flatMap((g) => [
            <tr key={`g-${g}`} className="ppl-grp"><th scope="rowgroup" colSpan={shown.length + 1}>{g}</th></tr>,
            ...acts.filter((a) => a.group === g).map((a) => (
              <tr key={a.id} className={a.group === "Stops" ? "ppl-stop" : ""}>
                <th scope="row">{a.name}<span className="mono muted small ppl-aid">{a.id}</span></th>
                {shown.map((pr) => {
                  const c = eff.cells[a.id]?.[pr.id];
                  const ok = c?.[0] === 1;
                  const ruleId = c?.[1] ?? "";
                  const viaPolicy = ok && eff.rules[ruleId]?.kind === "policy";
                  const source = sourceText(c?.[2], eff.teams);
                  const isSel = cell?.action === a.id && cell.project === pr.id;
                  const pick = () => onPick({ action: a.id, project: pr.id });
                  return (
                    <td
                      key={pr.id}
                      className={`eff-cell ${ok ? "is-yes" : "is-no"}${viaPolicy ? " is-policy" : ""}${isSel ? " is-sel" : ""}`}
                      tabIndex={0}
                      role="button"
                      aria-pressed={isSel ? "true" : "false"}
                      id={`ppl-eff-${pr.id}-${a.id.replace(/\./g, "_")}`}
                      data-tip={`${pr.name}: ${ok ? "Allowed" : "Denied"} by ${eff.rules[ruleId]?.name || ruleId} [${ruleId}].${source ? ` Role ${source}.` : ""} Select to see why.`}
                      onClick={pick}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          pick();
                        }
                      }}
                    >
                      <Icon name={ok ? "check" : "x"} />
                      {viaPolicy ? <span className="eff-pol mono">{ruleId.replace("POL-", "P")}</span> : null}
                      <span className="sr">{ok ? "allowed" : "denied"}{source ? `, ${source}` : ""}</span>
                      {ok && source && !c?.[2]?.includes("direct") ? <span className="eff-src mono" aria-hidden="true">T</span> : null}
                    </td>
                  );
                })}
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </div>
  );
}

function CellDetail({ p, eff, cell, decision }: { p: Person; eff: EffectivePermissions; cell: { action: string; project: string } | null; decision: { decision: { allowed: boolean; reason: string; needs?: string; rule: { id: string; name?: string } } } | undefined }) {
  const canSim = useCan("policy.edit");
  const a = cell ? eff.actions.find((x) => x.id === cell.action) : undefined;
  const pr = cell ? eff.projects.find((x) => x.id === cell.project) : undefined;
  if (!cell || !a || !pr) return <p className="muted small ppl-pad">Select a cell to see the deciding rule.</p>;
  const d = decision?.decision;
  if (!d) return <p className="muted small ppl-pad" aria-live="polite">Asking the policy engine.</p>;
  return (
    <div className={`ppl-cell decision ${d.allowed ? "is-allowed" : "is-denied"}`} id="ppl-cell" aria-live="polite">
      <div className="decision-v"><Icon name={d.allowed ? "check" : "halt"} />{d.allowed ? "Allowed" : "Denied"}</div>
      <div><strong>{p.name}</strong>{` · ${a.name.toLowerCase()} · ${pr.name} · now`}</div>
      <div className="decision-rule"><span className="kicker">Deciding rule</span><span className="mono strong">{d.rule.id}</span><span>{d.rule.name ?? ""}</span></div>
      <p>{d.reason}</p>
      {d.needs && !d.allowed ? <p className="small"><strong>To allow it: </strong>{`${d.needs}.`}</p> : null}
      <div className="row gap-sm">
        <ExplainDenial id="ppl-cell-explain" person={p.id} action={a.id} project={pr.id} time={Date.now()} />
        {canSim.allowed ? <Btn label="Open in the simulator" small kind="ghost" icon="play" id="ppl-cell-sim" onClick={() => { sessionStorageSet("gantry.accessSim", JSON.stringify({ person: p.id, action: a.id, project: pr.id })); navigate("access"); }} /> : null}
      </div>
    </div>
  );
}

function sessionStorageSet(k: string, v: string): void {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    /* private window: the simulator opens with its defaults */
  }
}

