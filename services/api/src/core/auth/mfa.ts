import type { Queryable } from "@gantry/db";

export const MFA_REQUIRED_MSG = "Factory Admins sign in with two steps. Set up two-step sign-in (an authenticator app) at your identity provider, then sign in again.";

/** Whether the person holds Factory Admin now, directly or through a team (live, unexpired grants only). */
export async function holdsFactoryAdmin(db: Queryable, orgId: string, personId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `select 1 from effective_role_assignments where org_id = $1 and person_id = $2 and role_id = 'factory_admin' and scope_type = 'factory'
       and revoked_at is null and (expires_at is null or expires_at > now()) limit 1`,
    [orgId, personId],
  );
  return (rowCount ?? 0) > 0;
}

/** The 401 body for a Factory Admin whose session lacks a second factor. `needs` lets the client show the guided screen. */
export const mfaRefusal = { ok: false as const, msg: MFA_REQUIRED_MSG, needs: "mfa_setup" as const, rule: { kind: "invariant" as const, id: "ADMIN-MFA", name: "Second sign-in factor for Factory Admins" } };

