import { visibleProjects, type Decision } from "@gantry/domain";
import type { FastifyRequest } from "fastify";
import { auditDenial, decideFor, policyState, refuse, refuseDecision } from "../../core/index.js";
import type { Visibility } from "./read.js";

/**
 * Who may read which ledger rows (spec 8.9, 14.3). `audit.view` (Auditor, Factory Admin) reads everything. Anyone else signed in
 * reads the entries of the projects they can see, plus what they did themselves. A caller that is neither (an API key
 * without the `audit.view` scope) reads nothing, and the refusal is audited like any other denial.
 */
export async function visibilityFor(req: FastifyRequest): Promise<Visibility> {
  const st = await policyState(req);
  const p = req.gx.principal;
  const d = decideFor(st, p, "audit.view", {});
  if (d.allowed) return { all: true, projects: [], actor: null };
  if (p?.kind !== "person") {
    await auditDenial(req, { action: "audit.view" }, d).catch((e: unknown) => req.log.error({ err: e }, "could not audit denial"));
    throw refuseDecision(d);
  }
  return { all: false, projects: visibleProjects(st, p.id).map((x) => x.id), actor: p.id };
}

/** Chain verification is for the Auditor and Factory Admin only, whatever the matrix says elsewhere. */
export async function requireVerifier(req: FastifyRequest): Promise<void> {
  const st = await policyState(req);
  const p = req.gx.principal;
  const d = decideFor(st, p, "audit.view", {});
  const person = p?.kind === "person" ? st.people.find((x) => x.id === p.id) : undefined;
  const ok = d.allowed && !!person?.roles.some((g) => g.scope === "factory" && (g.role === "auditor" || g.role === "factory_admin"));
  if (ok) return;
  if (!p) throw refuse("denied", "Sign in to continue.");
  const denied: Decision = { allowed: false, reason: "Only the Auditor and Factory Admin may verify the ledger's hash chain.", rule: { kind: "invariant", id: "AUDIT-VERIFY", name: "Chain verification" }, needs: "Auditor or Factory Admin" };
  await auditDenial(req, { action: "audit.view" }, denied).catch((e: unknown) => req.log.error({ err: e }, "could not audit denial"));
  throw refuseDecision(denied);
}
