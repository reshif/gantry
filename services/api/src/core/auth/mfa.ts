import type { Queryable } from "@gantry/db";

/** MFA is required for everyone (S-121). The only way to a first authenticator is the one-time link an administrator issues; a password alone never offers it (S-122). */
export const MFA_REQUIRED_MSG = "Everyone signs in with two steps: your password and a second factor (an authenticator app, a security key or a recovery code). This sign-in had no second factor. Use the one-time enrolment link you were emailed to set up two-step sign-in, or ask an administrator to send you one, then sign in again.";

/** Whether the person holds Factory Admin now, directly or through a team (live, unexpired grants only). */
export async function holdsFactoryAdmin(db: Queryable, orgId: string, personId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `select 1 from effective_role_assignments where org_id = $1 and person_id = $2 and role_id = 'factory_admin' and scope_type = 'factory'
       and revoked_at is null and (expires_at is null or expires_at > now()) limit 1`,
    [orgId, personId],
  );
  return (rowCount ?? 0) > 0;
}

/** The 401 body for a session that lacks a second factor (any person). `needs` lets the client show the guided screen. */
export const mfaRefusal = { ok: false as const, msg: MFA_REQUIRED_MSG, needs: "mfa_setup" as const, rule: { kind: "invariant" as const, id: "MFA", name: "Second sign-in factor for everyone" } };


/** The MFA policy the server enforces, shown on the Security page (S-127). Not stored and not editable: a second factor is required of every person. */
export function mfaPolicy(waived: boolean): { policy: "everyone"; required: true; waived: boolean; methods: string[] } {
  return { policy: "everyone", required: true, waived, methods: ["totp", "webauthn", "recovery"] };
}
