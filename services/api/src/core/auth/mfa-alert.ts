import { appendEvent, enqueueOutbox, type Tx } from "@gantry/db";

/**
 * A second-factor change nobody asked Gantry for (G-M1, G-M2): written to the ledger as `auth.mfa_changed_outside` and emailed to every Factory Admin, so a
 * planted or swapped authenticator is seen by a person. Never refuses anything: it is a detective control. The email rides the outbox like every other mail.
 */
export async function recordMfaChangedOutside(
  tx: Tx, orgId: string, personId: string | null,
  d: { /** false: ledger only (the caller sends one digest mail for the poll) */ mail?: boolean; why: "credentials_changed" | "first_seen_without_enrolment" | "provider_admin_event" | "events_incomplete"; detail: Record<string, unknown>; requestId?: string; sourceIp?: string | null },
): Promise<string> {
  const label = personId ? `person ${personId}` : "an account at the identity provider";
  const ev = await appendEvent(tx, {
    orgId, type: "auth.mfa_changed_outside", category: "auth", actor: "system", channel: "system", subject: personId ? { type: "person", id: personId } : { type: "identity", id: "unknown" },
    after: { why: d.why, ...d.detail, note: "A second factor or password changed at the identity provider outside Gantry's own enrolment links and resets. Check with the person; reset the authenticator in People if it was not them." },
    ...(d.requestId ? { requestId: d.requestId } : {}), sourceIp: d.sourceIp ?? null,
  });
  if (d.mail !== false) await mailFactoryAdmins(tx, orgId, ev.id, "Gantry: a second factor changed outside Gantry", `A second factor or password for ${label} changed at the identity provider without going through Gantry (${d.why}).\n\nOpen the audit ledger, event auth.mfa_changed_outside, to see what changed. If this was not expected, reset that person's authenticator in People and check the provider's admin events.`);
  return ev.id;
}

/** One email to every active Factory Admin (never the bootstrap placeholder address), through the outbox. */
export async function mailFactoryAdmins(tx: Tx, orgId: string, eventId: string, subject: string, text: string): Promise<void> {
  const to = (await tx.query<{ email: string }>(
    `select distinct p.email from effective_role_assignments e join people p on p.org_id = e.org_id and p.id = e.person_id
      where e.org_id = $1 and e.role_id = 'factory_admin' and e.scope_type = 'factory' and e.revoked_at is null and (e.expires_at is null or e.expires_at > now()) and p.status = 'active' and p.email not like '%@bootstrap.invalid'`, [orgId])).rows.map((r) => r.email);
  if (!to.length) return;
  await enqueueOutbox(tx, { orgId, eventId, destination: "smtp", payload: { to, subject, text } });
}

/** A watcher notice that is not a factor change (the provider's events cannot be read, or can be again): ledger and one mail to the Factory Admins. */
export async function recordWatchNotice(tx: Tx, orgId: string, type: "auth.mfa_watch_unreadable" | "auth.mfa_watch_recovered", text: string, detail: Record<string, unknown>): Promise<void> {
  const ev = await appendEvent(tx, { orgId, type, category: "auth", actor: "system", channel: "system", subject: { type: "identity", id: "idp-watch" }, after: { ...detail, note: text } });
  await mailFactoryAdmins(tx, orgId, ev.id, type === "auth.mfa_watch_unreadable" ? "Gantry: second-factor change monitoring is blind" : "Gantry: second-factor change monitoring recovered", text);
}
