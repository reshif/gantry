import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import type { LauncherConfig } from "./config.js";
import type { LauncherError, RunManager } from "./manager.js";
import { runId, startRunSchema } from "./template.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time bearer check: compares fixed-length digests so neither length nor content leaks through timing. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = header === undefined ? null : /^Bearer (.+)$/.exec(header);
  const presented = m ? (m[1] as string) : "";
  const a = digest(presented);
  const b = digest(token);
  return timingSafeEqual(a, b) && m !== null;
}

const STATUS: Record<LauncherError["kind"], number> = {
  capacity: 429,
  subnet_exhausted: 429,
  image_missing: 503,
  edge_missing: 503,
  conflict: 409,
  teardown_incomplete: 500,
  docker: 502,
};

function refuse(reply: FastifyReply, e: LauncherError) {
  const body: Record<string, unknown> = { ok: false, kind: e.kind, msg: e.msg };
  if (e.kind === "teardown_incomplete") body.stop = e.stop;
  return reply.code(STATUS[e.kind]).send(body);
}

const stopQuery = z.object({ keepWorkspace: z.enum(["true", "false"]).optional() });

export function buildServer(opts: { cfg: LauncherConfig; manager: RunManager; token: string; logger?: boolean }): FastifyInstance {
  const { cfg, manager, token } = opts;
  const app = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization"] },
    bodyLimit: 8 * 1024,
  });
  const startSchema = startRunSchema(cfg);

  // Clients that send `content-type: application/json` with an empty body (a DELETE, say) get an undefined body, not a 400.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      const e = new Error("body is not valid JSON") as Error & { statusCode: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });

  // Everything except /healthz needs the launcher token.
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/healthz") return;
    if (!bearerMatches(req.headers.authorization, token)) {
      return reply.code(401).header("www-authenticate", "Bearer").send({ ok: false, msg: "unauthorized" });
    }
  });

  app.get("/healthz", async (_req, reply) => {
    const up = await manager.ping();
    return reply.code(up ? 200 : 503).send({ ok: up });
  });

  // start-run
  app.post("/v1/runs", async (req, reply) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ ok: false, msg: "invalid request", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), msg: i.message })) });
    }
    const r = await manager.start(parsed.data);
    if (!r.ok) return refuse(reply, r.error);
    return reply.code(r.value.state === "running" ? 200 : 201).send({ ok: true, ...r.value });
  });

  // stop-run. keepWorkspace defaults to true: the volume is only removed when the caller says so (after publishing).
  app.delete<{ Params: { id: string } }>("/v1/runs/:id", async (req, reply) => {
    const id = runId.safeParse(req.params.id);
    const q = stopQuery.safeParse(req.query);
    if (!id.success || !q.success) return reply.code(422).send({ ok: false, msg: "invalid run id or query" });
    const r = await manager.stop(id.data, { keepWorkspace: q.data.keepWorkspace !== "false" });
    if (!r.ok) return refuse(reply, r.error);
    return reply.send({ ok: true, ...r.value });
  });

  // list-runs
  app.get("/v1/runs", async (_req, reply) => {
    const r = await manager.list();
    if (!r.ok) return refuse(reply, r.error);
    return reply.send({ ok: true, ...r.value });
  });

  return app;
}
