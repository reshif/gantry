/**
 * Demo accounts for the sign-in screen. Shown only when the API says demoAccounts is on (GANTRY_DEV_SEED on a local stack, backed by the
 * local identity provider's users). The server sends `config.demoAccountList`, built from the live org: each account's roles are what
 * that person actually holds (own grants and team grants), or "No roles yet".
 *
 * This fallback is used only when the server sends no list. It names the identity provider's users (email = id without "p-" + @acme.dev)
 * and claims nothing about their permissions, because those depend on what has been granted in People & teams.
 */
import type { DemoAccount } from "../api/types.js";

const USERS: ReadonlyArray<readonly [string, string]> = [
  ["asha", "Asha Raman"], ["daniel", "Daniel Okafor"], ["meera", "Meera Iyer"], ["tomas", "Tomás Ferreira"], ["priya", "Priya Nair"],
  ["kenji", "Kenji Watanabe"], ["sam", "Sam Whitfield"], ["lena", "Lena Fischer"], ["chloe", "Chloe Martin"], ["arjun", "Arjun Mehta"],
  ["fatima", "Fatima Zahra"], ["nikhil", "Nikhil Rao"], ["grace", "Grace Liu"], ["rui", "Rui Costa"], ["omar", "Omar Haddad"],
];

export const DEMO_ACCOUNTS: readonly DemoAccount[] = USERS.map(([id, name]) => ({
  id: `p-${id}`,
  name,
  email: `${id}@acme.dev`,
  role: "Demo account",
  note: "Access is whatever has been granted in People & teams; it is listed after sign-in.",
}));
