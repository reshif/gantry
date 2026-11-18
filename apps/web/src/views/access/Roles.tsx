import { useState } from "react";
import type { Action, Matrix, Person, Role } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Chip, Field, LockNote, Segmented, Select, type Decision } from "../../ui/primitives";
import { DataTable } from "../../ui/DataTable";
import { useUI } from "../../ui/overlay-context";
import { ifMatchOf, lockd, useOutcome } from "../govern/data";

export function RoleForm({ existing, perm, roles, matrix, actions, registerSubmit, close, onCreated }: {
  existing: Role | null; perm: Decision; roles: Role[]; matrix: Matrix; actions: Action[]; registerSubmit: (fn: () => void) => void; close: () => void; onCreated: (id: string) => void;
}) {
  const outcome = useOutcome();
  const [name, setName] = useState(existing?.name ?? "");
  const [desc, setDesc] = useState(existing?.desc ?? "");
  const [level, setLevel] = useState<string>("project");
  const [base, setBase] = useState("viewer");
  const [err, setErr] = useState("");
  const grants = (id: string) => actions.filter((a) => matrix[id]?.[a.id]).length;
  registerSubmit(() => {
    void (async () => {
      const r = existing
        ? outcome(await ops.updateRole(existing.id, { name, desc }, ifMatchOf(existing)))
        : outcome(await ops.addRole({ name, level, base, desc }));
      if (!r.ok) return setErr(r.msg);
      close();
      if (!existing) onCreated(((r as unknown as { role?: { id: string } }).role?.id) ?? "");
    })();
  });
  const baseRole = roles.find((r) => r.id === base);
  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Roles" />
      <Field label="Name" htmlFor="acc-rd-name"><input id="acc-rd-name" className="input" value={name} placeholder="Change Advisory Board" autoComplete="off" onChange={(e) => setName(e.target.value)} /></Field>
      {!existing ? (
        <>
          <div className="field"><div className="field-label">Scope</div><Segmented name="acc-rd-level" label="Scope" value={level} onChange={setLevel} items={[{ id: "project", label: "Project role" }, { id: "factory", label: "Factory role" }]} /></div>
          <Field label="Clone rights from" htmlFor="acc-rd-base"><Select id="acc-rd-base" value={base} onChange={setBase} options={roles.map((r) => ({ value: r.id, label: `${r.name}${r.custom ? " (custom)" : ""} · ${grants(r.id)} actions` }))} /></Field>
        </>
      ) : null}
      <Field label="Description" htmlFor="acc-rd-desc"><textarea id="acc-rd-desc" className="input" rows={2} placeholder="What this role is for" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      {!existing && baseRole ? <p className="small muted" id="acc-rd-info">{`Starts with the ${grants(base)} actions ${baseRole.name} has. ${level === "factory" ? "A factory role applies in every project and lets its holders see every project." : "A project role acts only inside projects where it is granted."} Change single rights in the matrix.`}</p> : null}
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

export function RolesList({ roles, matrix, actions, people, onRights, onEdit, onRemove }: {
  roles: Role[]; matrix: Matrix; actions: Action[]; people: Person[]; onRights: (id: string) => void; onEdit: (r: Role) => void; onRemove: (r: Role) => void;
}) {
  const perm = useCan("role.edit") as Decision;
  const ui = useUI();
  const holdersOf = (id: string) => people.filter((p) => p.roles.some((g) => g.role === id)).length;
  const grantsOf = (id: string) => actions.filter((a) => matrix[id]?.[a.id]).length;
  return (
    <DataTable<Role>
      id="acc-roles-table"
      caption="Roles"
      rows={roles}
      rowKey={(r) => r.id}
      columns={[
        { key: "name", label: "Role", render: (r) => (
          <span className="row" style={{ flexWrap: "nowrap", justifyContent: "space-between" }}>
            <b>{r.name}</b>
            <Btn icon="dots" aria={`Manage ${r.name}`} small kind="ghost" cls="icon" id={`acc-role-menu-${r.id}`} onClick={(e) => ui.menu(e.currentTarget, r.name, [
              { label: "Show rights in the matrix", icon: "list", onClick: () => onRights(r.id) },
              { label: "Edit role", icon: "tag", guard: !perm.allowed ? perm : !r.custom ? lockd(`${r.name} is built in. Edit its rights in the matrix.`) : null, onClick: () => onEdit(r) },
              { label: "Remove role", icon: "x", kind: "danger", guard: !perm.allowed ? perm : !r.custom ? lockd(`${r.name} is built in and cannot be removed.`) : null, onClick: () => onRemove(r) },
            ])} />
          </span>
        ) },
        { key: "level", label: "Level", render: (r) => <Chip text={r.level} cls="plain" /> },
        { key: "members", label: "Members", align: "end", render: (r) => holdersOf(r.id) },
        { key: "acts", label: "Actions", align: "end", render: (r) => grantsOf(r.id) },
      ]}
    />
  );
}

export function useRoleDialogs(args: { perm: Decision; roles: Role[]; matrix: Matrix; actions: Action[]; people: Person[]; onCreated: (id: string) => void }) {
  const ui = useUI();
  const outcome = useOutcome();
  const openRole = (existing: Role | null) => {
    let submit: () => void = () => undefined;
    ui.dialog({
      title: existing ? `Edit ${existing.name}` : "Add a role", kicker: "Access · roles",
      sub: existing ? "Built-in roles keep their names; custom roles can be renamed. Rights are edited in the matrix." : "A new role is cloned from an existing one. It then appears in the matrix, on People screens, in the simulator and in approver rules.",
      body: (close) => <RoleForm {...args} existing={existing} close={close} registerSubmit={(fn) => (submit = fn)} />,
      actions: [{ label: "Cancel" }, { label: existing ? "Save role" : "Add role", kind: "primary", submit: true, id: "acc-rd-save", guard: args.perm, onClick: () => submit() }],
    });
  };
  const removeRole = (ro: Role) => {
    const holders = args.people.filter((p) => p.roles.some((g) => g.role === ro.id));
    ui.dialog({
      title: `Remove ${ro.name}`, kicker: "Access · roles",
      sub: holders.length ? `${holders.length} ${holders.length > 1 ? "people hold" : "person holds"} this role: ${holders.map((p) => p.name).join(", ")}. Remove it from them first.` : "Nobody holds this role. Removing it deletes its matrix row; approver rules that name it must be changed first.",
      body: <LockNote decision={args.perm} what="Roles" />,
      actions: [
        { label: "Cancel" },
        { label: "Remove role", kind: "danger", id: "acc-rr-go", guard: args.perm.allowed && holders.length ? lockd(`${holders.length} people still hold ${ro.name}.`) : args.perm, onClick: (close) => void ops.removeRole(ro.id, ifMatchOf(ro)).then((r) => { outcome(r); if (r.ok) close(); }) },
      ],
    });
  };
  return { openRole, removeRole };
}
