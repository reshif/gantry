import type { Tx } from "@gantry/db";
import type { CommandResult } from "../../core/command.js";
import type { Gantry } from "../../core/context.js";
import { conflict, refuse } from "../../core/errors.js";
import { ENROLMENT_LINK_SECONDS, type IdpAdmin } from "../../core/auth/idp-admin.js";
import { holdsFactoryAdmin } from "../../core/auth/mfa.js";
import { revokeSessions } from "../../core/auth/sessions.js";

/**
 * Second-factor administration through Gantry (S-122, S-124). A person gets a FIRST authenticator only from a one-time, short-lived link the
 * identity provider emails to their address (the provider refuses a password-only sign-in and offers no self-service enrolment); after that, adding
 * or replacing one needs the existing factor, or this action: an administrator with `people.manage` (and a fresh two-factor sign-in), who is not the
 * person, with a reason. It removes the person's second factors at the provider, ends their provider and Gantry sessions, and sends a new link.
 */

export interface PersonRow { id: string; name: string; email: string; status: string; idp_subject: string | null }

const nameParts = (name: string): { firstName?: string; lastName?: string } => {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { ...(first ? { firstName: first } : {}), lastName: rest.join(" ") || first || "-" };
};

/** The person's identity-provider user id: the linked subject, else the user with their address, else a new user (no password until the link sets one). */
export async function idpUserFor(idp: IdpAdmin, p: PersonRow): Promise<string> {
  if (p.idp_subject) return p.idp_subject;
  const found = await idp.findUser({ email: p.email.toLowerCase() });
  if (found) return found.id;
  return idp.createUser({ username: p.email.toLowerCase(), email: p.email.toLowerCase(), emailVerified: true, gantryId: p.id, ...nameParts(p.name), requiredActions: [] });
}

/**
 * The reset: People action. Rank first: a Factory Admin's authenticator is reset only by a Factory Admin (the rule setFactoryRole uses for granting or removing
 * Factory Admin), so people.manage held by a custom role is no path to an admin's account. Then the one-time link is sent FIRST: if it cannot be sent nothing
 * is changed (409). Only then are the factors that existed removed, the provider and Gantry sessions ended and the ledger written; if the removal fails
 * after the link went out, the sessions are still ended and the event records what happened.
 */
export async function resetMfa(tx: Tx, g: Gantry, by: string, id: string, reason: string): Promise<CommandResult<{ removed: number; linkValidMinutes: number; linkSent: boolean }>> {
  const idp = g.idpAdmin;
  if (!idp) throw conflict("Gantry is not connected to the identity provider's admin API (the idp_admin_client_secret secret is missing), so an authenticator cannot be reset here.");
  if (id === by) throw refuse("denied", "Ask another administrator to reset your authenticator: a second factor is never reset by the person it protects, so a stolen password cannot do it.");
  const p = (await tx.query<PersonRow>(`select id, name, email, status, idp_subject from people where org_id = $1 and id = $2 for update`, [g.orgId, id])).rows[0];
  if (!p) throw refuse("not_found", "No such person.");
  if (p.status === "deactivated") throw conflict(`${p.name} is deactivated; reactivate them first.`);
  if ((await holdsFactoryAdmin(tx, g.orgId, id)) && !(await holdsFactoryAdmin(tx, g.orgId, by)))
    throw refuse("denied", `Only a Factory Admin can reset a Factory Admin's authenticator: ${p.name} holds a role you could not grant yourself.`, { needs: "factory_admin" });
  let userId: string;
  let held: Array<{ id: string }>;
  try {
    userId = await idpUserFor(idp, p);
    held = await idp.secondFactors(userId);
    await idp.sendEnrolmentLink(userId, { lifespanSec: ENROLMENT_LINK_SECONDS });
  } catch (e) {
    throw conflict(`The one-time enrolment link could not be sent (${e instanceof Error ? e.message : "unknown error"}), so nothing was changed. Fix the mail setup and try again.`);
  }
  let removed = 0;
  let removalError: string | null = null;
  try {
    removed = await idp.resetSecondFactors(userId, held.map((c) => c.id)); // only the factors that existed before the link; also ends the provider sessions
  } catch (e) {
    removalError = e instanceof Error ? e.message : "unknown error";
    await idp.endSessions(userId).catch(() => undefined);
  }
  const ended = await revokeSessions(tx, g.orgId, id, null, by);
  await tx.query(`update people set mfa = false, mfa_types = '{}', mfa_fingerprint = null, mfa_checked_at = now(), mfa_link_at = now(), updated_at = now() where org_id = $1 and id = $2`, [g.orgId, id]);
  const mins = ENROLMENT_LINK_SECONDS / 60;
  return {
    msg: removalError
      ? `The link was emailed to ${p.email} and ${p.name}'s sessions ended, but the identity provider did not remove the old authenticators (${removalError}). Remove them in the provider's console.`
      : `${p.name}'s authenticator was reset and their sessions ended. A one-time link to set up a new one was emailed to ${p.email}; it is valid for ${mins} minutes.`,
    events: [{ type: "people.mfa_reset", category: "access", subject: { type: "person", id }, after: { reason, removed, sessionsEnded: ended.length, linkValidMinutes: mins, linkSent: true, ...(removalError ? { factorRemovalFailed: removalError } : {}) } }],
    extra: { removed, linkValidMinutes: mins, linkSent: true },
    changes: ["people", "sessions"],
    project: null,
  };
}

/** After an invite: create the provider user if there is none and email the first-enrolment link. Best effort; the answer says what happened. Never throws. */
export async function inviteEnrolment(g: Gantry, p: PersonRow): Promise<{ sent: boolean; reason?: string }> {
  const idp = g.idpAdmin;
  if (!idp) return { sent: false, reason: "Gantry is not connected to the identity provider's admin API, so no enrolment link was sent." };
  try {
    const userId = await idpUserFor(idp, p);
    if ((await idp.secondFactors(userId)).length) return { sent: false, reason: "They already have a second factor set up." };
    await idp.sendEnrolmentLink(userId, { lifespanSec: ENROLMENT_LINK_SECONDS });
    await g.pool.query(`update people set mfa_link_at = now() where org_id = $1 and id = $2`, [g.orgId, p.id]).catch(() => undefined);
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: `The enrolment link could not be sent (${e instanceof Error ? e.message : "unknown error"}). Use "Reset authenticator" on their card to send it.` };
  }
}
