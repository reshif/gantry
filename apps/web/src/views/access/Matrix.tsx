import type { Action, Matrix, Person, Role } from "@gantry/domain";
import { Icon } from "../../ui/Icon";
import type { Evaluated } from "./Simulator";

/**
 * Role by permission (the Control Room matrix): permission key in mono with its label dim underneath, one column per role, a green check where
 * the role holds it and a dim dash where it does not. Read-only: roles are edited in the role dialog (Edit roles), which the server also guards.
 */
export function MatrixTable({ matrix, roles, actions, hl, evaluated, people, newRole }: {
  matrix: Matrix; version?: number | undefined; roles: Role[]; actions: Action[]; hl: string | null; evaluated: Evaluated | null; people: Person[]; newRole: string | null;
}) {
  const hlAction = hl === "MATRIX" && evaluated ? evaluated.sim.action : null;
  let hlRoles: string[] = [];
  if (hlAction && evaluated) {
    const person = people.find((p) => p.id === evaluated.sim.person);
    const act = actions.find((a) => a.id === hlAction);
    hlRoles = (person?.roles ?? []).filter((g) => act?.scope === "factory" || g.scope === "factory" || g.scope === evaluated.sim.project).map((g) => g.role);
  }
  return (
    <div className="matrix" id="acc-matrix-table" data-keep-scroll="acc-matrix">
      <table>
        <caption className="sr">Role by permission</caption>
        <thead>
          <tr>
            <th scope="col">Permission</th>
            {roles.map((r) => (
              <th key={r.id} scope="col" id={`acc-mx-col-${r.id}`} className={`${hlRoles.includes(r.id) && hlAction ? "is-hl" : ""}${newRole === r.id ? " is-new" : ""}`} title={r.desc}>{r.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {actions.map((a) => (
            <tr key={a.id} className={hlAction === a.id ? "is-hl" : ""} id={`acc-mx-row-${a.id.replace(".", "_")}`}>
              <td><b className="mono" style={{ fontSize: 11 }}>{a.id}</b><div className="dim" style={{ fontSize: 11 }}>{a.name}</div></td>
              {roles.map((ro) => {
                const on = !!matrix[ro.id]?.[a.id] && !(ro.level !== "factory" && a.scope === "factory");
                return (
                  <td key={ro.id} id={`acc-mx-${ro.id}-${a.id.replace(".", "_")}`}>
                    {on ? <span style={{ color: "var(--ok)" }} aria-label="Allowed"><Icon name="check" /></span> : <span className="dim" aria-label="Not allowed">–</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
