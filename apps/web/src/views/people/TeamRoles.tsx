import { useState } from "react";
import type { Project, Role, Team } from "@gantry/domain";
import { fmt } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useUI } from "../../ui/overlay-context";
import { Btn, Field, LockNote, Select, type Decision } from "../../ui/primitives";
import { useOutcome } from "../govern/data";

/** Factory Admin stays a grant to named people: team membership changes would bypass the last-admin rules (spec 8.9, 14.4). */
export const grantableToTeam = (roles: Role[]): Role[] => roles.filter((r) => r.id !== "factory_admin");

/** Add a role to a team: POST /teams/{id}/roles. A factory role applies on the factory, a project role on one project. */
function GrantForm({ team, roles, projects, perm, close, registerSubmit }: { team: Team; roles: Role[]; projects: Project[]; perm: Decision; close: () => void; registerSubmit: (fn: () => void) => void }) {
  const outcome = useOutcome();
  const options = grantableToTeam(roles);
  const [role, setRole] = useState(options.find((r) => r.level !== "factory")?.id ?? options[0]?.id ?? "");
  const [scope, setScope] = useState(projects[0]?.id ?? "");
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const level = options.find((r) => r.id === role)?.level ?? "project";

  registerSubmit(() => {
    void (async () => {
      if (!role) return setErr("Pick a role.");
      if (level !== "factory" && !scope) return setErr("Pick a project.");
      const expiresAt = until ? new Date(`${until}T23:59:59`).getTime() : null;
      if (expiresAt !== null && expiresAt <= Date.now()) return setErr("The expiry must be in the future.");
      if (level === "factory" && reason.trim().length < 3) return setErr("Say why the team needs a factory role: it is recorded on the audit log.");
      const r = await ops.addTeamRole(team.id, { role, scope: level === "factory" ? "factory" : scope, ...(expiresAt !== null ? { expiresAt } : {}), ...(level === "factory" ? { reason: reason.trim() } : {}) });
      outcome(r);
      if (!r.ok) return setErr(r.msg);
      close();
    })();
  });

  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Team roles" />
      <Field label="Role" htmlFor="ppl-tr-role" hint="Everyone in the team gets this role while they are in the team. Factory Admin is granted to named people only.">
        <Select id="ppl-tr-role" value={role} onChange={setRole} options={options.map((r) => ({ value: r.id, label: `${r.name} (${r.level === "factory" ? "factory" : "project"})` }))} />
      </Field>
      {level === "factory" ? (
        <Field label="Reason" htmlFor="ppl-tr-reason" hint="This role applies across the whole factory. The reason is recorded on the audit log.">
          <input id="ppl-tr-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why does this team need it?" />
        </Field>
      ) : (
        <Field label="Project" htmlFor="ppl-tr-scope">
          <Select id="ppl-tr-scope" value={scope} onChange={setScope} options={projects.map((p) => ({ value: p.id, label: p.name }))} />
        </Field>
      )}
      <Field label="Ends (optional)" htmlFor="ppl-tr-until" hint="Leave empty for no end date.">
        <input id="ppl-tr-until" className="input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
      </Field>
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

/** The roles a team holds, with add and remove. Guarded by people.manage; a denial shows the server's reason. */
export function TeamRoles({ team, roles, projects, perm, members }: { team: Team; roles: Role[]; projects: Project[]; perm: Decision; members: number }) {
  const ui = useUI();
  const outcome = useOutcome();
  const grants = team.roles ?? [];
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const where = (s: string) => (s === "factory" ? "Factory" : projects.find((p) => p.id === s)?.name ?? s);
  const add = () => {
    let submit: () => void = () => undefined;
    ui.dialog({
      title: `Add a role to ${team.name}`, kicker: "People & teams",
      sub: `${members} member${members === 1 ? "" : "s"} will get it, and anyone who joins later.`,
      body: (close) => <GrantForm team={team} roles={roles} projects={projects} perm={perm} close={close} registerSubmit={(fn) => (submit = fn)} />,
      actions: [{ label: "Cancel" }, { label: "Add role", kind: "primary", icon: "plus", submit: true, id: "ppl-tr-submit", guard: perm, onClick: () => submit() }],
    });
  };
  const remove = async (g: NonNullable<Team["roles"]>[number]) => {
    if (g.scope === "factory") {
      // a factory-level grant: the reason goes on the ledger
      ui.reasonDialog({
        title: `Remove ${roleName(g.role)} from ${team.name}?`, kicker: "People & teams", kind: "danger", ok: "Remove role", label: "Reason", min: 3,
        sub: `${members} member${members === 1 ? "" : "s"} lose${members === 1 ? "s" : ""} ${roleName(g.role)} across the factory unless they hold it another way. The reason is recorded on the audit log.`,
        onOk: async (reason) => {
          const r = await ops.removeTeamRole(team.id, g.id, reason);
          if (!r.ok) return r;
          outcome(r);
          return { ok: true };
        },
      });
      return;
    }
    const ok = await ui.confirm({
      title: `Remove ${roleName(g.role)} from ${team.name}?`, kicker: "People & teams", kind: "danger", ok: "Remove role",
      body: <p>{`${members} member${members === 1 ? "" : "s"} lose${members === 1 ? "s" : ""} ${roleName(g.role)} on ${where(g.scope)} unless they hold it another way.`}</p>,
    });
    if (ok) outcome(await ops.removeTeamRole(team.id, g.id));
  };
  return (
    <div className="team-roles" id={`ppl-tr-${team.id}`}>
      <span className="kicker">Roles</span>
      {grants.length ? (
        <ul className="team-grants" aria-label={`Roles held by ${team.name}`}>
          {grants.map((g) => (
            <li key={g.id} className="chip team-grant">
              <span>{`${roleName(g.role)} · ${where(g.scope)}${g.expiresAt ? ` · until ${fmt.istDate(g.expiresAt)}` : ""}`}</span>
              <button type="button" className="chip-x" id={`ppl-tr-rm-${team.id}-${g.id}`} aria-label={`Remove ${roleName(g.role)} on ${where(g.scope)} from ${team.name}`} aria-disabled={!perm.allowed} title={perm.allowed ? "" : perm.reason} onClick={() => (perm.allowed ? void remove(g) : ui.toast(perm.reason, "warn"))}>×</button>
            </li>
          ))}
        </ul>
      ) : (
        <span className="muted small">No roles: members get access only from their own grants.</span>
      )}
      <Btn label="Add role" small kind="ghost" icon="plus" id={`ppl-tr-add-${team.id}`} guard={perm} onClick={add} />
    </div>
  );
}
