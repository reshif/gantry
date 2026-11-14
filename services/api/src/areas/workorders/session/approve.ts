/**
 * Approving an agent's brief proposal (spec 8.4): the proposal becomes the work order's brief, the intake conversation is complete, and the ordinary G0+G1 approval runs
 * under the approving person's own rights (the command's action is `brief.confirm`, and `approveInner` re-checks the gate decision). Nothing here is a second way to pass a
 * gate: it is the same approval, with the agent's drafted brief as what is confirmed.
 */
import { applyBriefDraft, briefBase, resolveBriefDraft } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import type { Actor } from "../../../core/command.js";
import { conflict, invalid } from "../../../core/errors.js";
import { begin, flowFor, type CmdResult } from "../ctx.js";
import { approveInner } from "../gates.js";
import { note } from "../engine.js";
import { convIdOf, saveWo } from "../model.js";
import { bayOf, stationIdOf } from "../engine.js";

export async function confirmAgentBrief(tx: Tx, actor: Actor, woId: string, draft: unknown, base: string, by: { agent: string; version: number | null; proposal: string }): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "brief.confirm");
  if (bayOf(fx.catalog, w) || stationIdOf(fx.catalog, w) !== "intake") throw conflict(`${w.id} is past Intake; its brief cannot be replaced.`);
  const { wo } = await flowFor(fx, w);
  const g = wo.gates.G0G1;
  if (!g || g.status === "passed") throw conflict("The brief was already confirmed.");
  if (briefBase(wo.brief) !== base) throw conflict("The brief changed after this was proposed. Ask the agent for a new proposal.");
  const v = resolveBriefDraft(draft);
  if (!v.ok) throw invalid(`The stored proposal is no longer valid: ${v.reasons.join(" ")}`);
  w.data.brief = applyBriefDraft(wo.brief, v.draft);
  w.data.briefAuthoredBy = { agent: by.agent, version: by.version, proposal: by.proposal, approvedBy: actor.personId, at: fx.now.getTime() };
  // The agent has asked what it needed: the scripted questionnaire no longer gates the brief.
  await fx.tx.query(`update conversations set status = 'answered', data = jsonb_set(data, '{done}', 'true'::jsonb), updated_at = now() where org_id = $1 and id = $2`, [fx.orgId, convIdOf(w.id)]);
  note(w, fx, actor.personId ?? actor.id, `Brief drafted by ${by.agent} and approved.`);
  await saveWo(fx.tx, fx.orgId, w);
  return approveInner(fx, actor, w, "G0G1", null, undefined);
}
