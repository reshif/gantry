/** Gate votes and decisions (spec 9.5): approve, reject and the brief confirmation. Each approver counts once (F6) and a vote is judged by the rule in force at that moment. */
import { gateDef, gateProgress, gateDecision, route, stationDef, type Catalog } from "@gantry/domain";
import type { Actor } from "../../core/command.js";
import { invalid, refuse } from "../../core/errors.js";
import { coveringStop, closeEntry, closeInstance, advance, bayOf, enterStation, finish, note, openInstanceOf, recordDecision, ev, stationIdOf, cancelAttempts, type Fx } from "./engine.js";
import { appendMessage, closeConversation } from "./conversation.js";
import { recordBriefDocument } from "./station-docs.js";
import { begin, done, flowFor, person, type CmdResult } from "./ctx.js";
import { saveWo, type Wo } from "./model.js";
import { declineInner } from "./intake.js";

export function parseGateId(id: string): { woId: string; gateId: string; n: number | null } {
  const parts = id.split(":");
  if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) throw invalid("A gate instance id looks like WO-1042:G2.");
  const n = parts[2] === undefined ? null : Number(parts[2]);
  if (n !== null && !(Number.isInteger(n) && n > 0)) throw invalid("A gate instance id looks like WO-1042:G2.");
  return { woId: parts[0], gateId: parts[1], n };
}

/** The catalogue action that decides a gate: the brief confirmation for G0+G1, the release right for G6, the gate's own action or gate.approve otherwise. */
export function actionForGate(catalog: Pick<Catalog, "gates">, gateId: string): string {
  if (gateId === "G0G1") return "brief.confirm";
  return gateDef(catalog as Catalog, gateId)?.action ?? (gateId === "G6" ? "release" : "gate.approve");
}

/**
 * A8: a person's approve or reject names the exact opening it decides (`WO-1:G2:3`), so a decision made on a stale screen cannot land on a newer
 * instance. Without the number the request is refused with 428 and the open instance, so a script can read it and send it back. Runs inside the
 * command, after the permission check, so it tells nobody what they may not see. Slack buttons and the work-order session pass their own instance.
 */
export async function requireGatePin(tx: import("@gantry/db").Tx, orgId: string, woId: string, gateId: string, n: number | null): Promise<number> {
  if (n !== null) return n;
  const open = await openInstanceOf(tx, orgId, woId, gateId);
  const cur = open ? Number(open.id.split(":")[2]) : null;
  const id = open?.id ?? null;
  throw refuse("precondition", open
    ? `Say which opening you are deciding: send the instance id ${id} (POST /api/v1/gate-instances/${id}/approve). ${woId} is waiting at ${gateId} on instance ${cur}.`
    : `${woId} is not waiting at ${gateId}. Nothing to decide; reload.`, { needs: "gate instance", current: { instance: id, n: cur, gate: gateId, wo: woId } });
}

/** A stale click (spec 9.5): the instance a card or button refers to is not the open one any more. */
async function openInstanceFor(fx: Fx, w: Wo, gateId: string, n: number | null) {
  const inst = await openInstanceOf(fx.tx, fx.orgId, w.id, gateId);
  if (!inst || (n !== null && inst.id !== `${w.id}:${gateId}:${n}`)) {
    throw refuse("stale", `${w.id} is no longer waiting at ${gateDef(fx.catalog, gateId)?.label ?? gateId} on that instance. It was decided, sent back or reopened. Reload and try again.`, { current: { instance: inst?.id ?? null, gate: gateId, wo: w.id } });
  }
  return inst;
}

async function insertVote(fx: Fx, w: Wo, instId: string, voter: string, vote: "approve" | "reject", comment: string, via: string): Promise<void> {
  const role = (
    await fx.tx.query<{ role_id: string; id: string }>(
      `select id, role_id from effective_role_assignments where org_id = $1 and person_id = $2 and revoked_at is null and (expires_at is null or expires_at > now()) and (project_id = $3 or project_id is null) order by (project_id is null), created_at limit 1`,
      [fx.orgId, voter, w.project],
    )
  ).rows[0];
  const r = await fx.tx.query(
    `insert into gate_votes (org_id, id, gate_instance_id, voter, role_id, role_assignment_id, vote, comment, at, via) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (org_id, gate_instance_id, voter) do nothing`,
    [fx.orgId, `GV-${instId}-${voter}`, instId, voter, role?.role_id ?? null, role?.id ?? null, vote, comment, fx.now, via],
  );
  if (!r.rowCount) throw refuse("denied", "You already voted on this gate instance.", { rule: { kind: "approver", id: "APPROVERS", name: "Approver rules" }, needs: "Another approver" });
}

/** The latest history entry gets the outcome of the gate's decision (the open entry was closed as "waiting" when the gate opened). */
function markLastEntry(w: Wo, outcome: string, text = ""): void {
  const h = Array.isArray(w.data.history) ? (w.data.history as Array<{ endedAt: number | null; outcome: string | null; note: string; station: string }>) : [];
  const e = h[h.length - 1];
  if (e) {
    e.outcome = outcome;
    if (text) e.note = text;
  }
}

/**
 * Approve the open instance of a gate. G0+G1 is the brief confirmation: one confirmation passes it. Other gates pass when N of M is met by distinct approvers
 * under the rule in force now, and never below the number the instance was opened with (tightening applies at once, loosening never approves waiting work, spec 9.3).
 */
export async function approveGate(tx: import("@gantry/db").Tx, actor: Actor, woId: string, gateId: string, n: number | null, o: { via?: string; reason?: string } = {}): Promise<CmdResult> {
  // "Approve anyway": a Factory Admin who gives a reason is not stopped by the halt guard here; approveInner decides, records and audits it. A kill is never skipped.
  const adminWithReason = !!o.reason && o.reason.trim().length >= 5 && !!actor.personId && (await tx.query(`select 1 from effective_role_assignments where org_id = $1 and person_id = $2 and role_id = 'factory_admin' and project_id is null and revoked_at is null and (expires_at is null or expires_at > now()) limit 1`, [actor.orgId, actor.personId])).rows.length > 0;
  const { fx, w } = await begin(tx, actor, woId, "gate.approve", { haltOverride: adminWithReason });
  return approveInner(fx, actor, w, gateId, n, o.via, o.reason);
}

export async function approveInner(fx: Fx, actor: Actor, w: Wo, gateId: string, n: number | null, via?: string, overrideReason?: string): Promise<CmdResult> {
  const g = gateDef(fx.catalog, gateId);
  if (!g) throw invalid(`Unknown gate ${gateId}.`);
  if (bayOf(fx.catalog, w)) throw refuse("conflict", `${w.id} is parked in a bay; return it to the belt first.`);
  const inst = await openInstanceFor(fx, w, gateId, n);
  const by = person(actor, "Gate decisions are");
  const { st, wo } = await flowFor(fx, w);
  if (gateId === "G0G1" && !wo.conv.done) throw invalid("Answer the open intake questions first; the brief is not complete.");
  let d = gateDecision(st, by, wo, gateId, fx.now.getTime());
  // Owner decision 2026-11-19: a Factory Admin may approve during a freeze or a halt with a reason (a kill still blocks). Never silent: the reason is audited below.
  const reason5 = overrideReason && overrideReason.trim().length >= 5 ? overrideReason.trim() : "";
  const covering = await coveringStop(fx.tx, fx.orgId, w);
  const adminNow = st.people.some((p) => p.id === by && p.roles.some((r) => r.role === "factory_admin" && r.scope === "factory"));
  let stopKind: "freeze" | "halt" | null = null;
  if (adminNow && covering?.mode === "halt") stopKind = "halt";
  if (!d.allowed && d.override) {
    stopKind = d.overrideKind ?? (d.rule.kind === "stop" ? "halt" : "freeze");
    if (!reason5) throw refuse("denied", `${d.reason} As Factory Admin you can approve anyway. Give a reason of at least 5 characters; it is recorded in the audit.`, { needs: "override_reason", rule: d.rule });
    d = gateDecision(st, by, wo, gateId, fx.now.getTime(), { override: true });
  } else if (d.allowed && d.override) stopKind = d.overrideKind ?? stopKind;
  if (stopKind && !reason5) throw refuse("denied", `${covering ? covering.reason : "A stop is in force"} As Factory Admin you can approve anyway. Give a reason of at least 5 characters; it is recorded in the audit.`, { needs: "override_reason", rule: { kind: "stop", id: "STOP-" + (covering?.scope ?? "project").toUpperCase(), name: "Stop state" } });
  if (!d.allowed) throw refuse("denied", d.reason, { rule: d.rule, ...(d.needs ? { needs: d.needs } : {}) });
  await insertVote(fx, w, inst.id, by, "approve", "", via ?? actor.channel);
  const after = await flowFor(fx, w);
  const project = after.st.projects.find((p) => p.id === w.project)!;
  const prog = gateProgress(project, after.wo, gateId, after.st.people);
  // The count never drops below what the instance opened with, except where the rule lists this class: that override is the owner's setting and applies live.
  const classSet = !!project.approvers[gateId]?.classRequired && Object.prototype.hasOwnProperty.call(project.approvers[gateId]!.classRequired, w.cls);
  const need = classSet ? prog.need : Math.max(prog.need, Number(inst.basis.required) || 0);
  const ruled = gateId === "G0G1" ? true : prog.passes && prog.have >= need;
  // Factory Admin is a normal approver on every gate (owner decision 2026-11-19): their vote is an ordinary vote, counted toward N of M.
  // Break-glass is only for a vote the rule cannot accept from them: the author under separation of duties, or the author alone / an unmet
  // condition blocking an otherwise full count. It needs a reason and is flagged in the audit. Nobody else can override.
  const isAdmin = (after.st.people.find((p) => p.id === by)?.roles ?? []).some((r) => r.role === "factory_admin" && r.scope === "factory");
  // Bypassing separation of duties is always an override, even when the count would be met with the author's vote.
  const sodBypass = isAdmin && gateId !== "G0G1" && !!project.approvers[gateId]?.sod && wo.requestedBy === by;
  // N of M that cannot be reached (fewer eligible people than the gate needs) is a break-glass case too: the admin passes it with a reason.
  const eligible = new Set(after.wo.gates[gateId]?.approvals.map((a) => a.by) ?? []);
  if (isAdmin && !ruled && gateId !== "G0G1") for (const pp of after.st.people) if (pp.status === "active" && !eligible.has(pp.id) && gateDecision(after.st, pp.id, after.wo, gateId, fx.now.getTime()).allowed) eligible.add(pp.id);
  const unreachable = isAdmin && !ruled && gateId !== "G0G1" && eligible.size < need;
  const override = isAdmin && ((!ruled && (prog.onlyRequester || prog.unmet.length > 0 || unreachable)) || sodBypass);
  if (override && (!overrideReason || overrideReason.trim().length < 5)) {
    throw refuse("denied", `As Factory Admin you can override ${g.label} (it needs ${need} approval${need === 1 ? "" : "s"}${prog.onlyRequester || wo.requestedBy === by ? ", and you are the author" : ""}${unreachable ? `; only ${eligible.size} ${eligible.size === 1 ? "person" : "people"} can approve it, so it cannot be reached` : ""}). Give a reason of at least 5 characters; it is recorded in the audit.`, { needs: "override_reason", rule: { kind: "approver", id: "APR-" + gateId, name: "Factory Admin override" } });
  }
  const passes = (ruled && !sodBypass) || override;
  const voter = { personId: by, via: via ?? actor.channel, channel: actor.channel };
  if (override) {
    const why = overrideReason!.trim();
    note(w, fx, by, `${g.label} passed by Factory Admin override (${prog.have} of ${need} approvals): ${why}`);
    ev(fx, w, "gate.override", { gate: gateId, by, text: why, have: prog.have, need, author: wo.requestedBy === by, instance: inst.id, ...(unreachable ? { unreachable: true, eligible: eligible.size } : {}) }, { category: "approvals" });
  }
  if (stopKind) {
    note(w, fx, by, `${g.label} approved by Factory Admin override during ${stopKind === "freeze" ? "a release freeze" : "a halt"}: ${reason5}`);
    ev(fx, w, "gate.override", { gate: gateId, by, text: reason5, kind: stopKind, have: prog.have, need, author: wo.requestedBy === by, instance: inst.id }, { category: "approvals" });
  }
  if (!passes) {
    const unmet = prog.unmet.length ? `; still needs: ${prog.unmet.map((c) => c.text).join("; ")}` : prog.onlyRequester ? "; the requester cannot be the only approver" : "";
    note(w, fx, by, `${g.label} approval ${prog.have} of ${need}.`);
    ev(fx, w, "gate.vote", { gate: gateId, by, text: `${prog.have} of ${need}`, instance: inst.id }, { category: "approvals" });
    await saveWo(fx.tx, fx.orgId, w);
    return done(fx, `${g.label} approval recorded (${prog.have} of ${need}${unmet}).`, w.project, { passed: false, have: prog.have, need, instance: inst.id, version: w.version });
  }
  await recordDecision(fx, w, inst, gateId, "approved", voter, { approvals: prog.have, override: override || !!stopKind, ...(override || stopKind ? { reason: (overrideReason ?? reason5).trim() } : {}) });
  await closeInstance(fx, inst.id, "decision");
  note(w, fx, by, `${g.label} ${g.name} approved${via && via !== "web" ? ` via ${via}` : ""}.`);
  // Phase 3: what the approver had in front of them, recorded with the decision (not a block): assumptions nobody confirmed, objections nobody decided.
  const openNotes = (await fx.tx.query<{ a: number; o: number }>(`select (select count(*)::int from wo_assumptions where org_id = $1 and wo_id = $2 and status = 'open') as a, (select count(*)::int from wo_objections where org_id = $1 and wo_id = $2 and status = 'open') as o`, [fx.orgId, w.id])).rows[0]!;
  ev(fx, w, "gate.decision", { gate: gateId, mode: "human", by, trust: null, instance: inst.id, openAssumptions: openNotes.a, openObjections: openNotes.o }, { category: "approvals" });
  let msg = "";
  if (gateId === "G0G1") await confirmBrief(fx, w, by);
  if (gateId === "G6") {
    await finish(fx, w, by);
    msg = `${w.id} released and confirmed.`;
  } else if (gateId === "G5" && (await requestMerge(fx, w))) {
    msg = `${g.label} approved. Merge requested.`;
  } else {
    if (gateId !== "G0G1") markLastEntry(w, "passed");
    await advance(fx, w, by);
    msg = gateId === "G0G1" ? "Brief confirmed." : `${g.label} approved.`;
  }
  await saveWo(fx.tx, fx.orgId, w);
  const here = bayOf(fx.catalog, w) ?? stationIdOf(fx.catalog, w);
  return done(fx, `${msg} ${w.id} is at ${fx.catalog.bays.find((b) => b.id === here)?.name ?? stationDef(fx.catalog, here)?.name ?? here}.`, w.project, { passed: true, have: prog.have, need, instance: inst.id, version: w.version });
}

/** G0+G1 passed: the brief becomes version N, the conversation closes and the route starts. */
async function confirmBrief(fx: Fx, w: Wo, by: string): Promise<void> {
  const brief = w.data.brief ?? {};
  const v = Number((await fx.tx.query(`select coalesce(max(version), 0) + 1 as v from brief_versions where org_id = $1 and wo_id = $2`, [fx.orgId, w.id])).rows[0].v);
  const project = (await flowFor(fx, w)).st.projects.find((p) => p.id === w.project)!;
  const r = route(fx.catalog, project, w.cls);
  await fx.tx.query(`insert into brief_versions (org_id, wo_id, version, body, class, route, confirmed_by, confirmed_at) values ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8)`, [fx.orgId, w.id, v, JSON.stringify(brief), w.cls, JSON.stringify(r), by, fx.now]);
  const names = r.map((s) => stationDef(fx.catalog, s)?.name ?? s).join(" → ");
  const who = (await fx.tx.query<{ name: string }>(`select name from people where org_id = $1 and id = $2`, [fx.orgId, by])).rows[0]?.name ?? by;
  await recordBriefDocument(fx.tx, { orgId: fx.orgId, woId: w.id, version: v, brief: brief as Record<string, unknown>, cls: w.cls, route: r.map((s) => stationDef(fx.catalog, s)?.name ?? s), by, byName: who });
  await appendMessage(fx, w.id, "system", `Brief confirmed by ${who}. Starting the route: ${names}.`);
  await closeConversation(fx, w.id);
  closeEntry(w, fx, "passed");
  note(w, fx, by, "G0+G1 brief confirmed.");
}

/** Approving the merge gate asks the GitHub broker to merge the pull request at the approved head commit (F4: the intent is the job's dedupe key). Returns false when there is no pull request to merge. */
export async function requestMerge(fx: Fx, w: Wo): Promise<boolean> {
  const pr = (await fx.tx.query<{ number: number; head_sha: string | null }>(`select number, head_sha from pull_requests where org_id = $1 and wo_id = $2 and state = 'open' order by number desc limit 1`, [fx.orgId, w.id])).rows[0];
  if (!pr || !pr.head_sha) return false;
  const { job } = await import("../../core/jobs-contract.js");
  fx.jobs.push(job("merge.request", { woId: w.id, prNumber: pr.number, headSha: pr.head_sha }, { dedupeKey: `merge:${w.id}:${pr.number}:${pr.head_sha}` }));
  w.state = "waiting";
  w.data.merging = { prNumber: pr.number, headSha: pr.head_sha, at: fx.now.getTime() };
  w.data.blockReason = `Merging pull request #${pr.number}.`;
  note(w, fx, "system", `Merge of #${pr.number} requested at ${pr.head_sha.slice(0, 7)}.`);
  return true;
}

/** Reject the open instance: the station is reworked (G0+G1 declines the request instead). */
export async function rejectGate(tx: import("@gantry/db").Tx, actor: Actor, woId: string, gateId: string, n: number | null, reason: string, via?: string): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "gate.reject");
  const g = gateDef(fx.catalog, gateId);
  if (!g) throw invalid(`Unknown gate ${gateId}.`);
  if (!reason || reason.trim().length < 5) throw invalid("Give a reason of at least 5 characters.");
  if (bayOf(fx.catalog, w)) throw refuse("conflict", `${w.id} is parked in a bay; return it to the belt first.`);
  const inst = await openInstanceFor(fx, w, gateId, n);
  const by = person(actor, "Gate decisions are");
  if (gateId === "G0G1") return declineInner(fx, actor, w, reason.trim(), via, { fromGate: inst });
  const { st, wo } = await flowFor(fx, w);
  const d = gateDecision(st, by, wo, gateId, fx.now.getTime());
  if (!d.allowed) throw refuse("denied", d.reason, { rule: d.rule, ...(d.needs ? { needs: d.needs } : {}) });
  await insertVote(fx, w, inst.id, by, "reject", reason.trim(), via ?? actor.channel);
  await recordDecision(fx, w, inst, gateId, "rejected", { personId: by, via: via ?? actor.channel, channel: actor.channel }, { reason: reason.trim() });
  await closeInstance(fx, inst.id, "decision");
  const sid = stationIdOf(fx.catalog, w);
  markLastEntry(w, `rejected at ${g.label}`, reason.trim());
  w.data.sendbacks = [...(Array.isArray(w.data.sendbacks) ? (w.data.sendbacks as unknown[]) : []), { from: sid, to: sid, note: reason.trim(), at: fx.now.getTime(), by, gate: gateId }];
  note(w, fx, by, `${g.label} rejected: ${reason.trim()}. Reworking ${stationDef(fx.catalog, sid)?.name ?? sid}.`);
  ev(fx, w, "gate.decision", { gate: gateId, mode: "human", by, text: `rejected: ${reason.trim()}`, instance: inst.id }, { category: "approvals" });
  await cancelAttempts(fx, w, "rejected");
  await enterStation(fx, w, sid);
  await saveWo(fx.tx, fx.orgId, w);
  return done(fx, `${g.label} rejected; ${w.id} is reworking ${stationDef(fx.catalog, sid)?.name ?? sid}.`, w.project, { passed: false, instance: inst.id, version: w.version });
}
