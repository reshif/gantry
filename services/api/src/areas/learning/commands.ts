/**
 * Learning loop commands (spec 8.7, 13.4). Drafting, accepting, declining, verifying and rolling back need the runtime switch (off in a new install) and `learning.apply`.
 * Accepting applies the change only through the ordinary command for it (see apply.ts), refuses the person who drafted it when a second eligible person exists, and takes the
 * baseline of the declared metric. Verifying measures the declared metric over the declared window from the live records; nobody can assert it.
 */
import type { Queryable, Tx } from "@gantry/db";
import { can, DAY } from "@gantry/domain";
import type { Actor, CommandResult } from "../../core/command.js";
import { conflict, invalid, notFound, refuse } from "../../core/errors.js";
import { loadPolicyState } from "../../core/read/state.js";
import { applyChange, checkChange, undoChange, type ApplyCtx } from "./apply.js";
import { SWITCH_RULE, proposalsOn, setProposalsOn } from "./config.js";
import { findingRows, refreshFindings } from "./findings.js";
import { collectSignals, countMetric } from "./signals.js";
import { nextProposalId, proposalRows, stamp, toProposal, legacyStatus } from "./store.js";
import type { DraftInput } from "./schemas.js";

type Cmd = CommandResult<Record<string, unknown>>;
const cat = "agents" as const;
const json = (v: unknown): string => JSON.stringify(v);
const subject = (id: string) => ({ type: "learning", id });
const projectOf = (change: Record<string, unknown> | null | undefined): string | null => (typeof change?.project === "string" ? change.project : null);

/** Proposals are off in a new install (spec 15.3). */
export async function requireProposalsOn(tx: Tx, orgId: string): Promise<void> {
  if (await proposalsOn(tx, orgId)) return;
  throw refuse("denied", "Learning proposals are switched off, so nothing can be drafted, accepted or verified yet.", { needs: "Turn on learning proposals", rule: { ...SWITCH_RULE } });
}

/** Recount evidence for open findings from the live records. */
export async function refreshCmd(tx: Tx, a: Actor): Promise<Cmd> {
  const r = await refreshFindings(tx, a.orgId, a.now);
  return {
    msg: r.created || r.updated ? `Findings refreshed: ${r.created} new, ${r.updated} with new evidence.` : "Findings refreshed. Nothing new.", changes: ["learning"], project: null, extra: { ...r },
    events: [{ type: "learning.refresh", category: cat, subject: subject("findings"), projectId: null, after: { created: r.created, updated: r.updated, open: r.open } }],
  };
}

export async function setSwitch(tx: Tx, a: Actor, on: boolean, reason: string | undefined): Promise<Cmd> {
  const was = await proposalsOn(tx, a.orgId);
  if (was === on) throw conflict(`Learning proposals are already ${on ? "on" : "off"}.`);
  if (on && (reason ?? "").trim().length < 4) throw invalid("Give a reason for turning learning proposals on.");
  await setProposalsOn(tx, a.orgId, on);
  return {
    msg: on ? "Learning proposals are on: a person can now draft, accept and verify them." : "Learning proposals are off. Findings keep being recorded; nothing can be drafted or applied.", changes: ["learning"], project: null, extra: { on },
    events: [{ type: "learning.switch", category: cat, subject: subject("proposals"), projectId: null, before: { on: was }, after: { on, ...(reason ? { reason: reason.trim() } : {}) } }],
  };
}

export async function draftProposal(tx: Tx, a: Actor, b: DraftInput): Promise<Cmd> {
  await requireProposalsOn(tx, a.orgId);
  const f = (await findingRows(tx, a.orgId, b.finding))[0];
  if (!f) throw notFound("No such finding.");
  const change = await checkChange(tx, a.orgId, b.kind, b.change);
  const id = await nextProposalId(tx, a.orgId);
  const metric = { signal: f.signal ?? "", project: f.project_id, agent: f.agent_id, target: b.metric.target };
  const history = [stamp(a.id, `Drafted from finding ${f.id}`, a.now.getTime())];
  await tx.query(
    `insert into proposals (org_id, id, finding_id, kind, change, status, title, owner, expected, history, metric, window_days) values ($1,$2,$3,$4,$5::jsonb,'open',$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
    [a.orgId, id, f.id, b.kind, json(change), b.title, a.id, b.expected, json(history), json(metric), b.windowDays],
  );
  const row = (await proposalRows(tx, a.orgId, id))[0]!;
  const project = f.project_id ?? projectOf(change);
  return {
    msg: `${id} drafted.`, changes: ["learning", "home"], project, extra: { proposal: toProposal(row) },
    events: [{ type: "learning.draft", category: cat, subject: subject(id), projectId: project, after: { finding: f.id, kind: b.kind, title: b.title, metric, windowDays: b.windowDays } }],
  };
}

/** People other than `except` who may decide learning proposals for this scope. */
export async function otherDeciders(tx: Queryable, orgId: string, except: string, project: string | null): Promise<string[]> {
  const st = await loadPolicyState(tx, orgId);
  return st.people.filter((p) => p.status === "active" && p.id !== except && can(st, p.id, "learning.apply", { project, repo: null, time: Date.now() }).allowed).map((p) => p.id);
}

export async function acceptProposal(tx: Tx, a: Actor, ctx: ApplyCtx, id: string, note: string | undefined): Promise<Cmd> {
  const r = (await proposalRows(tx, a.orgId, id, true))[0];
  if (!r) throw notFound("No such proposal.");
  await requireProposalsOn(tx, a.orgId);
  if (r.status !== "open") throw conflict(`${id} is already ${legacyStatus(r.status)}.`);
  const project = projectOf(r.change);
  // Spec 13.4: the person who drafted a proposal is not the one who accepts it, where two people exist.
  if (r.owner === a.id) {
    const others = await otherDeciders(tx, a.orgId, a.id, project);
    if (others.length) throw refuse("denied", `You drafted ${id}, so someone else decides it: ${others.length === 1 ? "another person can" : `${others.length} other people can`} accept proposals.`, { needs: "A second person", rule: { kind: "invariant", id: "LEARN-TWO-PERSON", name: "The drafter does not accept" } });
  }
  const done = await applyChange(tx, a, ctx, r);
  const m = r.metric;
  const win = r.window_days ?? 0;
  let baseline: { count: number; from: number; to: number } | null = null;
  if (m && win) {
    const now = a.now.getTime();
    baseline = { count: countMetric(await collectSignals(tx, a.orgId), m, now - win * DAY, now), from: now - win * DAY, to: now };
  }
  const history = [...r.history, stamp(a.id, `Accepted and applied${note ? `: ${note}` : ""}. ${done.msg}`, a.now.getTime())];
  await tx.query(`update proposals set status = 'applied', applied_at = $3, applied_by = $4, decided_by = $4, decided_at = $3, baseline = $5::jsonb, rollback = $6::jsonb, history = $7::jsonb, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [
    a.orgId, id, a.now, a.id, json(baseline), json(done.rollback), json(history),
  ]);
  if (r.finding_id) await tx.query(`update findings set status = 'addressed', addressed_at = $3, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, r.finding_id, a.now]);
  const fin = r.finding_id ? (await findingRows(tx, a.orgId, r.finding_id))[0] : null;
  const scope = project ?? fin?.project_id ?? null;
  const row = (await proposalRows(tx, a.orgId, id))[0]!;
  return {
    msg: `${id} applied. ${done.msg}`, changes: ["learning", "home", ...done.changes], project: scope, extra: { proposal: toProposal(row) },
    events: [...done.events, { type: "learning.apply", category: cat, subject: subject(id), projectId: scope, before: { status: "proposed" }, after: { status: "accepted", kind: r.kind, title: r.title, result: done.msg, baseline, metric: m, windowDays: win, ...(note ? { note } : {}) } }],
  };
}

export async function declineProposal(tx: Tx, a: Actor, id: string, reason: string): Promise<Cmd> {
  const r = (await proposalRows(tx, a.orgId, id, true))[0];
  if (!r) throw notFound("No such proposal.");
  await requireProposalsOn(tx, a.orgId);
  if (r.status !== "open") throw conflict(`${id} is already ${legacyStatus(r.status)}.`);
  const history = [...r.history, stamp(a.id, `Declined: ${reason}`, a.now.getTime())];
  await tx.query(`update proposals set status = 'rejected', reason = $3, decided_by = $4, decided_at = $5, history = $6::jsonb, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, id, reason, a.id, a.now, json(history)]);
  const row = (await proposalRows(tx, a.orgId, id))[0]!;
  const fin = r.finding_id ? (await findingRows(tx, a.orgId, r.finding_id))[0] : null;
  return {
    msg: `${id} declined.`, changes: ["learning", "home"], project: projectOf(r.change) ?? fin?.project_id ?? null, extra: { proposal: toProposal(row) },
    events: [{ type: "learning.decline", category: cat, subject: subject(id), projectId: projectOf(r.change) ?? fin?.project_id ?? null, before: { status: "proposed" }, after: { status: "declined", reason, title: r.title } }],
  };
}

/** Verification is a measurement: the declared signal counted over the declared window after the change was applied, against the declared target. */
export async function verifyProposal(tx: Tx, a: Actor, id: string): Promise<Cmd> {
  const r = (await proposalRows(tx, a.orgId, id, true))[0];
  if (!r) throw notFound("No such proposal.");
  await requireProposalsOn(tx, a.orgId);
  if (r.status !== "applied") throw conflict("Only accepted proposals can be verified.");
  if (!r.metric || !r.window_days || !r.applied_at) throw conflict(`${id} declared no metric and window before it was applied, so it cannot be verified.`);
  const from = new Date(r.applied_at).getTime();
  const to = from + r.window_days * DAY;
  if (a.now.getTime() < to) throw conflict(`The window runs until ${new Date(to).toISOString().slice(0, 10)}. ${id} can be verified then.`, );
  const measured = countMetric(await collectSignals(tx, a.orgId), r.metric, from, to);
  if (measured > r.metric.target) throw conflict(`Not verified: ${measured} ${r.metric.signal} signal${measured === 1 ? "" : "s"} in the ${r.window_days} days after it was applied, against a target of at most ${r.metric.target}.`);
  const v = { measured, target: r.metric.target, baseline: r.baseline?.count ?? null, at: a.now.getTime(), by: a.id };
  const history = [...r.history, stamp(a.id, `Verified: ${measured} signals in ${r.window_days} days (target at most ${r.metric.target}${r.baseline ? `, before: ${r.baseline.count}` : ""}).`, a.now.getTime())];
  await tx.query(`update proposals set status = 'verified', verification = $3::jsonb, history = $4::jsonb, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, id, json(v), json(history)]);
  const row = (await proposalRows(tx, a.orgId, id))[0]!;
  return {
    msg: `${id} verified.`, changes: ["learning", "home"], project: projectOf(r.change), extra: { proposal: toProposal(row) },
    events: [{ type: "learning.verify", category: cat, subject: subject(id), projectId: projectOf(r.change), before: { status: "accepted" }, after: { status: "verified", ...v, windowDays: r.window_days } }],
  };
}

export async function rollbackProposal(tx: Tx, a: Actor, ctx: ApplyCtx, id: string, reason: string): Promise<Cmd> {
  const r = (await proposalRows(tx, a.orgId, id, true))[0];
  if (!r) throw notFound("No such proposal.");
  await requireProposalsOn(tx, a.orgId);
  if (r.status !== "applied" && r.status !== "verified") throw conflict(`${id} is ${legacyStatus(r.status)}; only an applied change can be rolled back.`);
  const done = await undoChange(tx, a, ctx, r);
  const history = [...r.history, stamp(a.id, `Rolled back: ${reason}. ${done.msg}`, a.now.getTime())];
  await tx.query(`update proposals set status = 'rolled_back', rolled_back_at = $3, rolled_back_by = $4, reason = $5, history = $6::jsonb, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, id, a.now, a.id, reason, json(history)]);
  // The finding is open again unless the same kind of finding was opened in the meantime.
  if (r.finding_id) await tx.query(`update findings f set status = 'open', addressed_at = null, version = version + 1, updated_at = now() where org_id = $1 and id = $2 and not exists (select 1 from findings o where o.org_id = f.org_id and o.status = 'open' and o.signal = f.signal and coalesce(o.agent_id,'') = coalesce(f.agent_id,'') and coalesce(o.project_id,'') = coalesce(f.project_id,''))`, [a.orgId, r.finding_id]);
  const row = (await proposalRows(tx, a.orgId, id))[0]!;
  return {
    msg: `${id} rolled back. ${done.msg}`, changes: ["learning", "home", ...done.changes], project: done.project, extra: { proposal: toProposal(row) },
    events: [...done.events, { type: "learning.rollback", category: cat, subject: subject(id), projectId: done.project, before: { status: legacyStatus(r.status) }, after: { status: "rolled_back", reason, title: r.title } }],
  };
}
