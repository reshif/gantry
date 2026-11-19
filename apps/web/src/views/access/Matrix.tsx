/** The role matrix (prototype "Role matrix"): search and group filter, a count, sticky action column, square checkbox cells. */
import { CONSOLE_RIGHTS, type Action, type Matrix, type Role } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Empty, Field, FilterBar, SearchBox, Select, Table, Toggle, type Decision } from "../../ui/primitives";
import { plural } from "../../lib/plural";
import { lockd, useOutcome } from "../govern/data";
import { ScrollCue, setQS, useQS } from "../govern/kit";

/** Rights that stay on so nobody is locked out (spec 14.4). The server refuses the same edits. */
const LOCKED_ON = new Set(["factory_admin:policy.edit", "factory_admin:people.manage", "factory_admin:security.manage", "factory_admin:audit.view", "factory_admin:restore.factory", "auditor:audit.view", ...CONSOLE_RIGHTS.map((c) => `factory_admin:${c}`)]);
/** Roles that always hold every right (spec 14.4): their column is shown checked and locked. */
const ALWAYS_FULL = new Set(["factory_admin"]);
const STICKY = { position: "sticky", left: 0, background: "var(--surface)" } as const;

export function MatrixTable({ matrix, version, roles, actions, newRole }: { matrix: Matrix; version: number | undefined; roles: Role[]; actions: Action[]; newRole: string | null }) {
  const outcome = useOutcome();
  const perm = useCan("policy.edit") as Decision;
  const [group] = useQS("acc.group");
  const [q] = useQS("acc.q");
  const groups = [...new Set(actions.map((a) => a.group))];
  const s = q.trim().toLowerCase();
  const rows = actions.filter((a) => (!group || a.group === group) && (!s || `${a.name}${a.id}`.toLowerCase().includes(s)));
  return (
    <div>
      <FilterBar label="Filter actions" count={plural(actions.length, "action")}>
        <SearchBox id="acc-mx-q" caption="Search actions" value={q} onChange={(v) => setQS({ "acc.q": v })} placeholder="e.g. approve" label="Search actions" />
        <Field label="Group" htmlFor="acc-mx-grp"><Select id="acc-mx-grp" value={group} onChange={(v) => setQS({ "acc.group": v })} options={[{ value: "", label: "All groups" }, ...groups]} /></Field>
      </FilterBar>
      {rows.length ? (
        <ScrollCue label="Role matrix" maxHeight={560}>
          <Table>
            <thead>
              <tr>
                <th scope="col" style={{ ...STICKY, zIndex: 3 }}>Action</th>
                {roles.map((r) => (
                  <th key={r.id} scope="col" id={`acc-mx-col-${r.id}`} className={newRole === r.id ? "is-new" : undefined} style={{ textAlign: "center", minWidth: 84, whiteSpace: "normal", padding: "8px 4px", letterSpacing: "0.04em" }} title={ALWAYS_FULL.has(r.id) ? "Factory admin always has full access (locked)" : r.name}>
                    {r.name}
                    {ALWAYS_FULL.has(r.id) ? <span className="sub">locked</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} id={`acc-mx-row-${a.id.replace(".", "_")}`}>
                  <td style={{ ...STICKY, minWidth: 170 }}>{a.name}<span className="sub mono">{`${a.id} · ${a.group}`}</span></td>
                  {roles.map((ro) => {
                    const factoryOnly = ro.level !== "factory" && a.scope === "factory";
                    const on = !!matrix[ro.id]?.[a.id] && !factoryOnly;
                    const d: Decision | null = !perm.allowed ? perm : factoryOnly ? lockd(`${ro.name} is a project-level role: '${a.name.toLowerCase()}' is a factory-wide right, held by factory-level roles only.`) : LOCKED_ON.has(`${ro.id}:${a.id}`) ? lockd(`${ro.name} always keeps '${a.name.toLowerCase()}' so nobody is locked out.`) : null;
                    return (
                      <td key={ro.id} style={{ textAlign: "center" }}>
                        <Toggle variant="check" disabled={ALWAYS_FULL.has(ro.id)} id={`acc-mx-${ro.id}-${a.id.replace(".", "_")}`} checked={on} decision={d} label={`${ro.name} can ${a.name}`} onChange={async (v) => void outcome(await ops.setMatrix(ro.id, a.id, v, version !== undefined ? { ifMatch: version } : undefined), `${ro.name}: ${a.name} ${v ? "granted" : "revoked"}`)} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </Table>
        </ScrollCue>
      ) : <Empty title="Nothing matches these filters" text="Loosen the search or clear the filters." action={<Btn label="Clear filters" id="acc-mx-clear" onClick={() => setQS({ "acc.q": "", "acc.group": "" })} />} />}
    </div>
  );
}
