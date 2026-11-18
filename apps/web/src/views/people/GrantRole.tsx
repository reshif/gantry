/** "Grant a role to <name>" (prototype dialog): Role + Scope. A factory role applies factory-wide and needs a reason (it goes on the ledger; the API asks for a fresh sign-in). */
import { useState } from "react";
import type { Person, Project, Role } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useUI } from "../../ui/overlay-context";
import { Field, Select, type Decision } from "../../ui/primitives";
import { useOutcome } from "../govern/data";

function GrantForm({ p, roles, projects, close, registerSubmit }: { p: Person; roles: Role[]; projects: Project[]; close: () => void; registerSubmit: (fn: () => void) => void }) {
  const outcome = useOutcome();
  const ui = useUI();
  const [role, setRole] = useState(roles.find((r) => r.id === "engineer")?.id ?? roles[0]?.id ?? "");
  const level = roles.find((r) => r.id === role)?.level ?? "project";
  const factory = level === "factory";
  const [scope, setScope] = useState("factory");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  registerSubmit(() => {
    void (async () => {
      const sc = factory ? "factory" : scope;
      if (!role || !sc) return setErr("Pick a role and a scope.");
      if (!factory && sc === "factory") return setErr(`${roles.find((r) => r.id === role)?.name ?? "That role"} applies to one project. Pick the project in Scope.`);
      if (p.roles.some((g) => g.role === role && g.scope === sc && !g.via)) {
        ui.toast("Already granted", "error");
        return setErr("Already granted");
      }
      if (factory && reason.trim().length < 3) return setErr("Say why: a factory role is recorded on the audit log.");
      const r = factory ? await ops.setFactoryRole(p.id, role, true, reason.trim()) : await ops.setMemberRole(p.id, sc, role, true);
      outcome(r, "Role granted");
      if (!r.ok) return setErr(r.msg);
      close();
    })();
  });
  return (
    <div className="form-grid">
      <Field label="Role" htmlFor="ppl-grant-role">
        <Select id="ppl-grant-role" value={role} onChange={setRole} options={roles.map((r) => ({ value: r.id, label: r.name }))} />
      </Field>
      <Field label="Scope" htmlFor="ppl-grant-scope">
        <Select id="ppl-grant-scope" value={factory ? "factory" : scope} onChange={setScope} options={[{ value: "factory", label: "Whole factory" }, ...projects.map((x) => ({ value: x.id, label: x.name }))]} />
      </Field>
      {factory ? (
        <Field label="Reason" htmlFor="ppl-grant-reason">
          <input id="ppl-grant-reason" className="input" autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      ) : null}
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

export function useGrantRole(args: { roles: Role[]; projects: Project[]; guard: Decision }) {
  const ui = useUI();
  return (p: Person) => {
    let submit: () => void = () => undefined;
    ui.dialog({
      title: `Grant a role to ${p.name}`,
      body: (close) => <GrantForm p={p} roles={args.roles} projects={args.projects} close={close} registerSubmit={(fn) => (submit = fn)} />,
      actions: [{ label: "Cancel" }, { label: "Save", kind: "primary", submit: true, id: "ppl-grant-submit", guard: args.guard, onClick: () => submit() }],
    });
  };
}
