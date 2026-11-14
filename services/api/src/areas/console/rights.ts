/**
 * What the console may do for a person (spec 12.6, 14.3). Replaces the old factory-wide "Console actions" switch: access is default deny and
 * per person, through console rights in the role matrix (direct or via a team). Factory Admin holds all of them, always.
 *   console.use                  ask and read (read tools still filter by the person's own read rights)
 *   console.propose.<kind>       the console may offer a confirm card of that kind to this person
 * A confirmed card still needs the underlying right (wo.submit on the project, kill.* with step-up ...): two layers.
 */
import { CONSOLE_PROPOSALS, CONSOLE_USE, can } from "@gantry/domain";
import type { FastifyRequest } from "fastify";
import { policyState, type PolicyStateLoaded } from "../../core/index.js";

export interface ConsoleRight { id: string; name: string; allowed: boolean; reason: string; needs: string }
export interface ConsoleProposalRight extends ConsoleRight { kind: string; tool: string; does: string }
export interface ConsoleRights { use: ConsoleRight; proposals: ConsoleProposalRight[]; admin: boolean }

export const rightsFrom = (st: PolicyStateLoaded, personId: string): ConsoleRights => {
  const name = (id: string): string => st.catalog.actions.find((a) => a.id === id)?.name ?? id;
  const one = (id: string): ConsoleRight => {
    const d = can(st, personId, id, {});
    return { id, name: name(id), allowed: d.allowed, reason: d.reason, needs: d.allowed ? "" : `Ask a Factory Admin to give you '${name(id)}'.` };
  };
  const me = st.people.find((p) => p.id === personId);
  return {
    use: one(CONSOLE_USE),
    proposals: CONSOLE_PROPOSALS.map((c) => ({ ...one(c.id), kind: c.kind, tool: c.tool, does: c.does })),
    admin: !!me?.roles.some((g) => g.role === "factory_admin" && g.scope === "factory"),
  };
};

export const consoleRights = async (req: FastifyRequest, personId: string): Promise<ConsoleRights> => rightsFrom(await policyState(req), personId);

/** The propose tools this person may be offered. */
export const allowedTools = (r: ConsoleRights): ReadonlySet<string> => new Set(r.proposals.filter((p) => r.use.allowed && p.allowed).map((p) => p.tool));

/** Plain words for the model and the person when something cannot be proposed. */
export const missingRightText = (r: ConsoleRights, tool: string): string => {
  if (!r.use.allowed) return `The console is not available to this person: ${r.use.needs}`;
  const p = r.proposals.find((x) => x.tool === tool);
  return p ? `The console may not propose to ${p.does} for this person. It needs the right '${p.name}'. Tell them: ask a Factory Admin to give you '${p.name}' (Govern > Access), or do it on the screen if they already may.` : "No such action.";
};
