import type { Decision } from "@gantry/domain";
import type { FastifyRequest } from "fastify";
import { auditDenial } from "../../core/command.js";
import { refuseDecision } from "../../core/decide.js";

/**
 * Defence in depth (spec 5.3): the run-scoped internal endpoints (authorize, usage, heartbeat, checkpoint, result, spec, egress, mcp-authorize) and
 * the vendor-key read exist for the edge. The GitHub broker's service token is also mounted in the worker, so it must not be able to call them even
 * with a valid run token. Any other caller is refused with 403 and the refusal is audited (`<action>.denied`).
 */
export async function requireEdge(req: FastifyRequest, action: string): Promise<void> {
  const p = req.gx.principal;
  if (p?.kind === "service" && p.id === "edge") return;
  const d: Decision = { allowed: false, reason: "Only the edge service may call this endpoint.", rule: { kind: "invariant", id: "EDGE-ONLY", name: "Edge service only" }, needs: "" };
  await auditDenial(req, { action }, d).catch((err: unknown) => req.log.error({ err }, "could not audit denial"));
  throw refuseDecision(d);
}
