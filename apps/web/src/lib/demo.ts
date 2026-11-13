/**
 * Demo accounts for the sign-in screen. Shown only when the API says demoAccounts is on
 * (GANTRY_DEV_DEMO_ACCOUNTS, backed by seeded Keycloak users). The server may send its own list in
 * `config.demoAccountList`; this is the fallback matching the dev seed (email = id without "p-" + @acme.dev).
 */
import type { DemoAccount } from "../api/types";

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { id: "p-asha", name: "Asha Raman", email: "asha@acme.dev", role: "Factory Admin", note: "Sees and controls everything. MFA step." },
  { id: "p-daniel", name: "Daniel Okafor", email: "daniel@acme.dev", role: "Project Admin", note: "Payments Platform and Storefront. MFA step." },
  { id: "p-meera", name: "Meera Iyer", email: "meera@acme.dev", role: "Line Lead", note: "Payments Platform. Away; Priya is her delegate." },
  { id: "p-tomas", name: "Tomás Ferreira", email: "tomas@acme.dev", role: "Engineer", note: "Payments Platform only." },
  { id: "p-fatima", name: "Fatima Zahra", email: "fatima@acme.dev", role: "Reviewer", note: "Storefront (also Engineer there)." },
  { id: "p-kenji", name: "Kenji Watanabe", email: "kenji@acme.dev", role: "Release Manager", note: "Payments, Storefront, Risk." },
  { id: "p-sam", name: "Sam Whitfield", email: "sam@acme.dev", role: "Auditor", note: "Read-only across the factory." },
  { id: "p-priya", name: "Priya Nair", email: "priya@acme.dev", role: "Two teams, two roles", note: "Reviewer on Payments, Line Lead on Risk." },
  { id: "p-lena", name: "Lena Fischer", email: "lena@acme.dev", role: "Project Admin, on call", note: "Identity (new project). MFA step." },
  { id: "p-omar", name: "Omar Haddad", email: "omar@acme.dev", role: "Factory Admin (second)", note: "Second approver for a factory restore. MFA step." },
];
