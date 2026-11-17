import { gantryError, httpStatusFor, refusalBody, type GantryError, type RuleRef } from "@gantry/domain";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import { noWriteRight, refuseDecision } from "./decide.js";
import { declaredDenial } from "./write-gate.js";
import type { FastifyRequest } from "fastify";

type Kind = GantryError["kind"];

/** Thrown from a handler or command body to stop with a refusal. The error handler maps it to 403/404/409/422 and a `{ok:false,msg,rule?,needs?}` body. */
export class Refusal extends Error {
  constructor(readonly error: GantryError) {
    super(error.msg);
  }
}

export const refuse = (kind: Kind, msg: string, extra: { rule?: RuleRef; needs?: string } = {}): Refusal => new Refusal(gantryError(kind, msg, extra));

export const notFound = (msg: string): Refusal => refuse("not_found", msg);
export const invalid = (msg: string): Refusal => refuse("invalid", msg);
export const conflict = (msg: string): Refusal => refuse("conflict", msg);
export const stale = (msg = "This changed since you loaded it. Reload and try again."): Refusal => refuse("stale", msg);

export const statusFor = (e: GantryError): number => httpStatusFor(e.kind);
export const bodyFor = (e: GantryError): Record<string, unknown> => refusalBody(e) as Record<string, unknown>;

export function sendRefusal(reply: FastifyReply, e: GantryError): FastifyReply {
  return reply.code(statusFor(e)).send(bodyFor(e));
}

const zodMsg = (e: ZodError): string => `Invalid request: ${e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ")}`;

/**
 * Authorisation comes before validation: a body that fails to parse is answered 403, not 422, when the caller may not change anything at all.
 * (Handlers parse first, then reach command()'s decision point, so the check is made here, only on the failure path.) Null when the request
 * is a read, has no principal, or the caller holds some right to write (then the validation message is for them).
 */
async function deniedBeforeValidation(req: FastifyRequest): Promise<Refusal | null> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;
  // A route that declares its rights (core/write-gate.ts) is judged by them; any other write route, by whether the caller may change anything at all.
  const found = (await declaredDenial(req).catch(() => null)) ?? (await noWriteRight(req).catch(() => null));
  const scope = found && "scope" in found ? found.scope : undefined;
  if (!found) return null;
  const { auditDenial } = await import("./command.js");
  await auditDenial(req, { action: found.action, ...(scope ? { scope } : {}) }, found.decision).catch(() => undefined);
  return refuseDecision(found.decision);
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (e: unknown, req, reply) => {
    const fe = e as { statusCode?: number; code?: string; message?: string };
    if (e instanceof Refusal && e.error.kind !== "invalid") return sendRefusal(reply, e.error);
    // A malformed body, a malformed id or any other "invalid" refusal raised before the decision point.
    if (e instanceof Refusal || e instanceof ZodError || fe.statusCode === 400) {
      const denied = await deniedBeforeValidation(req);
      if (denied) return sendRefusal(reply, denied.error);
    }
    if (e instanceof Refusal) return sendRefusal(reply, e.error);
    if (e instanceof ZodError) return reply.code(422).send({ ok: false, msg: zodMsg(e) });
    if (fe.statusCode === 503 && fe.message) return reply.code(503).send({ ok: false, msg: fe.message });
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      const msg = fe.statusCode === 429 ? "Too many requests. Slow down and retry shortly." : fe.statusCode === 413 ? "Request body is too large." : fe.statusCode === 415 ? "Unsupported content type." : "The request could not be read.";
      return reply.code(fe.statusCode === 400 ? 422 : fe.statusCode).send({ ok: false, msg });
    }
    req.log.error({ err: e }, "unhandled error");
    return reply.code(500).send({ ok: false, msg: "Something went wrong on our side.", requestId: req.id });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ ok: false, msg: "No such endpoint." }));
}
