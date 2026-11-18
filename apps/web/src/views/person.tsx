/**
 * A person: who they are, the roles they hold (own and from teams), the factory role, roles per project, what the policy
 * engine allows them right now, and their history. Reached from People & teams (one click on a member).
 */
import { qk } from "../api/keys";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fmt, type Person, type Project, type Role } from "@gantry/domain";
import { api, get } from "../api/client";
import { ops } from "../api/ops";
import { useAccessMatrix, useApiKeys, useMe, usePeople, useProjects } from "../api/queries";
import { useCan } from "../api/can";
import { navigate, useHash } from "../lib/router";
import { ExplainDenial } from "./console/ExplainDenial";
import { Avatar, Btn, Empty, Field, LockNote, Panel, Select, Tabs, Toggle, type Decision } from "../ui/primitives";
import { Card, CrEmpty, Page } from "../ui/cr";
import { DataTable } from "../ui/DataTable";
import { useUrlState } from "./govern/urlState";
import { usePeopleLoad } from "./govern/load";
import { Async } from "../ui/async";
import { Icon } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";
import { useActors } from "../ui/actors";
import { agoShort, lastSeenOf, lockd, useOutcome, useTeams } from "./govern/data";
import { HistoryList } from "./people/History";
import { useOffboard } from "./people/Offboard";
import type { EffectivePermissions } from "./people/types";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

export default function PersonView() {
  const loc = useHash();
  const me = useMe();
  const peopleQ = usePeople();
  const teamsQ = useTeams();
  const projects = (useProjects().data ?? me?.projects ?? []) as Project[];
  const roles = useAccessMatrix().data?.roles ?? [];
  const perm = dec(useCan("people.manage"));
  const view = dec(useCan("people.view"));
  if (!me) return null;
  const people = peopleQ.data ?? [];
  const p = people.find((x) => x.id === loc.param);
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  // Default deny: the directory is itself a right. The server refuses the reads too; this shows why instead of an empty screen.
  if (!view.allowed) return <Page cls="view view-person" eyebrow="Govern · Person" title="Person"><Empty id="people-no-access" icon="lock" title="No access to people and teams" text={`${view.reason} ${view.needs ? `${view.needs}. ` : ""}Ask a Factory Admin or Project Admin to give you a role that can see people.`} /></Page>;
  if (!p) {
    return (
      <Async query={peopleQ} what="people" id="person">{() => (
        <Page cls="view view-person" id="person-missing" eyebrow="404" title="Page not found">
          <div className="card"><CrEmpty icon="search" title="There is no “person” page" text="The link may be old, or the page was renamed." action={<Btn label="Go Home" kind="primary" onClick={() => navigate("home")} />} /></div>
        </Page>
      )}</Async>
    );
  }
  const admins = people.filter((x) => x.status === "active" && x.roles.some((g) => g.role === "factory_admin"));
  return (
    <MemberDetail key={p.id} p={p} teams={teamsQ.data ?? []} projects={projects} roles={roles} perm={perm} admins={admins} viewerId={me.person.id} roleName={roleName} />
  );
}

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

/** The Change role dialog body: the role this grant becomes (same level as the grant: a factory role stays a factory role). */
function ChangeRoleForm({ roles, current, level, roleName, onSave }: { roles: Role[]; current: string; level: "factory" | "project"; roleName: (id: string) => string; onSave: (fn: () => string) => void }) {
  const [v, setV] = useState(current);
  onSave(() => v);
  const pool = roles.filter((r) => (level === "factory" ? r.level === "factory" : r.level !== "factory"));
  return (
    <div className="form-grid">
      <Field label="Role" htmlFor="ppl-chrole">
        <Select id="ppl-chrole" value={v} onChange={setV} options={[...(level === "factory" ? [{ value: "", label: "None (project roles only)" }] : []), ...pool.map((r) => ({ value: r.id, label: roleName(r.id) }))]} />
      </Field>
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
  const [tab, setTab] = useUrlState("tab", "profile");
  const [cell, setCell] = useState<{ action: string; project: string } | null>(null);
  const eff = useQuery({ queryKey: qk.effectivePermissions(p.id), queryFn: () => get<EffectivePermissions>(api(`people/${encodeURIComponent(p.id)}/effective-permissions`)) });
  const keysQ = useApiKeys();
  const away = p.away && p.away.to > Date.now() ? p.away : null;
  const visible = projects.filter((x) => x.status !== "archived");
  const load = usePeopleLoad(visible);
  const frRole = p.roles.find((g) => g.scope === "factory" && !g.via)?.role ?? "";
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const scopeName = (s: string) => (s === "factory" ? "Whole factory" : projects.find((x) => x.id === s)?.name ?? s);
  const projectRoles = roles.filter((r) => r.level !== "factory");

  let factGuard: Decision = perm;
  if (perm.allowed && p.id === viewerId) factGuard = lockd("You cannot change your own factory role. Ask another Factory Admin.");
  else if (perm.allowed && frRole === "factory_admin" && admins.length < 2) factGuard = lockd(`${p.name} is the only Factory Admin. Make someone else a Factory Admin first.`);

  /** Move from one factory role (or none) to another. Each step is its own audited grant or revoke with the same reason. */
  const swapFactoryRole = async (from: string, to: string, reason: string): Promise<{ ok: boolean; msg: string }> => {
    if (from && from !== to) {
      const r = await ops.setFactoryRole(p.id, from, false, reason);
      if (!r.ok) return r;
    }
    if (to) return ops.setFactoryRole(p.id, to, true, reason);
    return { ok: true, msg: "" };
  };

  // A factory role reaches every project (Wave 3, F7): ask why (it goes on the ledger), and offer to undo straight after.
  const changeFactoryRole = (v: string) => {
    const prev = frRole;
    if (v === prev) return;
    ui.reasonDialog({
      title: v ? `Make ${p.name} ${roleName(v)}?` : `Remove ${roleName(prev)} from ${p.name}?`,
      kicker: "Factory role",
      sub: `A factory role applies on every project. The reason is recorded on the audit log${prev && v ? `, and replaces ${roleName(prev)}` : ""}. You may be asked to sign in again.`,
      label: "Reason",
      placeholder: v ? "Why does this person need it?" : "Why is it no longer needed?",
      ok: v ? `Grant ${roleName(v)}` : "Remove role",
      kind: v ? "primary" : "danger",
      min: 3,
      onOk: async (reason) => {
        const r = await swapFactoryRole(prev, v, reason);
        if (!r.ok) return r;
        const undo = () =>
          void swapFactoryRole(v, prev, `Undo: ${reason}`).then((u) => ui.toast(u.ok ? (prev ? `${p.name} is ${roleName(prev)} again.` : `${p.name} has no factory role again.`) : u.msg, u.ok ? "ok" : "error"));
        ui.toast(v ? `${p.name} is now ${roleName(v)} across the factory.` : `${p.name} has no factory role now.`, "ok", { label: "Undo", id: "ppl-frole-undo", onClick: undo });
        return { ok: true };
      },
    });
  };

  /** Change role for one grant row: a factory grant goes through the reason dialog, a project grant swaps the role in that project. */
  const changeRole = (g: { role: string; scope: string }) => {
    let pick: () => string = () => g.role;
    const factory = g.scope === "factory";
    ui.dialog({
      title: `Change role for ${p.name}`, kicker: "People",
      body: <ChangeRoleForm roles={roles} current={g.role} level={factory ? "factory" : "project"} roleName={roleName} onSave={(fn) => (pick = fn)} />,
      actions: [{ label: "Cancel" }, { label: "Save", kind: "primary", submit: true, id: "ppl-chrole-save", guard: factory ? factGuard : perm, onClick: (close) => {
        const v = pick();
        close();
        if (v === g.role) return;
        if (factory) { changeFactoryRole(v); return; }
        void (async () => {
          const rm = await ops.setMemberRole(p.id, g.scope, g.role, false);
          if (!rm.ok) return void outcome(rm);
          outcome(await ops.setMemberRole(p.id, g.scope, v, true), "Role changed");
        })();
      } }],
    });
  };

  const openTeams = () => {
    let save: () => Promise<boolean> = async () => false;
    ui.dialog({
      title: `Teams for ${p.name}`, kicker: "People", sub: "Teams group people and own repos. Permissions come from roles, not teams.",
      body: <TeamsForm p={p} teams={teams} perm={perm} onSave={(fn) => (save = fn)} />,
      actions: [{ label: "Cancel" }, { label: "Save teams", kind: "primary", submit: true, id: "ppl-tm-save", guard: perm, onClick: (close) => void save().then((ok) => ok && close()) }],
    });
  };

  const offboard = useOffboard({ perm, projects, roleName });
  const off = p.status === "deactivated";
  let offGuard: Decision = perm;
  if (perm.allowed && p.id === viewerId) offGuard = lockd("You cannot deactivate yourself. Ask another Factory Admin.");
  else if (perm.allowed && p.status === "active" && p.roles.some((g) => g.role === "factory_admin" && !g.via) && admins.length < 2) offGuard = lockd(`${p.name} is the only Factory Admin. Make someone else a Factory Admin first.`);

  const selDecision = useSelectedCell(p.id, cell);
  const stateWord = p.status === "invited" ? "Invited" : p.status === "deactivated" ? "Deactivated" : "Active";
  const teamNames = (p.teams ?? []).map(teamName).join(", ") || "No team";
  const primary = p.roles.find((g) => g.scope === "factory" && !g.via)?.role ?? p.roles.find((g) => !g.via)?.role ?? p.roles[0]?.role;
  const ownedBy = projects.filter((x) => x.owner === p.id).map((x) => x.name);
  const keys = keysQ.data ? keysQ.data.filter((k) => k.by === p.id && !k.revoked && !k.expired).length : null;
  const requested = visible.reduce((n, pr) => n + load.requested(p.id, pr.id), 0);
  const NA = <span className="dim" title="Not available to you, or the server did not answer">not available</span>;
  const grants = p.roles.map((g, i) => ({ ...g, key: `${g.role}-${g.scope}-${g.via ?? ""}-${i}` }));

  return (
    <Page
      cls="view view-person"
      eyebrow="Govern · Person"
      title={p.name}
      sub={p.title || "No title yet"}
      acts={(
        <>
          <Btn label="All people" id="ppl-all" onClick={() => navigate("people")} />
          {off
            ? <Btn label="Reactivate" id="ppl-reactivate" guard={perm} onClick={() => offboard.reactivate(p)} />
            : <Btn label="Deactivate…" kind="danger" id="ppl-deactivate" guard={offGuard} onClick={() => offboard.deactivate(p, offGuard)} />}
        </>
      )}
    >
      <LockNote decision={perm} what="Roles, teams and access" />
      <div className="person-stack">
      <div className="row ppl-badges" style={{ marginBottom: 16 }}>
        <Avatar id={p.id} size="sm" />
        <span className={`chip ${p.status === "active" ? "ok" : p.status === "invited" ? "info" : "idle"}`}>{stateWord}</span>
        {primary ? <span className="chip info plain">{roleName(primary)}</span> : null}
        {p.oncall ? <span className="chip agent" data-tip="On call for at least one project, or a Factory Admin (always on call). Project admins set who is on call in Project config." tabIndex={0}>on call</span> : null}
        {away ? <span className="chip warn">{`Away until ${fmt.istDate(away.to)}, delegate ${actors(away.delegate).name}`}</span> : null}
      </div>
      <Tabs idPrefix="person-tab" items={[{ id: "profile", label: "Profile" }, { id: "access", label: "Access" }, { id: "activity", label: "Activity" }]} active={tab} onChange={setTab} />
      {tab === "profile" ? (
      <div className="grid g2">
        <Card title="Profile" id="ppl-profile-card" acts={<>
          {p.status === "invited" ? <Btn label="Mark invite accepted" small id="ppl-accept" guard={perm} onClick={async () => void outcome(await ops.acceptInvite(p.id))} /> : null}
        </>}>
          <dl className="kv" id="ppl-profile" style={{ margin: 0 }}>
            <dt>Email</dt><dd className="mono">{p.email}</dd>
            <dt>Title</dt><dd>{p.title || "No title yet"}</dd>
            <dt>Team</dt><dd>{teamNames}{" "}<Btn label="Change" small kind="ghost" id="ppl-teams" guard={perm} onClick={openTeams} /></dd>
            <dt>MFA</dt><dd>{p.mfa === undefined ? "–" : p.mfa ? "On" : "Off"}</dd>
            {/* The API does not report a last sign-in time: say so instead of inventing one. */}
            <dt>Last seen</dt><dd>{lastSeenOf(p) ? agoShort(lastSeenOf(p)!) : NA}</dd>
          </dl>
        </Card>
        <Card title="Holds right now" id="ppl-holds-card">
          <dl className="kv" id="ppl-holds" style={{ margin: 0 }}>
            <dt>Open work orders</dt><dd>{load.loading ? "…" : load.partial && !requested ? NA : requested}</dd>
            <dt>Eligible to approve</dt><dd>{load.loading ? "…" : load.partial ? NA : `${load.eligible(p.id)} pending`}</dd>
            <dt>API keys</dt><dd>{keys === null ? NA : keys}</dd>
            <dt>Projects owned</dt><dd>{ownedBy.join(", ") || "none"}</dd>
          </dl>
        </Card>
      </div>
      ) : null}
      {tab === "access" ? (<>
      <Card title="Roles" id="ppl-roles-card" flush>
        <DataTable
          id="ppl-roles"
          caption={`Roles of ${p.name}`}
          rows={grants}
          rowKey={(g) => g.key}
          empty={{ title: "No roles yet", text: `${p.name} holds no role. Grant one on a project below, or a factory role from the invite.` }}
          columns={[
            { key: "role", label: "Role", render: (g) => <span className="chip info plain">{roleName(g.role)}</span> },
            { key: "scope", label: "Scope", render: (g) => (g.scope === "factory" ? "Whole factory" : <span className="tag">{(projects.find((x) => x.id === g.scope) as (Project & { key?: string }) | undefined)?.key ?? scopeName(g.scope)}</span>) },
            { key: "via", label: "", align: "end", render: (g) => (g.via
              ? <span className="dim small">{`via ${teamName(g.via)}: change it on the team`}</span>
              : <Btn label="Change role" small id={`ppl-chrole-${g.scope}`} guard={g.scope === "factory" ? factGuard : perm} onClick={() => changeRole(g)} />) },
          ]}
        />
      </Card>
      <Panel title="Roles per project" flush>
        <p className="muted small ppl-hint ppl-hint-pad">One person can hold different roles in each project. A role granted by a team shows as "via team" and is changed on the team. A switch is locked where you cannot manage that project's members.</p>
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
      </Panel>

      <Panel
        title="Effective permissions now"
        tools={(
          <>
            <span className="mono muted small">{`${fmt.ist(Date.now())} IST`}</span>
            <Select id="ppl-eff-proj" aria-label="Project for effective permissions" value={effProject} onChange={setEffProject} options={[{ value: "all", label: "All projects" }, ...visible.map((x) => ({ value: x.id, label: x.name }))]} />
          </>
        )}
      >
        <p className="muted small ppl-hint">Roles, scope, release windows, on-call rules and freezes combined, as the policy engine decides them right now. Hover or focus a cell for the deciding rule and where the role comes from. P-numbers mark cells decided by a policy; T marks cells allowed only through a team.</p>
        <Async query={eff} what="effective permissions" id="ppl-eff" rows={4}>{(effData) => (
          <>
            <EffTable p={p} eff={effData} project={effProject} cell={cell} onPick={setCell} />
            <CellDetail p={p} eff={effData} cell={cell} decision={selDecision.data} />
          </>
        )}</Async>
      </Panel>

      <Panel title="Factory-wide capabilities">
        <p className="muted small ppl-hint">Actions that apply to the whole factory, not one project.</p>
        <Async query={eff} what="factory-wide capabilities" id="ppl-fact" rows={2}>{(effData) => (
          <ul className="caps caps-grid">
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
        )}</Async>
      </Panel>

      </>) : null}

      {tab === "activity" ? (
      <Card title="Recent activity" id="ppl-activity-card">
        <span id="ppl-history" className="person-anchor" />
        <HistoryList id={p.id} limit={6} />
      </Card>
      ) : null}
      </div>
    </Page>
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
    queryKey: qk.permissionCell(person, cell?.action, cell?.project),
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
            <tr key={`g-${g}`} className="ppl-grp"><th scope="rowgroup" colSpan={shown.length + 1}>{g === "Stops" ? "Stops: kill switches and restore" : g}</th></tr>,
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
  if (!cell || !a || !pr) return <p className="muted small ppl-cell-hint">Select a cell to see the deciding rule, the reason and what would allow it.</p>;
  const d = decision?.decision;
  if (!d) return <p className="muted small ppl-cell-hint" aria-live="polite">Asking the policy engine.</p>;
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

