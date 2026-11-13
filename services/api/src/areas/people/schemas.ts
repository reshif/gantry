import { z } from "zod";

const id = z.string().min(1).max(100);

export const InviteBody = z.object({
  name: z.string().trim().min(2, "Enter a name.").max(200),
  email: z.string().trim().toLowerCase().max(320).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address."),
  teams: z.array(id).max(50).default([]),
  roles: z.array(z.object({ role: id, scope: id })).max(50).default([]),
});

export const TeamsBody = z.object({ teams: z.array(id).max(50) });
export const OncallBody = z.object({ on: z.boolean() });
export const AwayBody = z.object({
  away: z.object({ from: z.number().finite().optional(), to: z.number().finite(), delegate: id }).nullable(),
  project: id.nullish(),
});
