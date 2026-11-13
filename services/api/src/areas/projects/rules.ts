import type { ApproverRule, GateKind, Role } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { invalid } from "../../core/errors.js";

/** The roles and people an approver rule may name, loaded once per check. */
export interface RuleContext {
  roles: Role[];
  /** Active people who hold a project-scope role in the project, by person id -> the project roles they hold. */
  members: Map<string, string[]>;
  people: Set<string>;
}

export async function ruleContext(db: Queryable, orgId: string, projectId: string | null, roles: Role[]): Promise<RuleContext> {
  const p = await db.query<{ id: string; status: string }>(`select id, status from people where org_id = $1`, [orgId]);
  const m = projectId
    ? await db.query<{ person_id: string; role_id: string }>(
        `select person_id, role_id from role_assignments where org_id = $1 and project_id = $2 and revoked_at is null and (expires_at is null or expires_at > now())`,
        [orgId, projectId],
      )
    : { rows: [] as { person_id: string; role_id: string }[] };
  const active = new Set(p.rows.filter((x) => x.status === "active").map((x) => x.id));
  const members = new Map<string, string[]>();
  for (const r of m.rows) if (active.has(r.person_id)) members.set(r.person_id, [...(members.get(r.person_id) ?? []), r.role_id]);
  return { roles, members, people: new Set(p.rows.map((x) => x.id)) };
}

function checkRefs(rule: ApproverRule, ctx: RuleContext): void {
  const projectRoles = new Set(ctx.roles.filter((r) => r.level === "project").map((r) => r.id));
  const named = [...rule.roles, ...rule.conditions.flatMap((c) => c.needs.roles)];
  const badRole = named.filter((r) => !projectRoles.has(r));
  if (badRole.length) throw invalid(`Unknown or factory-level role: ${[...new Set(badRole)].join(", ")}.`);
  const ppl = [...rule.people, ...rule.conditions.flatMap((c) => c.needs.people), ...(rule.fallback ? [rule.fallback] : [])];
  const badP = ppl.filter((p) => !ctx.people.has(p));
  if (badP.length) throw invalid(`Unknown person: ${[...new Set(badP)].join(", ")}.`);
}

/** References only: used when a rule set comes from a wizard override. */
export function checkRuleRefs(rules: Record<string, ApproverRule>, ctx: RuleContext): void {
  for (const r of Object.values(rules)) checkRefs(r, ctx);
}

/** The rule editor's checks (legacy `ruleEditor.save`), enforced on the server. `classes`: class ids in the project's flow. */
export function checkRule(gateId: string, kind: GateKind, rule: ApproverRule, ctx: RuleContext, classes: ReadonlySet<string>, projectName: string): void {
  checkRefs(rule, ctx);
  if (kind !== "auto") {
    if (rule.required < 1) throw invalid("A human gate needs at least one approval.");
    if (!rule.roles.length && !rule.people.length) throw invalid("Pick at least one role or named person.");
    const eligible = new Set<string>(rule.people.filter((p) => ctx.members.has(p)));
    for (const [person, roles] of ctx.members) if (roles.some((r) => rule.roles.includes(r))) eligible.add(person);
    if (rule.required > eligible.size) {
      throw invalid(`Needs ${rule.required} approvals but only ${eligible.size} eligible ${eligible.size === 1 ? "person is" : "people are"} in ${projectName}.`);
    }
  }
  if (gateId === "G0G1" && rule.required !== 1) throw invalid("G0+G1 needs exactly one confirmation.");
  for (const c of rule.conditions) {
    if (!c.needs.roles.length && !c.needs.people.length) throw invalid("Every condition needs at least one role.");
    if (c.when.type === "class" && !classes.has(c.when.value)) throw invalid(`Condition names a class this project does not have: ${c.when.value}.`);
  }
  const ids = rule.conditions.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw invalid("Condition ids must be unique.");
}
