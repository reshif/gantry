import { visibleProjects } from "@gantry/domain";
import type { FastifyRequest } from "fastify";
import { policyState, refuse } from "../../core/index.js";

/** The projects the signed-in person can see: `"all"` for a factory-wide role. Keys, triggers and the request log are for people; a key reaches only the public API. */
export async function visibleToPerson(req: FastifyRequest): Promise<"all" | string[]> {
  const p = req.gx.principal;
  if (p?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
  const st = await policyState(req);
  const person = st.people.find((x) => x.id === p.id);
  if (person?.roles.some((r) => r.scope === "factory")) return "all";
  return visibleProjects(st, p.id).map((x) => x.id);
}
