import { appendEvent, enqueueOutbox, type Tx } from "@gantry/db";

/**
 * A second-factor change nobody asked Gantry for (G-M1, G-M2): written to the ledger as `auth.mfa_changed_outside` and emailed to every Factory Admin, so a
 * planted or swapped authenticator is seen by a person. Never refuses anything: it is a detective control. The email rides the outbox like every other mail.
 */
export async function recordMfaChangedOutside(
  tx: Tx, orgId: string, personId: string | null,
  d: { why: "credentials_changed" | "first_seen_without_enrolment" | "provider_admin_event" | "events_incomplete"; detail: Record<string, unknown>; requestId?: string; sourceIp?: string | null },
): Promise<void> {
  const label = personId ? `person ${personId}` : "an account at the identity provider";
  const ev = await appendEvent(tx, {
    orgId, type: "auth.mfa_changed_outside", category: "auth", actor: "system", channel: "system", subject: personId ? { type: "person", id: personId } : { type: "identity", id: "unknown" },
    after: { why: d.why, ...d.detail, note: "A second factor or password changed at the identity provider outside Gantry's own enrolment links and resets. Check with the person; reset the authenticator in People if it was not them." },
    ...(d.requestId ? { requestId: d.requestId } : {}), sourceIp: d.sourceIp ?? null,
  });
  const to = (await tx.query<{ email: string }>(
    `select distinct p.email from effective_role_assignments e join people p on p.org_id = e.org_id and p.id = e.person_id
      where e.org_id = $1 and e.role_id = 'factory_admin' and e.scope_type = 'factory' and e.revoked_at is null and (e.expires_at is null or e.expires_at > now()) and p.status = 'active' and p.email not like '%@bootstrap.invalid'`, [orgId])).rows.map((r) => r.email);
  if (!to.length) return;
  await enqueueOutbox(tx, {
    orgId, eventId: ev.id, destination: "smtp",
    payload: { to, subject: "Gantry: a second factor changed outside Gantry", text: `A second factor or password for ${label} changed at the identity provider without going through Gantry (${d.why}).\n\nOpen the audit ledger, event auth.mfa_changed_outside, to see what changed. If this was not expected, reset that person's authenticator in People and check the provider's admin events.` },
  });
}
