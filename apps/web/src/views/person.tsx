/**
 * A person (prototype "people/<id>"): KPI row, §1 Roles (flush rows, remove, Grant role), §2 Details, §3 the open work orders they
 * requested. Team editing sits on the Teams row, the invite acceptance on the Invite row, and the history below the sheet.
 */
import { useState } from "react";
import { WO_STATES, fmt, type Person, type Project, type Role } from "@gantry/domain";
import { ops } from "../api/ops";
import { useAccessMatrix, useMe, usePeople, useProjects, useWorkOrdersAcross } from "../api/queries";
import { useCan } from "../api/can";
import { hashFor, useHash } from "../lib/router";
import { Btn, Empty, LockNote, Panel, Stat, StatRow, Toggle, ViewHead, type Decision } from "../ui/primitives";
import { Async } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { useActors } from "../ui/actors";
import { lockd, useOutcome, useTeams } from "./govern/data";
import { HistoryList } from "./people/History";
import { useOffboard } from "./people/Offboard";
import { useGrantRole } from "./people/GrantRole";

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
  const crumbs = [{ label: "People & teams", href: "#people" }, { label: p?.name ?? "Person" }];
  // Default deny: the directory is itself a right. The server refuses the reads too; this shows why instead of an empty screen.
  if (!view.allowed) return <div className="view view-person"><ViewHead title="Person" crumbs={crumbs} /><Empty id="people-no-access" icon="lock" title="No access to this sheet" text={`${view.reason} ${view.needs ? `${view.needs}. ` : ""}Ask a Factory Admin or Project Admin to give you a role that can see people.`} /></div>;
  if (!p) {
    return (
      <div className="view view-person">
        <ViewHead title="Person" crumbs={crumbs} />
        <Async query={peopleQ} what="people" id="person">{() => <Empty id="person-missing" icon="user" title="Nothing to show" text="That person does not exist." action={<a className="btn" id="person-back" href="#people">Back to people</a>} />}</Async>
      </div>
    );
  }
  const admins = people.filter((x) => x.status === "active" && x.roles.some((g) => g.role === "factory_admin"));
  return (
    <div className="view view-person">
      <LockNote decision={perm} what="Roles, teams and access" />
      <MemberDetail key={p.id} p={p} teams={teamsQ.data ?? []} projects={projects} roles={roles} perm={perm} admins={admins} viewerId={me.person.id} roleName={roleName} />
    </div>
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

const TONE: Record<string, string> = { running: "info", waiting: "warn", blocked: "bad", failed: "bad", killed: "bad", done: "ok" };
/** Compact state chip as the prototype draws it: a waiting order reads "AT <gate>". */
function WoChip({ w }: { w: { state: string; gates?: Record<string, { status?: string }> } }) {
  const gate = w.state === "waiting" ? Object.entries(w.gates ?? {}).find(([, g]) => g.status === "waiting")?.[0] : undefined;
  const label = gate ? `at ${gate}` : (WO_STATES as Record<string, { label: string }>)[w.state]?.label ?? w.state;
  return <span className={`chip ${TONE[w.state] ?? "plain"}`}>{label}</span>;
}

function RoleRow({ g, roleName, scopeName, teamName, guard, onRemove }: { g: Person["roles"][number]; roleName: (id: string) => string; scopeName: (s: string) => string; teamName: (id: string) => string; guard: Decision; onRemove: () => void }) {
  return (
    <li id={`ppl-role-${g.role}-${g.scope}${g.via ? `-${g.via}` : ""}`}>
      <div className="grow">{roleName(g.role)}<span className="small muted">{` \u00b7 ${g.scope === "factory" ? "whole factory" : scopeName(g.scope)}${g.via ? ` \u00b7 via ${teamName(g.via)}` : ""}`}</span></div>
      {g.via ? null : <Btn icon="x" aria="Remove role" small kind="ghost" cls="icon" guard={guard} onClick={onRemove} />}
    </li>
  );
}

function ProjectRoleRow(props: Omit<Parameters<typeof RoleRow>[0], "guard"> & { projectScope: string; self: boolean; perm: Decision }) {
  const { projectScope, self, perm, ...rest } = props;
  const d = dec(useCan("project.members", { project: projectScope }));
  let guard: Decision = d;
  if (d.allowed && self && rest.g.role === "project_admin") guard = lockd("You cannot remove your own Project Admin role. Ask another Project Admin or a Factory Admin.");
  void perm;
  return <RoleRow {...rest} guard={guard} />;
}

function MemberDetail({ p, teams, projects, roles, perm, admins, viewerId, roleName }: {
  p: Person; teams: Array<{ id: string; name: string }>; projects: Project[]; roles: Role[]; perm: Decision; admins: Person[]; viewerId: string; roleName: (id: string) => string;
}) {
  const ui = useUI();
  const outcome = useOutcome();
  const actors = useActors();
  const away = p.away && p.away.to > Date.now() ? p.away : null;
  const frRole = p.roles.find((g) => g.scope === "factory" && !g.via)?.role ?? "";
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const scopeName = (s: string) => (s === "factory" ? "Factory" : projects.find((x) => x.id === s)?.name ?? s);
  const visible = projects.filter((x) => x.status !== "archived");

  let factGuard: Decision = perm;
  if (perm.allowed && p.id === viewerId) factGuard = lockd("You cannot change your own factory role. Ask another Factory Admin.");
  else if (perm.allowed && frRole === "factory_admin" && admins.length < 2) factGuard = lockd(`${p.name} is the only Factory Admin. Make someone else a Factory Admin first.`);

  const grant = useGrantRole({ roles, projects: visible, guard: perm });

  const removeFactoryRole = (role: string) =>
    ui.reasonDialog({
      title: `Remove ${roleName(role)} from ${p.name}?`,
      kicker: "Factory role",
      sub: "A factory role applies on every project. The reason is recorded on the audit log. You may be asked to sign in again.",
      label: "Reason", placeholder: "Why is it no longer needed?", ok: "Remove role", kind: "danger", min: 3,
      onOk: async (reason) => {
        const r = await ops.setFactoryRole(p.id, role, false, reason);
        if (!r.ok) return r;
        ui.toast("Role removed", "ok", { label: "Undo", id: "ppl-frole-undo", onClick: () => void ops.setFactoryRole(p.id, role, true, `Undo: ${reason}`).then((u) => ui.toast(u.ok ? `${roleName(role)} is back.` : u.msg, u.ok ? "ok" : "error")) });
        return { ok: true };
      },
    });

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

  // open work orders this person requested, across every project the viewer can read
  const wos = useWorkOrdersAcross(visible.map((x) => x.id));
  const held = wos.items.filter((w) => w.requestedBy === p.id && w.state !== "done" && w.state !== "killed");
  const teamNames = (p.teams ?? []).map(teamName).join(", ") || "\u2014";
  const oncallLock = lockd("On-call is set per project, in Project config. There is no per-person switch yet.");

  return (
    <div className="person-stack" aria-label={p.name}>
      <ViewHead
        crumbs={[{ label: "People & teams", href: "#people" }, { label: p.name }]}
        title={p.name}
        sub={<>{`${p.title || "No title yet"} \u00b7 `}<span className="mono">{p.email}</span></>}
        actions={off
          ? <Btn label="Reactivate" id="ppl-reactivate" guard={perm} onClick={() => offboard.reactivate(p)} />
          : <Btn label="Deactivate" kind="danger" id="ppl-deactivate" guard={offGuard} onClick={() => offboard.deactivate(p, offGuard)} />}
      />
      <StatRow id="ppl-stats">
        <Stat label="Status" value={p.status} tone={p.status === "active" ? "done" : "wait"} />
        <Stat label="MFA" value={p.mfa ? "On" : "Off"} tone={p.mfa ? "done" : "wait"} />
        <Stat label="Open work orders" value={wos.pending ? "\u2026" : wos.failed && !held.length ? "n/a" : String(held.length)} sub="requested" />
        <Stat label="On call" value={p.oncall ? "Yes" : "No"} />
      </StatRow>
      <div className="cols">
        <Panel title="Roles" flush id="ppl-held">
          <ul className="list">
            {p.roles.map((g) => {
              const common = { key: `${g.role}-${g.scope}-${g.via ?? ""}`, g, roleName, scopeName, teamName };
              return g.scope === "factory"
                ? <RoleRow {...common} guard={factGuard} onRemove={() => removeFactoryRole(g.role)} />
                : <ProjectRoleRow {...common} projectScope={g.scope} self={p.id === viewerId} perm={perm} onRemove={async () => void outcome(await ops.setMemberRole(p.id, g.scope, g.role, false), "Role removed")} />;
            })}
            {p.roles.length ? null : <li className="muted">No roles. This person cannot see any project.</li>}
          </ul>
          <div style={{ padding: "12px 14px" }}><Btn label="Grant role" icon="plus" id="ppl-grant" guard={perm} onClick={() => grant(p)} /></div>
        </Panel>
        <Panel title="Details">
          <dl className="kv">
            <dt>Teams</dt><dd>{teamNames} <Btn label="Edit teams" small kind="ghost" id="ppl-teams" guard={perm} onClick={openTeams} /></dd>
            <dt>GitHub</dt><dd>{p.github || "Not linked"}</dd>
            <dt>Away</dt><dd>{away ? `Until ${fmt.istDate(away.to)}, delegate ${actors(away.delegate).name}` : "Available"}</dd>
            <dt>On call</dt><dd><div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}><span>On call rotation</span><Toggle id="ppl-oncall" checked={!!p.oncall} decision={oncallLock} label="On call rotation" /></div></dd>
            {p.status === "invited" ? <><dt>Invite</dt><dd>Pending <Btn label="Mark invite accepted" small kind="ghost" id="ppl-accept" guard={perm} onClick={async () => void outcome(await ops.acceptInvite(p.id))} /></dd></> : null}
          </dl>
        </Panel>
      </div>
      <Panel title="Open work orders requested" flush id="ppl-requested">
        {held.length ? (
          <ul className="list">
            {held.slice(0, 8).map((w) => (
              <li key={w.id}>
                <a className="mono pri" href={hashFor("record", w.id, w.project)}>{w.id}</a>
                <span className="grow trunc">{w.title}</span>
                <WoChip w={w} />
              </li>
            ))}
          </ul>
        ) : <div className="empty">{wos.pending ? "Loading." : wos.failed ? "Some projects could not be read." : "Nothing open."}</div>}
      </Panel>
      <Panel title="History" id="ppl-history-panel">
        <HistoryList id={p.id} limit={8} />
      </Panel>
    </div>
  );
}
