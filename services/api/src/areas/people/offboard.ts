/**
 * Offboarding (spec 14.4). Deactivating a person removes access and nothing else: it ends their sessions, revokes the API keys they
 * created, clears the away/delegate links that point at them and takes them off project on-call lists. It never reassigns work and
 * never picks a delegate: the response lists the open work that needs a new owner so a person decides. One audit event per effect.
 * Reactivating restores status `active` only; roles stay as they are and revoked keys stay revoked.
 * Known gap: the platform has no on-call rotation table yet, so only the per-project on-call lists (owner decision 7) and the person's
 * on-call flag are cleaned. When rotations are added, removing the person from them belongs in deactivatePerson.
 */
import { checkPersonRemoval, gateApprovers, isFactoryAdminPerson } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import type { Actor, CommandResult, EventSpec } from "../../core/command.js";
import { revokeSessions } from "../../core/auth/sessions.js";
import { conflict, notFound, refuse, Refusal } from "../../core/errors.js";
import { OPEN_STATES, loadFlow, stateWithPinned } from "../workorders/model.js";
import { lockOrgConfig, stateIn } from "../access/config.js";
import { issueInvite } from "./people.js";
import type { z } from "zod";
import type { DeactivateBody, ReactivateBody } from "./schemas.js";

export interface OpenWorkItem {
  id: string;
  title: string;
  project: string;
  state: string;
  /** Why this person matters to it: requester, assignee or sole_approver (with `gate`). */
  roles: Array<"requester" | "assignee" | "sole_approver" | "asked">;
  /** Open blocking questions addressed to them (as the requester) that now go to the project admins and line leads. */
  questions?: number;
  gate?: string;
}

type Out = CommandResult<Record<string, unknown>>;
const bump = (tx: Tx, orgId: string, id: string): Promise<{ rows: Array<{ version: number }> }> =>
  tx.query(`update people set version = version + 1, updated_at = now() where org_id = $1 and id = $2 returning version`, [orgId, id]);

/** Open work orders where the person is requester, assignee or the only person who can approve a gate that is waiting now. Read only. */
export async function openWorkOf(tx: Tx, orgId: string, id: string, now: number): Promise<OpenWorkItem[]> {
  const rows = (await tx.query<{ id: string; assignee: string | null; flow_version: number }>(
    `select id, assignee, flow_version from work_orders where org_id = $1 and state = any($2::text[]) and source not in ('eval','onboarding') order by created_at, id`,
    [orgId, [...OPEN_STATES]],
  )).rows;
  if (!rows.length) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const st = await loadFlow(tx, orgId, { ids: rows.map((r) => r.id) });
  const items: OpenWorkItem[] = [];
  for (const wo of st.workOrders) {
    const row = byId.get(wo.id);
    if (!row) continue;
    const roles: OpenWorkItem["roles"] = [];
    if (wo.requestedBy === id) roles.push("requester");
    const asked = wo.requestedBy === id ? (await tx.query<{ n: number }>(`select count(*)::int as n from wo_questions where org_id = $1 and wo_id = $2 and status = 'open' and blocking and ask_of in ('requester','anyone')`, [orgId, wo.id])).rows[0]!.n : 0;
    if (asked) roles.push("asked");
    if (row.assignee === id) roles.push("assignee");
    let gate: string | undefined;
    const waiting = Object.entries(wo.gates).filter(([, g]) => g.status === "waiting").map(([k]) => k);
    if (waiting.length) {
      const pinned = await stateWithPinned(tx, orgId, st, { project: wo.project, flowVersion: row.flow_version });
      for (const gid of waiting) {
        const ga = gateApprovers(pinned, wo, gid, now);
        // Factory Admins can always approve any gate (owner decision 2026-11-19), so they are the standing fallback, not the people the rule names:
        // the person is the "sole approver" when nobody else the rule reaches can approve, whichever admins exist.
        const named = ga?.eligible.filter((e) => e.id === id || !pinned.people.some((p) => p.id === e.id && p.roles.some((g) => g.role === "factory_admin" && g.scope === "factory"))) ?? [];
        if (ga && named.length === 1 && named[0]!.id === id) {
          gate = gid;
          roles.push("sole_approver");
          break;
        }
      }
    }
    if (roles.length) items.push({ id: wo.id, title: wo.title, project: wo.project, state: String(wo.state), roles, ...(gate ? { gate } : {}), ...(asked ? { questions: asked } : {}) });
  }
  return items;
}

export async function deactivatePerson(tx: Tx, a: Actor, id: string, body: z.infer<typeof DeactivateBody>): Promise<Out> {
  await lockOrgConfig(tx, a.orgId);
  const st = await stateIn(tx, a.orgId);
  const p = st.people.find((x) => x.id === id);
  if (!p) throw notFound("No such person.");
  if (p.status === "deactivated") throw conflict(`${p.name} is already deactivated.`);
  const actorId = a.personId ?? a.id;
  if (actorId === id) throw refuse("denied", "You cannot deactivate yourself. Ask another administrator.", { rule: { kind: "invariant", id: "INV-14.4-SELF", name: "Own account" }, needs: "Another administrator" });
  // The last-admin rule comes first so the refusal names the rule whoever asks; then only a Factory Admin may remove a Factory Admin.
  const checked = checkPersonRemoval(st.people, { actorId, targetId: id });
  if (!checked.ok) throw new Refusal(checked.error);
  const actor = st.people.find((x) => x.id === actorId);
  if (isFactoryAdminPerson(p) && !actor?.roles.some((g) => g.role === "factory_admin" && g.scope === "factory"))
    throw refuse("denied", "Only a Factory Admin can deactivate a Factory Admin.", { needs: "factory_admin" });

  const reason = body.reason;
  // Computed before the status changes, while the person still counts as an eligible approver.
  const openWork = await openWorkOf(tx, a.orgId, id, a.now.getTime());
  const events: EventSpec[] = [];
  const subject = { type: "person", id } as const;

  await tx.query(`update people set status = 'deactivated', away = null, oncall = false where org_id = $1 and id = $2`, [a.orgId, id]);
  const version = (await bump(tx, a.orgId, id)).rows[0]!.version;

  const sessions = await revokeSessions(tx, a.orgId, id, null, a.id);

  const keys = (await tx.query<{ id: string; name: string; key_prefix: string; project_id: string | null }>(
    `select id, name, key_prefix, project_id from api_keys where org_id = $1 and created_by = $2 and revoked_at is null and (expires_at is null or expires_at > $3) order by id for update`,
    [a.orgId, id, a.now],
  )).rows;
  if (body.keepKeys && keys.length) await tx.query(`update api_keys set keep_live = true, updated_at = now() where org_id = $1 and id = any($2::text[])`, [a.orgId, keys.map((k) => k.id)]);
  if (!body.keepKeys && keys.length) {
    await tx.query(`update api_keys set revoked_at = $3, revoked_by = $4, updated_at = now() where org_id = $1 and id = any($2::text[])`, [a.orgId, keys.map((k) => k.id), a.now, a.personId]);
  }

  // Away status: their own, and every other person's delegate pointing at them. People decide a new delegate.
  const delegators = (await tx.query<{ id: string; name: string }>(`select id, name from people where org_id = $1 and id <> $2 and away ->> 'delegate' = $2`, [a.orgId, id])).rows;
  if (delegators.length) await tx.query(`update people set away = null, version = version + 1, updated_at = now() where org_id = $1 and id = any($2::text[])`, [a.orgId, delegators.map((d) => d.id)]);
  const delegations = (await tx.query<{ id: string; from_person: string; to_person: string; project_id: string | null }>(
    `update delegations set revoked_at = $3, updated_at = now() where org_id = $1 and revoked_at is null and (from_person = $2 or to_person = $2) returning id, from_person, to_person, project_id`,
    [a.orgId, id, a.now],
  )).rows;

  // On call per project (owner decision 7): take them off every list. Factory Admins always count and are never listed.
  const oncall = (await tx.query<{ id: string; list: string[] }>(`select id, config -> 'oncall' as list from projects where org_id = $1 and config -> 'oncall' @> to_jsonb($2::text) for update`, [a.orgId, id])).rows;
  for (const pr of oncall) {
    const next = (pr.list ?? []).filter((x) => x !== id);
    await tx.query(`update projects set config = jsonb_set(config, '{oncall}', $3::jsonb), version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, pr.id, JSON.stringify(next)]);
    events.push({ type: "project.oncall", category: "access", subject: { type: "project", id: pr.id }, projectId: pr.id, before: pr.list, after: next });
  }

  // Projects this person owned or administered, and whether any other active Project Admin is left (S-47). Allowed for a Factory Admin with a reason; it is named, not blocked.
  const led = (await tx.query<{ id: string; name: string; owner_id: string | null; was_admin: boolean; others: number }>(
    `select p.id, p.name, p.owner_id,
            exists (select 1 from role_assignments r where r.org_id = p.org_id and r.project_id = p.id and r.person_id = $2 and r.role_id = 'project_admin' and r.revoked_at is null) as was_admin,
            (select count(*)::int from role_assignments r join people q on q.org_id = r.org_id and q.id = r.person_id where r.org_id = p.org_id and r.project_id = p.id and r.role_id = 'project_admin' and r.revoked_at is null and q.status = 'active' and q.id <> $2) as others
       from projects p where p.org_id = $1 and p.status <> 'archived' and (p.owner_id = $2 or exists (select 1 from role_assignments r where r.org_id = p.org_id and r.project_id = p.id and r.person_id = $2 and r.role_id = 'project_admin' and r.revoked_at is null))
      order by p.id`,
    [a.orgId, id],
  )).rows;
  const projects = led.map((r) => ({ id: r.id, name: r.name, owner: r.owner_id, soleAdmin: r.others === 0 }));
  const noAdmin = projects.filter((x) => x.soleAdmin);

  events.unshift({
    type: "people.deactivate", category: "access", subject, projectId: null, before: p.status,
    after: { status: "deactivated", reason, keepKeys: !!body.keepKeys, ...(body.keepKeys && keys.length ? { keysLeftLive: keys.map((k) => k.id) } : {}), openWork: openWork.length, ...(projects.length ? { projects } : {}), ...(noAdmin.length ? { leftWithoutAdmin: noAdmin.map((x) => x.id) } : {}) },
  });
  events.push({ type: "people.sessions.revoke", category: "access", subject, projectId: null, before: { live: sessions.length }, after: { revoked: sessions.length, reason } });
  if (!body.keepKeys) {
    for (const k of keys) events.push({ type: "api.key.revoke", category: "api", subject: { type: "apikey", id: k.id }, projectId: k.project_id, before: { revoked: false }, after: { name: k.name, prefix: k.key_prefix, revoked: true, reason: `${p.name} was deactivated: ${reason}` } });
  }
  for (const d of delegators) events.push({ type: "approvers.delegate", category: "approvals", subject: { type: "person", id: d.id }, projectId: null, before: p.name, after: { delegate: null, reason: `${p.name} was deactivated` } });
  if (p.away) events.push({ type: "approvers.delegate", category: "approvals", subject, projectId: null, before: p.away.delegate, after: { delegate: null, reason } });
  for (const d of delegations) events.push({ type: "delegation.revoke", category: "approvals", subject: { type: "delegation", id: d.id }, projectId: d.project_id, before: { from: d.from_person, to: d.to_person, revoked: false }, after: { revoked: true, reason: `${p.name} was deactivated: ${reason}` } });
  if (p.oncall) events.push({ type: "people.oncall", category: "access", subject, projectId: null, before: true, after: false });

  return {
    msg: `${p.name} is deactivated. ${openWork.length ? `${openWork.length} open work ${openWork.length === 1 ? "order needs" : "orders need"} a new owner.` : "They have no open work."}${noAdmin.length ? ` ${noAdmin.map((x) => x.name).join(", ")} ${noAdmin.length === 1 ? "has" : "have"} no active Project Admin left: only a Factory Admin can administer ${noAdmin.length === 1 ? "it" : "them"} until someone is named.` : ""}`,
    events,
    extra: {
      version,
      sessionsRevoked: sessions.length,
      keys: { revoked: body.keepKeys ? [] : keys.map((k) => k.id), kept: body.keepKeys ? keys.map((k) => k.id) : [] },
      delegatorsCleared: delegators.map((d) => d.id),
      delegationsRevoked: delegations.map((d) => d.id),
      oncallRemoved: oncall.map((o) => o.id),
      openWork,
      projects,
      projectsWithoutAdmin: noAdmin.map((x) => x.id),
    },
    changes: ["people", "projects", "apiKeys", "matrix"],
    project: null,
  };
}

export async function reactivatePerson(tx: Tx, a: Actor, id: string, body: z.infer<typeof ReactivateBody>, publicUrl = ""): Promise<Out> {
  await lockOrgConfig(tx, a.orgId);
  const st = await stateIn(tx, a.orgId);
  const p = st.people.find((x) => x.id === id);
  if (!p) throw notFound("No such person.");
  // Reactivating restores the old roles, so it needs the same actor check as deactivating a Factory Admin.
  const actor = st.people.find((x) => x.id === (a.personId ?? a.id));
  if (isFactoryAdminPerson(p) && !actor?.roles.some((g) => g.role === "factory_admin" && g.scope === "factory"))
    throw refuse("denied", "Only a Factory Admin can reactivate a Factory Admin.", { needs: "factory_admin" });
  if (p.status !== "deactivated") throw conflict(`${p.name} is not deactivated.`);
  // 'active' implies 'linked' (acceptInvite's rule): someone who never signed in has no identity to come back as, and would be active but unable to sign in
  // (the old invite is spent or expired). They go back to invited with a fresh invite instead, which they accept by signing in.
  // Seeded and imported people are unlinked too but are signed in by Gantry id; only someone who was invited and never accepted is waiting on an invite.
  const waiting = (await tx.query(`select (p.idp_subject is null and exists (select 1 from invites i where i.org_id = p.org_id and i.id = p.id and i.status <> 'accepted')) as waiting from people p where p.org_id = $1 and p.id = $2`, [a.orgId, id])).rows[0]?.waiting === true;
  if (waiting) {
    await tx.query(`update people set status = 'invited' where org_id = $1 and id = $2`, [a.orgId, id]);
    const inv = await issueInvite(tx, a.orgId, publicUrl, a.id, { id, name: p.name, email: p.email }, `reactivated without a sign-in: ${body.reason}`);
    const v = (await bump(tx, a.orgId, id)).rows[0]!.version;
    return {
      msg: `${p.name} never signed in, so they are invited again rather than active: a new invite was sent to ${p.email}. Their roles are unchanged.`,
      events: [{ type: "people.reactivate", category: "access", subject: { type: "person", id }, projectId: null, before: "deactivated", after: { status: "invited", reason: body.reason, invite: inv.expiresAt } }, inv.event],
      outbox: inv.outbox, extra: { version: v, status: "invited" }, changes: ["people", "matrix"], project: null,
    };
  }
  await tx.query(`update people set status = 'active' where org_id = $1 and id = $2`, [a.orgId, id]);
  const version = (await bump(tx, a.orgId, id)).rows[0]!.version;
  return {
    msg: `${p.name} is active again. Their roles are unchanged; revoked keys and sessions stay revoked.`,
    events: [{ type: "people.reactivate", category: "access", subject: { type: "person", id }, projectId: null, before: "deactivated", after: { status: "active", reason: body.reason } }],
    extra: { version },
    changes: ["people", "matrix"],
    project: null,
  };
}
