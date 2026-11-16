import { z } from "zod";

const id = z.string().min(1).max(100);

export const InviteBody = z.object({
  name: z.string().trim().min(2, "Enter a name.").max(200),
  email: z.string().trim().toLowerCase().max(320).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address."),
  teams: z.array(id).max(50).default([]),
  roles: z.array(z.object({ role: id, scope: id })).max(50).default([]),
  /** Required when the invite carries a factory-level role; recorded in the audit event. */
  reason: z.string().trim().max(2000).optional(),
});

export const TeamsBody = z.object({ teams: z.array(id).max(50) });
const teamName = z.string().trim().min(2, "Enter a team name of at least 2 characters.").max(80);
const teamDesc = z.string().trim().max(300);
export const CreateTeamBody = z.object({
  name: teamName,
  /** Optional explicit id; derived from the name otherwise. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/, "Use lower-case letters, digits and hyphens for the id.").optional(),
  desc: teamDesc.default(""),
});
export const UpdateTeamBody = z.object({ name: teamName.optional(), desc: teamDesc.optional() }).refine((b) => b.name !== undefined || b.desc !== undefined, "Change the name or the description.");
export const OncallBody = z.object({ on: z.boolean() });
export const AwayBody = z.object({
  away: z.object({ from: z.number().finite().optional(), to: z.number().finite(), delegate: id }).nullable(),
  project: id.nullish(),
});

/** Why a factory-level grant changes: recorded on the audit event. Required for factory scope (Wave 3, F7). */
const grantReason = z.string().trim().min(3, "Say why, in a few words.").max(500);
export const TeamGrantBody = z.object({
  role: id,
  /** "factory" or a project id. */
  scope: id,
  /** Epoch ms; the grant lapses then. Omit for no expiry. */
  expiresAt: z.number().int().positive().nullish(),
  /** Required when scope is "factory". */
  reason: grantReason.optional(),
});
export const FactoryRoleBody = z.object({ reason: grantReason });
export const RevokeBody = z.object({ reason: grantReason.optional() }).nullish();

const offboardReason = z.string().trim().min(10, "Give a reason of at least 10 characters.").max(500);
export const DeactivateBody = z.object({
  reason: offboardReason,
  /** Leave the API keys they created live (they are listed in the audit event). The default revokes them. */
  keepKeys: z.boolean().default(false),
});
export const ReactivateBody = z.object({ reason: offboardReason });
