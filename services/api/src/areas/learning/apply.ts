/**
 * Applying and undoing a proposal's change (spec 13.4). A change is applied only through the ordinary command for that kind of change (the same function its own
 * endpoint runs), after the same permission check, so it leaves its own audit entry beside the learning one. Every kind records how to undo it.
 *
 * The loop can never weaken a control: a guardrail only gains a path, an approver rule only gains a condition that asks for someone else to approve, a route may not
 * skip a station that a gate follows, an eval suite only gains a case, and no kind touches a grader or a trust criterion (there is no such kind, and the schemas are strict).
 */
import type { Tx } from "@gantry/db";
import type { Decision } from "@gantry/domain";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { Actor, EventSpec } from "../../core/command.js";
import { conflict, invalid, notFound, refuse } from "../../core/errors.js";
import { readCatalog } from "../../core/read/index.js";
import { agentRows } from "../agents/store.js";
import { saveAgent } from "../agents/commands.js";
import { CaseBody } from "../evals/schemas.js";
import { addEvalCase } from "../evals/commands.js";
import { readProjectGuidelines, saveProjectGuidelines } from "../onboarding/guidelines.js";
import { putApprovers, updateClassCmd } from "../projects/commands.js";
import { readProject, refuseIfStopped } from "../projects/store.js";
import { saveSkill } from "../skills/commands.js";
import { readSkills } from "../skills/store.js";
import { Changes } from "./schemas.js";
import type { Kind } from "./config.js";
import type { Rollback } from "./store.js";

export interface ApplyCtx {
  req: FastifyRequest;
  /** The decision point, inside the transaction. */
  can: (action: string, scope: { project?: string | null }) => Promise<Decision>;
}
export interface Done {
  msg: string;
  events: EventSpec[];
  changes: string[];
  project: string | null;
  rollback: Rollback;
}
interface Proposal {
  id: string;
  kind: Kind | string;
  change: Record<string, unknown>;
}

/** The permission of the ordinary command: a refusal here is the same denial that command would give. */
async function need(ctx: ApplyCtx, action: string, project: string | null): Promise<void> {
  const d = await ctx.can(action, project ? { project } : {});
  if (!d.allowed) throw refuse(d.rule.kind === "stop" ? "stopped" : "denied", d.reason, { rule: d.rule, ...(d.needs ? { needs: d.needs } : {}) });
}

const inner = (a: Actor): Actor => ({ ...a, ifMatch: null, idempotencyKey: null });
const shortId = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-6);

type ChangeOf<K extends keyof typeof Changes> = z.infer<(typeof Changes)[K]>;

/** Validates the change against its kind's strict shape and the rules that keep a proposal from weakening a control. */
export async function checkChange(tx: Tx, orgId: string, kind: string, raw: unknown): Promise<Record<string, unknown>> {
  if (!(kind in Changes)) throw invalid("Unknown kind of change.");
  const parsed = Changes[kind as Kind].safeParse(raw);
  if (!parsed.success) throw invalid(`The change is not valid: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join(".") || "change"} ${i.message}`).join("; ")}`);
  const c = parsed.data as Record<string, unknown>;
  switch (kind as Kind) {
    case "skill": {
      const x = c as ChangeOf<"skill">;
      const sk = (await readSkills(tx, orgId, x.skill))[0];
      if (!sk) throw invalid("No such skill.");
      return { ...x, before: sk.body };
    }
    case "eval": {
      const x = c as ChangeOf<"eval">;
      if (!(await tx.query(`select 1 from suites where org_id = $1 and id = $2`, [orgId, x.suite])).rowCount) throw invalid("No such suite.");
      return x;
    }
    case "guideline": {
      const x = c as ChangeOf<"guideline">;
      if (!(await tx.query(`select 1 from projects where org_id = $1 and id = $2`, [orgId, x.project])).rowCount) throw invalid("No such project.");
      if (x.item.text.length < 6) throw invalid("Write the guideline.");
      return x;
    }
    case "guardrail": {
      const x = c as ChangeOf<"guardrail">;
      if (!(await agentRows(tx, orgId, x.agent))[0]) throw invalid("No such agent.");
      if (/^[*/]+$/.test(x.path)) throw invalid("Name a narrower path than everything.");
      return x;
    }
    case "approver": {
      const x = c as ChangeOf<"approver">;
      const p = await readProject(tx, orgId, x.project);
      if (!p) throw invalid("No such project.");
      if (!p.approvers[x.gate]) throw invalid(`${p.name} has no approver rule for ${x.gate}.`);
      const n = x.condition.needs;
      // A condition adds approvers who must also agree. One that asks for nobody would change nothing, and the loop never loosens a rule.
      if (!n.roles.length && !n.people.length && !n.oncall) throw invalid("A condition has to ask for someone else to approve: a role, a person or the person on call.");
      return x;
    }
    case "route": {
      const x = c as ChangeOf<"route">;
      const p = await readProject(tx, orgId, x.project);
      if (!p) throw invalid("No such project.");
      const cls = p.flow.classes.find((k) => k.id === x.cls);
      if (!cls) throw invalid("No such class in that project.");
      const cat = await readCatalog(tx, orgId);
      const st = cat.stations.find((s) => s.id === x.addSkip);
      if (!st) throw invalid("No such station.");
      // A route change may not take a person out of the loop or drop the tests: intake, verify, review and close stay, and so does any station a human or mixed gate follows.
      if (["intake", "verify", "review", "close"].includes(st.id)) throw invalid(`${st.name} cannot be skipped by a proposal.`);
      const gates = cat.gates.filter((g) => g.after === st.id && (p.flow.gates[g.id]?.mode ?? g.kind) !== "auto");
      if (gates.length) throw invalid(`Skipping ${st.name} would also skip ${gates.map((g) => g.label).join(", ")}. A route change cannot remove a gate that a person decides.`);
      return x;
    }
  }
}

export async function applyChange(tx: Tx, a: Actor, ctx: ApplyCtx, lp: Proposal): Promise<Done> {
  const change = await checkChange(tx, a.orgId, lp.kind, lp.change);
  const a2 = inner(a);
  const note = `From ${lp.id}`;
  switch (lp.kind as Kind) {
    case "skill": {
      const c = change as ChangeOf<"skill">;
      const cur = (await readSkills(tx, a.orgId, c.skill))[0]!;
      const drafted = (lp.change as { before?: string }).before;
      if (drafted !== undefined && drafted !== cur.body) throw conflict(`${cur.name} changed since this was drafted. Decline it and draft it again from the current text.`);
      await need(ctx, "skill.edit", null);
      const r = await saveSkill(tx, a2, c.skill, { body: c.after }, note);
      return { msg: r.msg, events: r.events, changes: r.changes ?? [], project: null, rollback: { kind: "skill", available: true, summary: `Saves ${cur.name} again with the text it had before (v${cur.version}) as a new version.`, data: { skill: c.skill, before: cur.body, after: c.after } } };
    }
    case "eval": {
      const c = change as ChangeOf<"eval">;
      await need(ctx, "eval.run", null);
      const body = CaseBody.parse(c.case);
      const r = await addEvalCase(tx, a2, c.suite, body);
      const id = String((r.extra as { case?: { id?: string } } | undefined)?.case?.id ?? "");
      return { msg: r.msg, events: r.events, changes: r.changes ?? [], project: null, rollback: { kind: "eval", available: true, summary: `Removes case ${id} from ${c.suite}, as long as nothing has run it yet.`, data: { suite: c.suite, case: id, name: c.case.name } } };
    }
    case "guideline": {
      const c = change as ChangeOf<"guideline">;
      await need(ctx, "onboarding.guidelines", c.project);
      await refuseIfStopped(ctx.req, { action: "onboarding.guidelines", scope: { project: c.project } }, tx, a.orgId, c.project, "light");
      const cur = await readProjectGuidelines(tx, a.orgId, c.project);
      const items = cur?.items ?? [];
      if (items.some((i) => i.text.trim().toLowerCase() === c.item.text.trim().toLowerCase())) throw conflict("That guideline is already there.");
      const item = { id: c.item.id ?? `pg-${shortId(lp.id)}`, text: c.item.text, required: c.item.required };
      if (items.some((i) => i.id === item.id)) item.id = `${item.id}-b`;
      const name = (await tx.query<{ name: string }>(`select name from projects where org_id = $1 and id = $2`, [a.orgId, c.project])).rows[0]!.name;
      const r = await saveProjectGuidelines(tx, a2, c.project, name, { patch: { items: [...items, item] }, note });
      return { msg: r.msg, events: r.events, changes: r.changes ?? [], project: c.project, rollback: { kind: "guideline", available: true, summary: `Saves the ${name} guidelines again without “${item.text.slice(0, 60)}”.`, data: { project: c.project, item: item.id } } };
    }
    case "guardrail": {
      const c = change as ChangeOf<"guardrail">;
      await need(ctx, "agent.edit", null);
      const row = (await agentRows(tx, a.orgId, c.agent))[0]!;
      const gr = ((row.data.guardrails ?? { paths: [], maxDiff: 0 }) as { paths: string[]; maxDiff: number });
      if (gr.paths.includes(c.path)) throw conflict(`${row.name} already may not touch ${c.path}.`);
      const r = await saveAgent(tx, a2, c.agent, { guardrails: { paths: [...gr.paths, c.path], maxDiff: gr.maxDiff } }, note);
      return { msg: r.msg, events: r.events, changes: r.changes ?? [], project: null, rollback: { kind: "guardrail", available: true, summary: `Takes ${c.path} off ${row.name}'s guardrail again. This loosens a guardrail, so only a person can do it.`, data: { agent: c.agent, path: c.path } } };
    }
    case "approver": {
      const c = change as ChangeOf<"approver">;
      await need(ctx, "approvers.edit", c.project);
      await refuseIfStopped(ctx.req, { action: "approvers.edit", scope: { project: c.project } }, tx, a.orgId, c.project, "light");
      const p = (await readProject(tx, a.orgId, c.project))!;
      const rule = p.approvers[c.gate]!;
      const cond = { id: c.condition.id ?? `C-${shortId(lp.id)}`, when: c.condition.when, needs: c.condition.needs, text: c.condition.text };
      if (rule.conditions.some((x) => x.id === cond.id || x.text === cond.text)) throw conflict("That condition is already on the rule.");
      const r = await putApprovers(tx, a2, c.project, c.gate, { ...rule, conditions: [...rule.conditions, cond] });
      return { msg: r.msg, events: r.events, changes: r.changes ?? [], project: c.project, rollback: { kind: "approver", available: true, summary: `Removes the condition “${cond.text.slice(0, 60)}” from ${p.name} ${c.gate}. This loosens a rule, so only a person can do it.`, data: { project: c.project, gate: c.gate, condition: cond.id } } };
    }
    case "route": {
      const c = change as ChangeOf<"route">;
      await need(ctx, "class.edit", c.project);
      await refuseIfStopped(ctx.req, { action: "class.edit", scope: { project: c.project } }, tx, a.orgId, c.project, "edit");
      const p = (await readProject(tx, a.orgId, c.project))!;
      const cls = p.flow.classes.find((k) => k.id === c.cls)!;
      if (cls.skips.includes(c.addSkip)) throw conflict(`${cls.name} already skips that station.`);
      const r = await updateClassCmd(tx, a2, c.project, c.cls, { skips: [...cls.skips, c.addSkip] });
      return { msg: r.msg, events: r.events, changes: r.changes ?? [], project: c.project, rollback: { kind: "route", available: true, summary: `Puts ${cls.name} on ${p.name} back to skipping ${cls.skips.length ? cls.skips.join(", ") : "nothing"}.`, data: { project: c.project, cls: c.cls, skip: c.addSkip } } };
    }
  }
  throw invalid("Unknown kind of change.");
}

/** Undoes an applied change through the same ordinary command, refusing when something else changed the same thing since. */
export async function undoChange(tx: Tx, a: Actor, ctx: ApplyCtx, lp: Proposal & { rollback: Rollback | null }): Promise<Omit<Done, "rollback">> {
  const rb = lp.rollback;
  if (!rb || !rb.available) throw conflict(rb?.summary || "This change has no undo.");
  const a2 = inner(a);
  const note = `Rollback of ${lp.id}`;
  const d = rb.data;
  switch (rb.kind) {
    case "skill": {
      const cur = (await readSkills(tx, a.orgId, String(d.skill)))[0];
      if (!cur) throw notFound("The skill is gone.");
      if (cur.body !== d.after) throw conflict(`${cur.name} was edited again after this change. Restore it from its versions instead.`);
      await need(ctx, "skill.edit", null);
      const r = await saveSkill(tx, a2, cur.id, { body: String(d.before) }, note);
      return { msg: r.msg, events: r.events, changes: r.changes ?? [], project: null };
    }
    case "eval": {
      await need(ctx, "eval.run", null);
      const caseId = String(d.case);
      if ((await tx.query(`select 1 from eval_results where org_id = $1 and case_id = $2 limit 1`, [a.orgId, caseId])).rowCount) throw conflict(`${caseId} has already been run, so its results stay in the record. Retire it in Evals.`);
      const del = await tx.query(`delete from eval_cases where org_id = $1 and id = $2 and suite_id = $3`, [a.orgId, caseId, String(d.suite)]);
      if (!del.rowCount) throw notFound(`${caseId} is already gone.`);
      return { msg: `${caseId} removed from ${String(d.suite)}.`, changes: ["suites", "evalRuns"], project: null, events: [{ type: "eval.case", category: "agents", subject: { type: "suite", id: String(d.suite) }, projectId: null, before: { case: caseId, name: d.name }, after: { removed: true, note } }] };
    }
    case "guideline": {
      const project = String(d.project);
      await need(ctx, "onboarding.guidelines", project);
      await refuseIfStopped(ctx.req, { action: "onboarding.guidelines", scope: { project } }, tx, a.orgId, project, "light");
      const cur = await readProjectGuidelines(tx, a.orgId, project);
      const items = cur?.items ?? [];
      if (!items.some((i) => i.id === d.item)) throw conflict("That guideline was already removed.");
      const name = (await tx.query<{ name: string }>(`select name from projects where org_id = $1 and id = $2`, [a.orgId, project])).rows[0]?.name ?? project;
      const r = await saveProjectGuidelines(tx, a2, project, name, { patch: { items: items.filter((i) => i.id !== d.item) }, note });
      return { msg: r.msg, events: r.events, changes: r.changes ?? [], project };
    }
    case "guardrail": {
      await need(ctx, "agent.edit", null);
      const row = (await agentRows(tx, a.orgId, String(d.agent)))[0];
      if (!row) throw notFound("The agent is gone.");
      const gr = ((row.data.guardrails ?? { paths: [], maxDiff: 0 }) as { paths: string[]; maxDiff: number });
      if (!gr.paths.includes(String(d.path))) throw conflict("That path was already removed.");
      const r = await saveAgent(tx, a2, row.id, { guardrails: { paths: gr.paths.filter((x) => x !== d.path), maxDiff: gr.maxDiff } }, note);
      return { msg: r.msg, events: r.events, changes: r.changes ?? [], project: null };
    }
    case "approver": {
      const project = String(d.project);
      await need(ctx, "approvers.edit", project);
      await refuseIfStopped(ctx.req, { action: "approvers.edit", scope: { project } }, tx, a.orgId, project, "light");
      const p = await readProject(tx, a.orgId, project);
      const rule = p?.approvers[String(d.gate)];
      if (!p || !rule) throw notFound("That rule is gone.");
      if (!rule.conditions.some((x) => x.id === d.condition)) throw conflict("That condition was already removed.");
      const r = await putApprovers(tx, a2, project, String(d.gate), { ...rule, conditions: rule.conditions.filter((x) => x.id !== d.condition) });
      return { msg: r.msg, events: r.events, changes: r.changes ?? [], project };
    }
    case "route": {
      const project = String(d.project);
      await need(ctx, "class.edit", project);
      await refuseIfStopped(ctx.req, { action: "class.edit", scope: { project } }, tx, a.orgId, project, "edit");
      const p = await readProject(tx, a.orgId, project);
      const cls = p?.flow.classes.find((k) => k.id === d.cls);
      if (!p || !cls) throw notFound("That class is gone.");
      if (!cls.skips.includes(String(d.skip))) throw conflict("That station is no longer skipped.");
      const r = await updateClassCmd(tx, a2, project, String(d.cls), { skips: cls.skips.filter((x) => x !== d.skip) });
      return { msg: r.msg, events: r.events, changes: r.changes ?? [], project };
    }
  }
  throw invalid("Unknown kind of change.");
}
