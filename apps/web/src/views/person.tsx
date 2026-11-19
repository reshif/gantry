/**
 * A person (prototype "people/<id>"): KPI row, §1 Roles (flush rows, remove, Grant role), §2 Details, §3 the open work orders they
 * requested. Team editing sits on the Teams row, the invite acceptance on the Invite row, and the history below the sheet.
 */
import { WO_STATES, type Person, type Project, type Role } from "@gantry/domain";
import { commands as ops } from "../api/commands";
import { useAccessMatrix, useMe, usePeople, useProjects, useWorkOrdersOfProjects } from "../api/queries";
import { useCan } from "../api/can";
import { hashFor, useHash } from "../lib/router";
import { PROJECT_ADMIN } from "../lib/roles";
import { Btn, Empty, LockNote, Panel, Stat, StatRow, Toggle, ViewHead, type Decision } from "../ui/primitives";
import { Async } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { fmtDay, ifMatchOf, lockd, useOutcome, useTeams } from "./govern/data";
import { useOffboard } from "./people/Offboard";
import { useGrantRole } from "./people/GrantRole";
import { useEditTeams } from "./people/PersonTeams";
import "../styles/views/people.css";

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
  const people = peopleQ.data;
  const p = people?.find((x) => x.id === loc.param);
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  // Default deny: the directory is itself a right. The server refuses the reads too; this shows why instead of an empty screen.
  if (!view.allowed) return <div className="view view-person"><ViewHead title="Person" /><Empty id="people-no-access" icon="lock" title="No access to this sheet" text={`${view.reason} ${view.needs ? `${view.needs}. ` : ""}Ask a Factory Admin or Project Admin to give you a role that can see people.`} /></div>;
  if (!p) {
    return (
      <div className="view view-person">
        <ViewHead title="Person" />
        <Panel><Async query={peopleQ} what="people" id="person">{() => <Empty id="person-missing" icon="user" title="Nothing to show" text="That person does not exist." action={<a className="btn" id="person-back" href={hashFor("work-orders")}>Work orders</a>} />}</Async></Panel>
      </div>
    );
  }
  return (
    <div className="view view-person">
      <LockNote decision={perm} what="Roles, teams and access" />
      <MemberDetail key={p.id} p={p} teams={teamsQ.data ? teamsQ.data : []} projects={projects} roles={roles} perm={perm} viewerId={me.person.id} roleName={roleName} />
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
  if (d.allowed && self && rest.g.role === PROJECT_ADMIN) guard = lockd("You cannot remove your own Project Admin role. Ask another Project Admin or a Factory Admin.");
  void perm;
  return <RoleRow {...rest} guard={guard} />;
}

function MemberDetail({ p, teams, projects, roles, perm, viewerId, roleName }: {
  p: Person; teams: Array<{ id: string; name: string }>; projects: Project[]; roles: Role[]; perm: Decision; viewerId: string; roleName: (id: string) => string;
}) {
  const ui = useUI();
  const outcome = useOutcome();
  const away = p.away && p.away.to > Date.now() ? p.away : null;
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const scopeName = (s: string) => (s === "factory" ? "Factory" : projects.find((x) => x.id === s)?.name ?? s);
  const visible = projects.filter((x) => x.status !== "archived");

  let factGuard: Decision = perm;
  if (perm.allowed && p.id === viewerId) factGuard = lockd("You cannot change your own factory role. Ask another Factory Admin.");

  const grant = useGrantRole({ roles, projects: visible, guard: perm });
  const editTeams = useEditTeams({ teams, guard: perm });

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

  const offboard = useOffboard({ perm, projects, roleName });
  const off = p.status === "deactivated";
  let offGuard: Decision = perm;
  if (perm.allowed && p.id === viewerId) offGuard = lockd("You cannot deactivate yourself. Ask another Factory Admin.");

  // open work orders this person requested, across every project the viewer can read
  const wos = useWorkOrdersOfProjects(visible.map((x) => x.id));
  const held = wos.items.filter((w) => w.requestedBy === p.id && w.state !== "done" && w.state !== "killed");
  const teamNames = (p.teams ?? []).map(teamName).join(", ") || "No team";
  // On-call is kept per project (a project's admins choose; Factory Admins always count). The person switch edits the lists of the
  // projects this person is a member of (on) or sits on (off); the server applies its own rules to each list.
  const setOncall = async (on: boolean) => {
    const memberOf = new Set(p.roles.filter((g) => g.scope !== "factory").map((g) => g.scope));
    const targets = projects.filter((x) => (on ? memberOf.has(x.id) && !x.oncall?.includes(p.id) : !!x.oncall?.includes(p.id)));
    if (!targets.length) return void ui.toast(on ? "No project to add them to: they hold no project role. Factory Admins always count as on call. Set it per project in Project config." : "Not on call for any project.", "warn");
    let okAll = true;
    for (const x of targets) {
      const list = on ? [...(x.oncall ?? []), p.id] : (x.oncall ?? []).filter((id) => id !== p.id);
      const r = await ops.setProjectOncall(x.id, list, ifMatchOf(x));
      if (!r.ok) { okAll = false; ui.toast(r.msg, "error"); break; }
    }
    if (okAll) ui.toast(on ? "Added to on-call" : "Removed from on-call", "ok");
  };

  return (
    <div className="person-stack" aria-label={p.name}>
      <ViewHead
        crumbs={[{ label: "People & teams", href: hashFor("people") }, { label: p.name }]}
        title={p.name}
        sub={<>{`${p.title || "No title yet"} \u00b7 `}<span className="mono">{p.email}</span></>}
        actions={off
          ? <Btn label="Reactivate" id="ppl-reactivate" guard={perm} onClick={() => offboard.reactivate(p)} />
          : (
            <>
              <Btn label="Reset authenticator" id="ppl-reset-mfa" guard={p.id === viewerId && perm.allowed ? lockd("Ask another administrator to reset your authenticator.") : perm} onClick={() => offboard.resetMfa(p, perm)} />
              <Btn label="Deactivate" kind="danger" id="ppl-deactivate" guard={offGuard} onClick={() => offboard.deactivate(p, offGuard)} />
            </>
          )}
      />
      <StatRow id="ppl-stats">
        <Stat label="Status" value={p.status} tone={p.status === "active" ? "done" : "wait"} />
        <Stat label="MFA" value={p.mfa ? "Enrolled" : "Not enrolled"} sub={p.mfa ? "signed in with a second factor" : "needs an enrolment link"} tone={p.mfa ? "done" : "wait"} />
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
            <dt>Teams</dt><dd>{teamNames}{" "}<Btn label="Change" small kind="ghost" id="ppl-teams" guard={perm} onClick={() => editTeams(p)} /></dd>
            <dt>GitHub</dt><dd>{p.github || "Not linked"}</dd>
            <dt>Away</dt><dd>{away ? `Until ${fmtDay(away.to)}` : "Available"}</dd>
            <dt>On call</dt><dd><div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}><span>On call rotation</span><Toggle id="ppl-oncall" checked={!!p.oncall} decision={perm} label="On call rotation" onChange={(v) => void setOncall(v)} /></div></dd>
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
    </div>
  );
}
