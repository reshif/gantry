import { useState } from "react";
import { CONSOLE_RIGHTS, type Action, type Matrix, type Person, type Role } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Segmented, Toggle, type Decision } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { lockd, useOutcome } from "../govern/data";
import type { Evaluated } from "./Simulator";

/** Rights that stay on so nobody is locked out (spec 14.4). The server refuses the same edits. */
const LOCKED_ON = new Set(["factory_admin:policy.edit", "factory_admin:people.manage", "factory_admin:security.manage", "factory_admin:audit.view", "factory_admin:restore.factory", "auditor:audit.view", ...CONSOLE_RIGHTS.map((c) => `factory_admin:${c}`)]);

export function MatrixTable({ matrix, version, roles, actions, hl, evaluated, people, newRole }: {
  matrix: Matrix; version: number | undefined; roles: Role[]; actions: Action[]; hl: string | null; evaluated: Evaluated | null; people: Person[]; newRole: string | null;
}) {
  const outcome = useOutcome();
  const perm = useCan("policy.edit") as Decision;
  const [group, setGroup] = useState("all");
  const groups = [...new Set(actions.map((a) => a.group))];
  const shown = group === "all" ? groups : [group];
  const hlAction = hl === "MATRIX" && evaluated ? evaluated.sim.action : null;
  let hlRoles: string[] = [];
  if (hlAction && evaluated) {
    const person = people.find((p) => p.id === evaluated.sim.person);
    const act = actions.find((a) => a.id === hlAction);
    hlRoles = (person?.roles ?? []).filter((g) => act?.scope === "factory" || g.scope === "factory" || g.scope === evaluated.sim.project).map((g) => g.role);
  }
  return (
    <div>
      <div className="acc-mx-tools">
        <Segmented name="acc-mx-grp" label="Action group" value={group} onChange={setGroup} items={[{ id: "all", label: "All" }, ...groups.map((g) => ({ id: g, label: g }))]} />
      </div>
      <p className="muted small acc-mx-note">Project roles act only inside the projects where they are held. A factory action granted to a project role applies everywhere, so grant those with care. Policies on the Policies tab narrow or extend these rights by place and time.</p>
      <div className="table-scroll acc-mx-scroll" data-keep-scroll="acc-matrix">
        <table className="table table-compact matrix">
          <thead>
            <tr>
              <th scope="col">Action</th>
              {roles.map((r) => (
                <th key={r.id} scope="col" id={`acc-mx-col-${r.id}`} className={`mx-role${hlRoles.includes(r.id) && hlAction ? " is-hl" : ""}${r.custom ? " is-custom" : ""}${newRole === r.id ? " is-new" : ""}`} title={r.desc}>
                  {r.name}
                  <span className="mx-lvl mono">{r.level === "factory" ? "factory" : "project"}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.flatMap((g) => [
              <tr key={`g-${g}`} className={`mx-grp${g === "Stops" ? " mx-grp-stop" : ""}`}>
                <th scope="rowgroup" colSpan={roles.length + 1}>{g === "Stops" ? <span><Icon name="st-kill" /> Stops: kill switches and restore</span> : g === "Console" ? <span>Console: what the console may offer a person (a confirm card also needs the underlying right; Factory Admin always has all)</span> : g}</th>
              </tr>,
              ...actions.filter((a) => a.group === g).map((a) => (
                <tr key={a.id} className={`${hlAction === a.id ? "is-hl" : ""}${a.group === "Stops" ? " mx-stop" : ""}`} id={`acc-mx-row-${a.id.replace(".", "_")}`}>
                  <th scope="row"><span>{a.name}</span><span className="mono muted mx-aid">{a.id + (a.scope === "factory" ? " · factory" : "")}</span></th>
                  {roles.map((ro) => {
                    const factoryOnly = ro.level !== "factory" && a.scope === "factory";
                    const on = !!matrix[ro.id]?.[a.id] && !factoryOnly;
                    const d: Decision | null = !perm.allowed ? perm : factoryOnly ? lockd(`${ro.name} is a project-level role: '${a.name.toLowerCase()}' is a factory-wide right, held by factory-level roles only.`) : LOCKED_ON.has(`${ro.id}:${a.id}`) ? lockd(`${ro.name} always keeps '${a.name.toLowerCase()}' so nobody is locked out.`) : null;
                    return (
                      <td key={ro.id} className={`mx-cell${on ? " is-on" : ""}${ro.custom ? " is-custom" : ""}${hlAction === a.id && hlRoles.includes(ro.id) ? " is-hl" : ""}`}>
                        <MatrixToggle id={`acc-mx-${ro.id}-${a.id.replace(".", "_")}`} on={on} decision={d} label={`${ro.name}: ${a.name}`} onChange={async (v) => void outcome(await ops.setMatrix(ro.id, a.id, v, version !== undefined ? { ifMatch: version } : undefined))} />
                      </td>
                    );
                  })}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MatrixToggle({ id, on, decision, label, onChange }: { id: string; on: boolean; decision: Decision | null; label: string; onChange: (v: boolean) => void }) {
  return <Toggle id={id} checked={on} decision={decision} label={label} onChange={onChange} />;
}
