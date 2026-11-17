/**
 * People & teams (spec 8.9). The organisation as team cards: each team shows its projects, its roles and its members.
 * A member opens their own page (views/person.tsx) with the roles they hold and what they may do.
 */
import { useEffect, useState } from "react";
import type { Person, Project, Role, Team } from "@gantry/domain";
import { useAccessMatrix, useMe, usePeople, useProjects, useSecurity } from "../api/queries";
import { useCan } from "../api/can";
import { hashFor, navigate, replaceHash, useHash } from "../lib/router";
import { Avatar, Btn, Chip, Empty, LockNote, Panel, SearchBox, Select, Field, FilterBar, Stat, StatRow, Table, Tabs, ViewHead, type Decision } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import { Icon } from "../ui/Icon";
import { useAllRepos, useTeams } from "./govern/data";
import { useInviteDialog } from "./people/InviteDialog";
import { useTeamDialogs } from "./people/TeamDialog";
import { TeamRoles } from "./people/TeamRoles";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

export default function PeopleView() {
  const me = useMe();
  const loc = useHash();
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
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("people");
  const sec = useSecurity(); // the allowed invite domains, when this person may read the security settings (the server checks them anyway)
  const goPerson = (id: string) => navigate("person", id);
  const invite = useInviteDialog({ perm, teams, projects: projects as Project[], roles, domains: sec.data?.domains ?? [], onDone: goPerson });
  const teamDlg = useTeamDialogs(perm);
  // Older links (#people/<id>) land on the person's own page.
  useEffect(() => {
    if (loc.param) replaceHash(hashFor("person", loc.param));
  }, [loc.param]);

  if (!me) return null;
  // Default deny: the directory is itself a right. The server refuses the reads too; this shows why instead of an empty screen.
  if (!view.allowed) return <div className="view view-people"><ViewHead title="People & teams" sub="" /><Empty id="people-no-access" icon="lock" title="No access to people and teams" text={`${view.reason} ${view.needs ? `${view.needs}. ` : ""}Ask a Factory Admin or Project Admin to give you a role that can see people.`} /></div>;
  const noMfa = people.filter((p) => !p.mfa).length;

  return (
    <div className="view view-people">
      <ViewHead
        title="People & teams"
        sub="Everyone with access, what they can do, and who is on call."
        actions={<><Btn label="New team" icon="teams" id="ppl-team-new" guard={perm} onClick={teamDlg.create} /><Btn label="Invite person" kind="primary" icon="plus" id="ppl-invite" guard={perm} onClick={() => invite()} /></>}
      />
      <StatRow id="ppl-stats">
        <Stat label="People" value={qState(peopleQ, () => String(people.length))} sub={`${people.filter((p) => p.status === "active").length} active`} />
        <Stat label="On call" value={qState(peopleQ, () => String(people.filter((p) => p.oncall).length))} tone="done" />
        <Stat label="Without MFA" value={qState(peopleQ, () => String(noMfa))} tone={noMfa ? "wait" : "done"} />
        <Stat label="Teams" value={qState(teamsQ, () => String(teams.length))} />
      </StatRow>
      <LockNote decision={perm} what="Invites, teams and roles" />
      <Tabs idPrefix="ppl-tab" active={tab} onChange={setTab} items={[{ id: "people", label: "People", count: people.length }, { id: "teams", label: "Teams", count: teams.length }]} />
      <div id="ppl-tab-panel" role="tabpanel" aria-labelledby={`ppl-tab-${tab}`}>
        <Async query={peopleQ} what="people" id="ppl">{() => tab === "teams" ? (
          <>
            <p className="muted small" id="ppl-defaults"><strong>Default for new people: no access until granted.</strong> A person's effective roles are their own grants plus the grants of their teams.</p>
            <div className="ppl-find"><SearchBox id="ppl-q" value={q} onChange={setQ} placeholder="Find a person, role or project" label="Find a person" /></div>
            <OrgTree people={people} teams={teams} projects={projects as Project[]} repos={repos} roles={roles} q={q} perm={perm} invite={invite} teamDlg={teamDlg} />
          </>
        ) : (
          <PeopleTable people={people} teams={teams} roles={roles} />
        )}</Async>
      </div>
    </div>
  );
}

/* ---------- teams ---------- */

function grantLabel(g: { role: string; scope: string; via?: string | undefined }, roleName: (id: string) => string, projects: Project[], teamName?: (id: string) => string): string {
  return `${roleName(g.role)} · ${g.scope === "factory" ? "Factory" : projects.find((p) => p.id === g.scope)?.name ?? g.scope}${g.via ? ` (via ${teamName ? teamName(g.via) : g.via})` : ""}`;
}

function Member({ p, teamId, roleName, projects, teamName }: { p: Person; teamId: string; roleName: (id: string) => string; projects: Project[]; teamName: (id: string) => string }) {
  const fr = p.roles.find((x) => x.scope === "factory" && !x.via);
  const summary = p.roles.length ? p.roles.map((g) => grantLabel(g, roleName, projects, teamName)).join(", ") : "No roles yet";
  return (
    <li>
      <a className={`member${p.status === "deactivated" ? " is-off" : ""}`} id={`ppl-mem-${teamId}-${p.id}`} href={hashFor("person", p.id)} aria-label={`${p.name}: open`}>
        <Avatar id={p.id} size="sm" />
        <span className="member-main">
          <span className="ppl-name">{p.name}{fr ? <Chip text={roleName(fr.role)} cls="chip-accent" /> : null}</span>
          <span className="muted small">{summary}</span>
        </span>
        <span className="ppl-flags">
          {p.status === "invited" ? <span className="chip chip-warn"><Icon name="mail" />invited</span> : null}
          {p.status === "deactivated" ? <span className="chip chip-muted"><Icon name="lock" />deactivated</span> : null}
          {p.oncall ? <span className="chip chip-accent"><Icon name="clock" />on call</span> : null}
          {p.away && p.away.to > Date.now() ? <span className="chip"><Icon name="swap" />away</span> : null}
        </span>
      </a>
    </li>
  );
}

/** Deactivated people sit below active ones (stable otherwise). */
const byStatus = (list: Person[]): Person[] => [...list.filter((p) => p.status !== "deactivated"), ...list.filter((p) => p.status === "deactivated")];

function OrgTree({ people, teams, projects, repos, roles, q, perm, invite, teamDlg }: {
  people: Person[]; teams: Team[]; projects: Project[]; repos: Array<{ team: string }>; roles: Role[];
  q: string; perm: Decision; invite: (p: { team?: string }) => void; teamDlg: ReturnType<typeof useTeamDialogs>;
}) {
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const matches = (p: Person) => {
    const s = q.trim().toLowerCase();
    return !s || `${p.name} ${p.email} ${p.title} ${p.roles.map((g) => grantLabel(g, roleName, projects)).join(" ")}`.toLowerCase().includes(s);
  };
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const noTeam = byStatus(people.filter((p) => !p.teams?.length)).filter(matches);
  const cards = teams.map((t) => {
    const members = byStatus(people.filter((p) => (p.teams ?? []).includes(t.id)));
    return { t, members, shown: members.filter(matches) };
  }).filter((x) => !q.trim() || x.shown.length);
  if (!cards.length && !noTeam.length) return <Empty id="ppl-none" icon="search" title={`Nobody matches "${q.trim()}"`} text="Search covers name, email, title, roles and projects." />;
  return (
    <div className="ppl-teams">
      {cards.map(({ t, members, shown }) => {
        const projs = projects.filter((p) => (p as Project & { teams?: string[] }).teams?.includes(t.id));
        const owns = repos.filter((r) => r.team === t.id);
        return (
          <Panel key={t.id} cls="ppl-team" title={<>{t.name}<span className="ppl-count">{members.length}</span></>}>
            {t.desc ? <p className="muted small ppl-team-desc">{t.desc}</p> : null}
            <div className="team-lines">
              <span className="kicker">Projects</span>
              {projs.length ? projs.map((p) => <span key={p.id} className="chip">{p.name}</span>) : <span className="muted small">none</span>}
              <span className="kicker ppl-owns">Repos</span>
              <span className="mono small">{owns.length}</span>
            </div>
            <TeamRoles team={t} roles={roles} projects={projects} perm={perm} members={members.length} />
            {shown.length ? <ul className="members">{shown.map((p) => <Member key={p.id} p={p} teamId={t.id} roleName={roleName} projects={projects} teamName={teamName} />)}</ul> : <p className="muted small">No members yet.</p>}
            <div className="team-actions">
              <Btn label={`Invite to ${t.name}`} small icon="plus" id={`ppl-inv-${t.id}`} guard={perm} onClick={() => invite({ team: t.id })} />
              <Btn label="Edit" small icon="tag" id={`ppl-team-edit-${t.id}`} guard={perm} onClick={() => teamDlg.edit(t)} />
              <Btn
                label="Delete" small icon="x" id={`ppl-team-del-${t.id}`}
                guard={projs.length || owns.length ? { allowed: false, reason: `${t.name} owns ${projs.length} project${projs.length === 1 ? "" : "s"} and ${owns.length} repo${owns.length === 1 ? "" : "s"}. Move them to another team first.` } : perm}
                onClick={() => void teamDlg.remove(t, members.length)}
              />
            </div>
          </Panel>
        );
      })}
      {noTeam.length ? (
        <Panel cls="ppl-team" title={<>No team<span className="ppl-count">{noTeam.length}</span></>}>
          <p className="muted small ppl-team-desc">People who are not in any team. Their own roles are all they hold.</p>
          <ul className="members">{noTeam.map((p) => <Member key={p.id} p={p} teamId="none" roleName={roleName} projects={projects} teamName={teamName} />)}</ul>
        </Panel>
      ) : null}
    </div>
  );
}

function PeopleTable({ people, teams, roles }: { people: Person[]; teams: Team[]; roles: Role[] }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [team, setTeam] = useState("all");
  const [role, setRole] = useState("all");
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const s = q.trim().toLowerCase();
  const shown = people.filter((p) => (status === "all" || p.status === status) && (team === "all" || (p.teams ?? []).includes(team)) && (role === "all" || p.roles.some((g) => g.role === role)) && (!s || `${p.name} ${p.email} ${p.title}`.toLowerCase().includes(s)));
  return (
    <Panel flush>
      <FilterBar label="Filter people" count={`${shown.length} ${shown.length === 1 ? "person" : "persons"}`}>
        <SearchBox id="ppl-tq" value={q} onChange={setQ} placeholder="Search..." label="Search people" />
        <Field label="Status" htmlFor="ppl-f-status"><Select id="ppl-f-status" options={[{ value: "all", label: "All" }, { value: "active", label: "Active" }, { value: "invited", label: "Invited" }, { value: "deactivated", label: "Deactivated" }]} value={status} onChange={setStatus} /></Field>
        <Field label="Team" htmlFor="ppl-f-team"><Select id="ppl-f-team" options={[{ value: "all", label: "All" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} value={team} onChange={setTeam} /></Field>
        <Field label="Role" htmlFor="ppl-f-role"><Select id="ppl-f-role" options={[{ value: "all", label: "All" }, ...roles.map((r) => ({ value: r.id, label: r.name }))]} value={role} onChange={setRole} /></Field>
      </FilterBar>
      {shown.length ? (
        <Table>
          <thead><tr><th>Person</th><th>Roles</th><th>Teams</th><th>MFA</th><th>On call</th><th>Status</th></tr></thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id} className="row-link" id={`ppl-row-${p.id}`} onClick={() => navigate("person", p.id)}>
                <td>
                  <div className="row nowrap">
                    <Avatar id={p.id} />
                    <div><a className="pri" href={hashFor("person", p.id)} onClick={(e) => e.stopPropagation()}>{p.name}</a><span className="sub">{p.title}</span></div>
                  </div>
                </td>
                <td><div className="row">{p.roles.length ? p.roles.slice(0, 2).map((g, i) => <span key={i} className="chip plain">{roleName(g.role)}</span>) : <span className="chip warn">No roles</span>}</div></td>
                <td>{(p.teams ?? []).map((t) => teams.find((x) => x.id === t)?.name ?? t).join(", ") || "-"}</td>
                <td><span className={`chip ${p.mfa ? "ok" : "warn"}`}>{p.mfa ? "on" : "off"}</span></td>
                <td>{p.oncall ? <span className="chip info">on call</span> : "-"}</td>
                <td><span className={`chip ${p.status === "active" ? "ok" : p.status === "invited" ? "info" : "plain"}`}>{p.status}</span></td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : <Empty title="Nobody matches" text="Change the search or filters." />}
    </Panel>
  );
}
