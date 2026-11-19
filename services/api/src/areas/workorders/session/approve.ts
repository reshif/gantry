/**
 * Approving an agent's brief proposal (spec 8.4): the proposal becomes the work order's brief, the intake conversation is complete, and the ordinary G0+G1 approval runs
 * under the approving person's own rights (the command's action is `brief.confirm`, and `approveInner` re-checks the gate decision). Nothing here is a second way to pass a
 * gate: it is the same approval, with the agent's drafted brief as what is confirmed.
 */
import { applyBriefDraft, briefBase, briefGateOff, resolveBriefDraft } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import type { Actor } from "../../../core/command.js";
import { conflict, invalid } from "../../../core/errors.js";
import { begin, flowFor, makeFx, type CmdResult } from "../ctx.js";
import { approveInner, passBriefIfGateOff } from "../gates.js";
import { flushFx, note, pinned, type Fx } from "../engine.js";
import { convIdOf, saveWo, type Wo } from "../model.js";
import { bayOf, stationIdOf } from "../engine.js";

/** The agent's drafted brief becomes the work order's brief and the scripted questionnaire stops gating it. Shared by a person's approval and the gate-off path. */
async function applyBriefProposal(fx: Fx, w: Wo, draft: unknown, base: string, by: { agent: string; version: number | null; proposal: string }, approvedBy: string | null, noteBy: string, noteText: string): Promise<void> {
  if (bayOf(fx.catalog, w) || stationIdOf(fx.catalog, w) !== "intake") throw conflict(`${w.id} is past Intake; its brief cannot be replaced.`);
  const { wo } = await flowFor(fx, w);
  const g = wo.gates.G0G1;
  if (!g || g.status === "passed") throw conflict("The brief was already confirmed.");
  if (briefBase(wo.brief) !== base) throw conflict("The brief changed after this was proposed. Ask the agent for a new proposal.");
  const v = resolveBriefDraft(draft);
  if (!v.ok) throw invalid(`The stored proposal is no longer valid: ${v.reasons.join(" ")}`);
  w.data.brief = applyBriefDraft(wo.brief, v.draft);
  w.data.briefAuthoredBy = { agent: by.agent, version: by.version, proposal: by.proposal, approvedBy, at: fx.now.getTime() };
  // The agent has asked what it needed: the scripted questionnaire no longer gates the brief.
  await fx.tx.query(`update conversations set status = 'answered', data = jsonb_set(jsonb_set(data, '{done}', 'true'::jsonb), '{awaiting}', '"approver"'::jsonb), updated_at = now() where org_id = $1 and id = $2`, [fx.orgId, convIdOf(w.id)]);
  note(w, fx, noteBy, noteText);
  await saveWo(fx.tx, fx.orgId, w);
}

export async function confirmAgentBrief(tx: Tx, actor: Actor, woId: string, draft: unknown, base: string, by: { agent: string; version: number | null; proposal: string }): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "brief.confirm");
  await applyBriefProposal(fx, w, draft, base, by, actor.personId, actor.personId ?? actor.id, `Brief drafted by ${by.agent} and approved.`);
  return approveInner(fx, actor, w, "G0G1", null, undefined);
}

/**
 * The brief gate (G0+G1) is switched off by an admin override: the agent's proposed brief is applied as the brief without a person approving the card, and the work order
 * leaves Intake. Runs as the system, once, right after the agent's message is saved. Returns false when the gate is on or the proposal cannot be applied (the card then stays
 * pending, and a person can still approve it as usual).
 */
export async function autoConfirmProposedBrief(tx: Tx, orgId: string, woId: string, mid: string, pid: string, now: Date = new Date()): Promise<boolean> {
  const { lockWo } = await import("../model.js");
  const { lockWoMessage, saveWoMessageData } = await import("./store.js");
  const m = await lockWoMessage(tx, orgId, woId, mid);
  const card = m?.data.cards?.find((c) => c.kind === "proposal" && c.id === pid);
  if (!m || !card || card.kind !== "proposal" || card.what !== "brief" || card.status !== "pending") return false;
  const w = await lockWo(tx, orgId, woId);
  const actor = { orgId, id: "system", kind: "service", personId: null, name: "system", channel: "system", via: null, sessionId: null, ip: null, requestId: `auto-brief-${pid}`, decision: {} as never, ifMatch: null, idempotencyKey: null, now } as Actor;
  const fx = await makeFx(tx, actor);
  if (!briefGateOff(await pinned(fx, w))) return false;
  const d = m.data.drafts?.[pid] as { brief?: unknown } | undefined;
  await applyBriefProposal(fx, w, d?.brief, card.base ?? "", { agent: m.author, version: m.data.version ?? null, proposal: pid }, null, "system", `Brief drafted by ${m.author}; the brief gate is off, so no person approved it.`);
  const passed = await passBriefIfGateOff(fx, w);
  if (!passed) return false;
  card.status = "approved";
  card.decidedBy = "system";
  await saveWoMessageData(tx, orgId, mid, m.data);
  await saveWo(fx.tx, fx.orgId, w);
  await flushFx(fx);
  return true;
}
