import { useState } from "react";
import type { Action, Matrix, Person, Role } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Chip, Field, LockNote, Segmented, Select, type Decision } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { lockd, useOutcome } from "../govern/data";

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
        ? outcome(await ops.updateRole(existing.id, { name, desc }))
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
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "", dir: 1 });
  const holdersOf = (id: string) => people.filter((p) => p.roles.some((g) => g.role === id));
  const grantsOf = (id: string) => actions.filter((a) => matrix[id]?.[a.id]).length;
  const val: Record<string, (r: Role) => string | number> = { name: (r) => r.name.toLowerCase(), level: (r) => r.level, acts: (r) => grantsOf(r.id), holders: (r) => holdersOf(r.id).length };
  const rows = [...roles];
  if (sort.key && val[sort.key]) rows.sort((a, b) => (val[sort.key]!(a) > val[sort.key]!(b) ? 1 : val[sort.key]!(a) < val[sort.key]!(b) ? -1 : 0) * sort.dir);
  const th = (key: string, label: string, align?: string) => (
    <th scope="col" className={align === "end" ? "num" : undefined} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button type="button" className={`th-sort${sort.key === key ? " is-active" : ""}`} onClick={() => setSort({ key, dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : 1 })}>{label}</button>
    </th>
  );
  return (
    <div className="acc-roles">
      <p className="muted small acc-mx-note">Built-in roles plus custom roles your organisation adds. Custom roles are cloned from an existing role and then edited in the matrix. Holding a factory role makes every project visible.</p>
      <div className="table-scroll">
        <table className="table" id="acc-roles-table">
          <caption className="sr">Roles</caption>
          <thead><tr>{th("name", "Role")}{th("level", "Scope")}<th scope="col">Cloned from</th>{th("acts", "Actions", "end")}{th("holders", "Held by")}<th scope="col">Description</th><th scope="col"><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const hs = holdersOf(r.id);
              return (
                <tr key={r.id}>
                  <td><span className="acc-role-name"><strong>{r.name}</strong>{r.custom ? <Chip text="custom" cls="chip-accent" /> : null}<span className="mono muted small">{r.id}</span></span></td>
                  <td>{r.level === "factory" ? "Factory" : "Project"}</td>
                  <td>{r.base ? roles.find((x) => x.id === r.base)?.name ?? r.base : <span className="muted">built in</span>}</td>
                  <td className="num"><span className="mono">{grantsOf(r.id)}</span></td>
                  <td>{hs.length ? <span className="small">{hs.slice(0, 3).map((p) => p.name).join(", ") + (hs.length > 3 ? ` +${hs.length - 3}` : "")}</span> : <span className="muted small">nobody</span>}</td>
                  <td><span className="small">{r.desc ?? ""}</span></td>
                  <td>
                    <span className="row gap-sm acc-role-tools">
                      <Btn label="Rights" small kind="ghost" id={`acc-role-mx-${r.id}`} onClick={() => onRights(r.id)} />
                      <Btn label="Edit" small kind="ghost" id={`acc-role-edit-${r.id}`} guard={!perm.allowed ? perm : !r.custom ? lockd(`${r.name} is built in. Edit its rights in the matrix.`) : null} onClick={() => onEdit(r)} />
                      <Btn label="Remove" small kind="ghost" id={`acc-role-rm-${r.id}`} guard={!perm.allowed ? perm : !r.custom ? lockd(`${r.name} is built in and cannot be removed.`) : null} onClick={() => onRemove(r)} />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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
        { label: "Remove role", kind: "danger", id: "acc-rr-go", guard: args.perm.allowed && holders.length ? lockd(`${holders.length} people still hold ${ro.name}.`) : args.perm, onClick: (close) => void ops.removeRole(ro.id).then((r) => { outcome(r); if (r.ok) close(); }) },
      ],
    });
  };
  return { openRole, removeRole };
}
