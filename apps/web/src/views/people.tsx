/**
 * People & teams (prototype "people"): stats, a People table (search, status / team / role filters, sortable, paged) and a
 * Teams card grid. A person opens their own page (views/person.tsx). Team administration (invite to, edit, roles, delete)
 * sits behind each card's menu, so the card face stays the prototype's.
 */
import { useEffect } from "react";
import type { Person, Project, Role, Team } from "@gantry/domain";
import { useAccessMatrix, useMe, usePeople, useProjects, useSecurity } from "../api/queries";
import { useCan } from "../api/can";
import { hashFor, navigate, replaceHash, useHash } from "../lib/router";
import { Avatar, Btn, Chip, Empty, Field, FilterBar, Panel, SearchBox, Select, Stat, StatRow, Tabs, ViewHead, type Decision } from "../ui/primitives";
import { DataTable } from "../ui/DataTable";
import { Async, qState } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { plural } from "../lib/plural";
import { useAllRepos, useTeams } from "./govern/data";
import { CountClear, PAGE_SIZE, Pager, parseSort, setQS, sortParam, useQS } from "./govern/kit";
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
  const [tab] = useQS("ppl.tab", "people");
  const sec = useSecurity(); // the allowed invite domains, when this person may read the security settings (the server checks them anyway)
  const ui = useUI();
  const invite = useInviteDialog({ perm, teams, projects: projects as Project[], roles, domains: sec.data?.domains ?? [], onDone: () => undefined });
  const teamDlg = useTeamDialogs(perm);
  // Older links (#people/<id>) land on the person's own page.
  useEffect(() => {
    if (loc.param) replaceHash(hashFor("person", loc.param));
  }, [loc.param]);

  if (!me) return null;
  // Default deny: the directory is itself a right. The server refuses the reads too; this shows why instead of an empty screen.
  if (!view.allowed) return <div className="view view-people"><ViewHead title="People & teams" sub="" kicker="All lines" /><Empty id="people-no-access" icon="lock" title="No access to this sheet" text={`${view.reason} ${view.needs ? `${view.needs}. ` : ""}Ask a Factory Admin or Project Admin to give you a role that can see people.`} /></div>;
  const noMfa = people.filter((p) => !p.mfa).length;
  const active = tab === "teams" ? "teams" : "people";

  return (
    <div className="view view-people">
      <ViewHead
        title="People & teams"
        kicker="All lines"
        sub="Everyone with access, what they can do, and who is on call."
        actions={<><Btn label="New team" id="ppl-team-new" guard={perm} onClick={teamDlg.create} /><Btn label="Invite person" kind="primary" icon="plus" id="ppl-invite" guard={perm} onClick={() => invite()} /></>}
      />
      <StatRow id="ppl-stats">
        <Stat label="People" tone="info" value={qState(peopleQ, () => String(people.length))} sub={`${people.filter((p) => p.status === "active").length} active`} />
        <Stat label="On call" value={qState(peopleQ, () => String(people.filter((p) => p.oncall).length))} tone="done" />
        <Stat label="Without MFA" value={qState(peopleQ, () => String(noMfa))} tone={noMfa ? "wait" : "done"} />
        <Stat label="Teams" value={qState(teamsQ, () => String(teams.length))} />
      </StatRow>
      <Tabs idPrefix="ppl-tab" active={active} onChange={(t) => setQS({ "ppl.tab": t === "people" ? "" : t, "ppl.page": "" })} items={[{ id: "people", label: "People", count: people.length }, { id: "teams", label: "Teams", count: teams.length }]} />
      <div id="ppl-tab-panel" role="tabpanel" aria-labelledby={`ppl-tab-${active}`}>
        <Async query={peopleQ} what="people" id="ppl">{() => active === "teams" ? (
          <TeamGrid people={people} teams={teams} projects={projects as Project[]} repos={repos} roles={roles} perm={perm} invite={invite} teamDlg={teamDlg} ui={ui} />
        ) : (
          <PeopleTable people={people} teams={teams} roles={roles} />
        )}</Async>
      </div>
    </div>
  );
}

/* ---------- teams ---------- */

type Ui = ReturnType<typeof useUI>;

function TeamGrid({ people, teams, projects, repos, roles, perm, invite, teamDlg, ui }: {
  people: Person[]; teams: Team[]; projects: Project[]; repos: Array<{ team: string }>; roles: Role[];
  perm: Decision; invite: (p: { team?: string }) => void; teamDlg: ReturnType<typeof useTeamDialogs>; ui: Ui;
}) {
  if (!teams.length) return <Empty id="ppl-none" icon="search" title="No teams yet" text="Create a team to group people and own projects." />;
  return (
    <div className="card-grid" id="ppl-teams">
      {teams.map((t) => {
        const members = people.filter((p) => (p.teams ?? []).includes(t.id));
        const projs = projects.filter((p) => (p as Project & { teams?: string[] }).teams?.includes(t.id));
        const owns = repos.filter((r) => r.team === t.id);
        const menu = (el: HTMLElement) => ui.menu(el, t.name, [
          { label: `Invite to ${t.name}`, icon: "plus", guard: perm, onClick: () => invite({ team: t.id }) },
          { label: "Edit team", icon: "tag", guard: perm, onClick: () => teamDlg.edit(t) },
          { label: "Roles of the team", icon: "key", onClick: () => ui.dialog({ title: `Roles of ${t.name}`, kicker: "People & teams", body: <TeamRoles team={t} roles={roles} projects={projects} perm={perm} members={members.length} />, actions: [{ label: "Close", kind: "primary" }] }) },
          { sep: true },
          { label: "Delete team", icon: "x", kind: "danger", guard: projs.length || owns.length ? { allowed: false, reason: `${t.name} owns ${plural(projs.length, "project")} and ${plural(owns.length, "repo")}. Move them to another team first.` } : perm, onClick: () => void teamDlg.remove(t, members.length) },
        ]);
        return (
          // The card face is static (prototype): no control, no click action. Team administration stays reachable from the card's context menu (right click).
          <div className="card" key={t.id} id={`ppl-team-${t.id}`} onContextMenu={(e) => { e.preventDefault(); menu(e.currentTarget); }}>
            <h3>{t.name}</h3>
            <div className="small muted">{t.desc}</div>
            <div className="row">
              {members.slice(0, 6).map((p) => <Avatar key={p.id} id={p.id} />)}
              {members.length > 6 ? <span className="small muted">{`+${members.length - 6}`}</span> : null}
            </div>
            <div className="small">{plural(members.length, "member")}{" \u00b7 "}{plural(projs.length, "project")}</div>
          </div>
        );
      })}
    </div>
  );
}

function PeopleTable({ people, teams, roles }: { people: Person[]; teams: Team[]; roles: Role[] }) {
  const [q, setQ] = useQS("ppl.q");
  const [status] = useQS("ppl.status");
  const [team] = useQS("ppl.team");
  const [role] = useQS("ppl.role");
  const [sortV] = useQS("ppl.sort");
  const [pageV] = useQS("ppl.page", "0");
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const s = q.trim().toLowerCase();
  const filtered = people.filter((p) => (!status || p.status === status) && (!team || (p.teams ?? []).includes(team)) && (!role || p.roles.some((g) => g.role === role)) && (!s || `${p.name}${p.email}${p.title}`.toLowerCase().includes(s)));
  const sort = parseSort(sortV, { key: "", dir: 1 });
  const key = (p: Person): string => (sort.key === "status" ? p.status : p.name);
  const sorted = sort.key ? [...filtered].sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * sort.dir) : filtered;
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, Number(pageV) || 0), pages - 1);
  const vis = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const isFiltered = !!(q || status || team || role);
  const clear = () => setQS({ "ppl.q": "", "ppl.status": "", "ppl.team": "", "ppl.role": "", "ppl.page": "" });
  const set = (k: string) => (v: string) => setQS({ [k]: v, "ppl.page": "" });
  return (
    <Panel flush>
      <FilterBar label="Filter people" count={<CountClear n={filtered.length} of={people.length} noun="person" active={isFiltered} onClear={clear} />}>
        <SearchBox id="ppl-tq" value={q} onChange={(v) => { setQ(v); if (pageV !== "0") setQS({ "ppl.page": "" }); }} placeholder={"Search\u2026"} label="Search person" />
        <Field label="Status" htmlFor="ppl-f-status"><Select id="ppl-f-status" options={[{ value: "", label: "All" }, "active", "invited", "deactivated"]} value={status} onChange={set("ppl.status")} /></Field>
        <Field label="Team" htmlFor="ppl-f-team"><Select id="ppl-f-team" options={[{ value: "", label: "All" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} value={team} onChange={set("ppl.team")} /></Field>
        <Field label="Role" htmlFor="ppl-f-role"><Select id="ppl-f-role" options={[{ value: "", label: "All" }, ...roles.map((r) => ({ value: r.id, label: r.name }))]} value={role} onChange={set("ppl.role")} /></Field>
      </FilterBar>
      <DataTable<Person>
        id="ppl-table"
        blueprintSort
        caption="People"
        rows={vis}
        rowKey={(p) => p.id}
        rowId={(p) => `ppl-row-${p.id}`}
        onRow={(p) => navigate("person", p.id)}
        sort={sort.key ? sort : undefined}
        onSort={(x) => setQS({ "ppl.sort": sortParam(x), "ppl.page": "" })}
        empty={people.length
          ? { title: "Nothing matches these filters", text: "Loosen the search or clear the filters.", action: <Btn label="Clear filters" id="ppl-clear" onClick={clear} /> }
          : { title: "Nothing here yet", text: "Items will appear here when they exist." }}
        columns={[
          { key: "name", label: "Person", sort: (p) => p.name, render: (p) => (
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <Avatar id={p.id} />
              <div><a className="pri" href={hashFor("person", p.id)} onClick={(e) => e.stopPropagation()}>{p.name}</a><span className="sub">{p.title}</span></div>
            </div>
          ) },
          { key: "roles", label: "Roles", render: (p) => <div className="row">{p.roles.length ? p.roles.slice(0, 2).map((g, i) => <Chip key={i} text={roleName(g.role)} cls="plain" />) : <Chip text="No roles" cls="warn" />}</div> },
          { key: "teams", label: "Teams", render: (p) => (p.teams ?? []).map((t) => teams.find((x) => x.id === t)?.name ?? t).join(", ") || "\u2014" },
          { key: "mfa", label: "MFA", render: (p) => <Chip text={p.mfa ? "on" : "off"} cls={p.mfa ? "ok" : "warn"} /> },
          { key: "oncall", label: "On call", render: (p) => (p.oncall ? <Chip text="on call" cls="info" /> : "\u2014") },
          { key: "status", label: "Status", sort: (p) => p.status, render: (p) => <Chip text={p.status} cls={p.status === "active" ? "ok" : p.status === "invited" ? "info" : "plain"} /> },
        ]}
      />
      <Pager id="ppl-pager" page={page} total={sorted.length} onPage={(n) => setQS({ "ppl.page": n ? String(n) : "" })} />
    </Panel>
  );
}
