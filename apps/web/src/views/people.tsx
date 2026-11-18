/**
 * People & teams (spec 8.9). The organisation as team cards: each team shows its projects, its roles and its members.
 * A member opens their own page (views/person.tsx) with the roles they hold and what they may do.
 */
import { useEffect, useState } from "react";
import { useUrlState, writeUrlState } from "./govern/urlState";
import { type Person, type Project, type Role, type Team } from "@gantry/domain";
import { useAccessMatrix, useMe, usePeople, useProjects, useSecurity } from "../api/queries";
import { useCan } from "../api/can";
import { hashFor, navigate, replaceHash, useHash } from "../lib/router";
import { DataTable } from "../ui/DataTable";
import { Avatar, Btn, Chip, Empty, FilterBar, LockNote, Panel, SearchBox, Select, type Decision } from "../ui/primitives";
import { Page, Stats } from "../ui/cr";
import { Async } from "../ui/async";
import { Icon, Logo } from "../ui/Icon";
import { agoShort, lastSeenOf, useAllRepos, useTeams } from "./govern/data";
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
  const [mode, setMode] = useUrlState("view", "people"); // "teams" is the team-card surface (create, edit, roles per team)
  const [q, setQ] = useState("");
  const sec = useSecurity(); // the allowed invite domains, when this person may read the security settings (the server checks them anyway)
  const invite = useInviteDialog({ perm, teams, projects: projects as Project[], roles, domains: sec.data?.domains ?? [], onDone: () => undefined });
  const teamDlg = useTeamDialogs(perm);
  // Older links (#people/<id>) land on the person's own page.
  useEffect(() => {
    if (loc.param) replaceHash(hashFor("person", loc.param));
  }, [loc.param]);

  if (!me) return null;
  // Default deny: the directory is itself a right. The server refuses the reads too; this shows why instead of an empty screen.
  if (!view.allowed) return <Page cls="view-people" eyebrow="Govern" title="People"><Empty id="people-no-access" icon="lock" title="No access to people and teams" text={`${view.reason} ${view.needs ? `${view.needs}. ` : ""}Ask a Factory Admin or Project Admin to give you a role that can see people.`} /></Page>;
  const admins = people.filter((p) => p.roles.some((g) => g.role === "factory_admin" && !g.via));
  const noMfa = people.filter((p) => p.status === "active" && p.mfa === false).length;
  const org = me.org;
  const asTeams = mode === "teams";

  const ph = (n: () => number): string => (peopleQ.data ? String(n()) : peopleQ.isError ? "–" : "…");
  return (
    <Page
      cls="view-people"
      eyebrow="Govern"
      title={asTeams ? "Teams" : "People"}
      sub={asTeams ? <span id="ppl-defaults"><strong>Default for new people: no access until granted.</strong> Teams group people and own repos; a person also holds the grants of their teams.</span> : <>Who can do what. Roles are granted per project or for the whole factory.</>}
      acts={asTeams
        ? <><Btn label="All people" id="ppl-back" onClick={() => setMode("people")} /><Btn label="New team" icon="teams" id="ppl-team-new" guard={perm} onClick={teamDlg.create} /></>
        : <Btn label="Invite person" kind="primary" icon="plus" id="ppl-invite" guard={perm} onClick={() => invite()} />}
    >
      {asTeams ? null : (
        <Stats id="ppl-stats" items={[
          { l: "People", v: ph(() => people.length), tone: "info" },
          { l: "Active", v: ph(() => people.filter((p) => p.status === "active").length), tone: "ok" },
          { l: "No MFA", v: ph(() => noMfa), tone: "warn" },
          { l: "Factory admins", v: ph(() => admins.length), tone: "agent" },
        ]} />
      )}
      <LockNote decision={perm} what="Invites, teams and roles" />
      <Async query={peopleQ} what="people" id="ppl">{() => (asTeams ? (
        <>
          <section className="panel ppl-org" aria-label="Organisation">
            <div className="ppl-org-head">
              <span className="ppl-org-mark" aria-hidden="true"><Logo /></span>
              <div className="ppl-org-name">
                <strong>{org?.name ?? ""}</strong>
                <span className="muted small">{`Organisation${org?.plant ? ` · ${org.plant}` : ""} · ${people.length} ${people.length === 1 ? "person" : "people"}`}</span>
              </div>
              <SearchBox id="ppl-q" value={q} onChange={setQ} placeholder="Find a person, role or project" label="Find a person" />
            </div>
          </section>
          <OrgTree people={people} teams={teams} projects={projects as Project[]} repos={repos} roles={roles} q={q} perm={perm} invite={invite} teamDlg={teamDlg} />
        </>
      ) : <PeopleTable people={people} teams={teams} roles={roles} invite={() => invite()} perm={perm} />)}</Async>
    </Page>
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

/* ---------- the directory as a table (the Control Room People screen) ---------- */

/** The role a person is shown with: the factory role when they hold one, otherwise the first role they hold. */
export function LastSeen({ p }: { p: Person }) {
  const t = lastSeenOf(p);
  return t ? <span className="mono dim">{agoShort(t)}</span> : <span className="mono dim" title="The server does not report last sign-in yet">not available</span>;
}

export const primaryRole = (p: Person): string | undefined => (p.roles.find((g) => g.scope === "factory" && !g.via) ?? p.roles.find((g) => !g.via) ?? p.roles[0])?.role;

function PeopleTable({ people, teams, roles, invite, perm }: { people: Person[]; teams: Team[]; roles: Role[]; invite: () => void; perm: Decision }) {
  const [q, setQ] = useUrlState("q", "");
  const [role, setRole] = useUrlState("role", "all");
  const [team, setTeam] = useUrlState("team", "all");
  const [st, setSt] = useUrlState("st", "all");
  const [sortKey, setSortKey] = useUrlState("sort", "name");
  const [dir, setDir] = useUrlState("dir", "asc");
  const [page, setPage] = useUrlState("page", "1");
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const needle = q.trim().toLowerCase();
  const rows = people.filter((p) => (role === "all" || p.roles.some((g) => g.role === role)) && (team === "all" || (p.teams ?? []).includes(team)) && (st === "all" || p.status === st) && (!needle || `${p.name} ${p.email} ${p.title}`.toLowerCase().includes(needle)));
  const tone = (s: string): string => (s === "active" ? "ok" : s === "invited" ? "info" : "idle");
  const dirty = !!needle || role !== "all" || team !== "all" || st !== "all";
  const clear = (): void => writeUrlState({ q: null, role: null, team: null, st: null, page: null });
  const clearBtn = <Btn label="Clear filters" id="ppl-clear" onClick={clear} />;
  if (!people.length) return <Empty id="ppl-empty" icon="people" title="Nothing here yet" text="Invite the first person to give them access." action={<Btn label="Invite person" kind="primary" icon="plus" guard={perm} onClick={invite} />} />;
  return (
    <div>
      <FilterBar label="Filter people" count={`${rows.length} of ${people.length}`} actions={dirty ? <Btn label="Clear" kind="ghost" small id="ppl-clear-small" onClick={clear} /> : undefined}>
        <SearchBox id="ppl-q" value={q} onChange={(v) => { setQ(v); setPage("1"); }} placeholder="Search name, email, title" label="Find a person" />
        <Select id="ppl-f-role" aria-label="Role" options={[{ value: "all", label: "Role: all" }, ...roles.map((r) => ({ value: r.id, label: r.name }))]} value={role} onChange={(v) => { setRole(v); setPage("1"); }} />
        <Select id="ppl-f-team" aria-label="Team" options={[{ value: "all", label: "Team: all" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} value={team} onChange={(v) => { setTeam(v); setPage("1"); }} />
        <Select id="ppl-f-status" aria-label="Status" options={[{ value: "all", label: "Status: all" }, { value: "active", label: "Active" }, { value: "invited", label: "Invited" }, { value: "deactivated", label: "Deactivated" }]} value={st} onChange={(v) => { setSt(v); setPage("1"); }} />
      </FilterBar>
      <DataTable
        id="ppl-table"
        caption="People"
        rows={rows}
        rowKey={(p) => p.id}
        rowId={(p) => `ppl-row-${p.id}`}
        onRow={(p) => navigate("person", p.id)}
        rowLabel={(p) => `${p.name}: open`}
        pageSize={12}
        pager
        sortHint
        page={Math.max(0, (Number(page) || 1) - 1)}
        onPage={(n) => setPage(String(n + 1))}
        sort={{ key: sortKey, dir: dir === "desc" ? -1 : 1 }}
        onSort={(s) => { setSortKey(s.key); setDir(s.dir === -1 ? "desc" : "asc"); }}
        empty={{ title: "Nothing matches", text: "Try clearing a filter or searching for something else.", action: clearBtn }}
        columns={[
          { key: "name", label: "Person", sort: (p) => p.name.toLowerCase(), render: (p) => (
            <span className="row nowrap"><Avatar id={p.id} size="sm" /><span style={{ minWidth: 0 }}><a className="rl ell" href={hashFor("person", p.id)} aria-label={`${p.name}: open`}>{p.name}</a><span className="dim ell small" style={{ display: "block" }}>{p.title}</span></span></span>
          ) },
          { key: "role", label: "Role", sort: (p) => primaryRole(p) ?? "", render: (p) => { const r = primaryRole(p); return r ? <span className="chip info plain">{roleName(r)}</span> : <span className="dim">No roles yet</span>; } },
          { key: "team", label: "Team", sort: (p) => (p.teams ?? []).map(teamName).join(", "), render: (p) => ((p.teams ?? []).map(teamName).join(", ") || <span className="dim">none</span>) },
          { key: "mfa", label: "MFA", sort: (p) => (p.mfa ? 1 : 0), render: (p) => (p.mfa === undefined ? <span className="dim">–</span> : p.mfa ? <span className="chip ok">On</span> : <span className="chip warn">Off</span>) },
          // Shown when the server reports it (`lastSeen`); otherwise say so instead of inventing a time.
          { key: "seen", label: "Last seen", sort: (p) => -(lastSeenOf(p) ?? 0), render: (p) => <LastSeen p={p} /> },
          { key: "status", label: "Status", sort: (p) => p.status, render: (p) => <><span className={`chip ${tone(p.status)}`}>{p.status.charAt(0).toUpperCase() + p.status.slice(1)}</span>{p.oncall ? <span className="chip agent">on call</span> : null}</> },
        ]}
      />
    </div>
  );
}
