/**
 * The demo sign-in list (development only, GANTRY_DEV_DEMO_ACCOUNTS). The accounts are the users of the local identity provider
 * (deploy/keycloak/realm-gantry.json); what each can do is NOT a fixed description but computed from the org's real role grants.
 *
 * Rule, per demo user:
 *   - a person with that email exists and may sign in: show their actual roles (own grants, then team grants "via <team>");
 *   - an invited person: shown, "Invited; becomes active at first sign-in" plus the roles they will get;
 *   - deactivated or suspended people: hidden (sign-in is refused);
 *   - no person yet: shown as "No roles yet" (a first sign-in creates an account with no access, spec 8.9), except the configured
 *     bootstrap admin email, which becomes Factory Admin on its first sign-in.
 * There is no second factor in the local identity provider, so nothing here says "MFA"; sensitive actions ask for a fresh sign-in (step-up).
 */
import { STEP_UP_ACTIONS, type Catalog, type Matrix, type Person, type PolicyState } from "@gantry/domain";

export interface DemoLogin {
  email: string;
  name: string;
}

/** The users of the local Keycloak realm (email = id without "p-" + "@acme.dev"). */
export const DEMO_LOGINS: readonly DemoLogin[] = [
  ["asha", "Asha Raman"], ["daniel", "Daniel Okafor"], ["meera", "Meera Iyer"], ["tomas", "Tomás Ferreira"], ["priya", "Priya Nair"],
  ["kenji", "Kenji Watanabe"], ["sam", "Sam Whitfield"], ["lena", "Lena Fischer"], ["chloe", "Chloe Martin"], ["arjun", "Arjun Mehta"],
  ["fatima", "Fatima Zahra"], ["nikhil", "Nikhil Rao"], ["grace", "Grace Liu"], ["rui", "Rui Costa"], ["omar", "Omar Haddad"],
].map(([id, name]) => ({ email: `${id}@acme.dev`, name: name! }));

export interface DemoAccountOut {
  id: string;
  name: string;
  email: string;
  role: string;
  note: string;
}

type State = Pick<PolicyState, "people" | "projects" | "teams" | "matrix"> & { catalog: Pick<Catalog, "roles"> };

/** "Engineer on Payments Platform, Storefront; Auditor (via Compliance)". */
export function summariseRoles(p: Person, st: State): string {
  const roleName = (id: string): string => st.catalog.roles.find((r) => r.id === id)?.name ?? id;
  const where = (scope: string): string => (st.projects.find((x) => x.id === scope)?.name ?? scope);
  const groups = new Map<string, { role: string; via: string | null; scopes: string[] }>();
  for (const g of p.roles) {
    const k = `${g.role}|${g.via ?? ""}`;
    const e = groups.get(k) ?? { role: g.role, via: g.via ?? null, scopes: [] };
    if (!e.scopes.includes(g.scope)) e.scopes.push(g.scope);
    groups.set(k, e);
  }
  return [...groups.values()]
    .map((e) => {
      const only = e.scopes.length === 1 && e.scopes[0] === "factory";
      // Concise: up to three project names, otherwise a count ("Release Manager on 8 projects").
      const names = e.scopes.filter((x) => x !== "factory");
      const proj = names.length > 3 ? [`${names.length} projects`] : names.map(where);
      const on = only ? "" : " on " + [...(e.scopes.includes("factory") ? ["the factory"] : []), ...proj].join(", ");
      const via = e.via ? ` (via ${st.teams?.find((t) => t.id === e.via)?.name ?? e.via})` : "";
      return `${roleName(e.role)}${on}${via}`;
    })
    .join("; ");
}

const needsFreshSignIn = (p: Person, matrix: Matrix): boolean => p.roles.some((g) => STEP_UP_ACTIONS.some((a) => matrix[g.role]?.[a]));

export function demoAccountList(st: State, opts: { bootstrapEmail?: string | null; logins?: readonly DemoLogin[] } = {}): DemoAccountOut[] {
  const out: DemoAccountOut[] = [];
  const boot = opts.bootstrapEmail?.toLowerCase() ?? null;
  for (const d of opts.logins ?? DEMO_LOGINS) {
    const p = st.people.find((x) => x.email.toLowerCase() === d.email);
    if (!p) {
      const admin = boot === d.email;
      out.push({ id: `p-${d.email.split("@")[0]}`, name: d.name, email: d.email, role: admin ? "Factory Admin (first sign-in)" : "No roles yet", note: admin ? "The configured bootstrap admin: the first sign-in creates the account and makes it Factory Admin." : "Not in the organisation yet. A first sign-in creates an account with no access until an admin grants roles." });
      continue;
    }
    if (p.status === "deactivated" || p.status === "suspended") continue;
    const roles = summariseRoles(p, st);
    const notes: string[] = [];
    if (p.status === "invited") notes.push("Invited; becomes active at first sign-in.");
    if (!roles) notes.push("Nothing granted yet: sign-in works but most screens will refuse until an admin grants roles in People & teams.");
    const teams = p.teams.map((id) => st.teams?.find((t) => t.id === id)?.name ?? id);
    if (teams.length) notes.push(`Teams: ${teams.join(", ")}.`);
    if (p.oncall) notes.push("On call.");
    if (p.away) notes.push(`Away; ${st.people.find((x) => x.id === p.away!.delegate)?.name ?? p.away.delegate} is the delegate.`);
    if (needsFreshSignIn(p, st.matrix)) notes.push("Sensitive actions ask for a fresh sign-in.");
    out.push({ id: p.id, name: p.name, email: p.email, role: roles || "No roles yet", note: notes.join(" ") });
  }
  return out;
}
