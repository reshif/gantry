import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import type { ApiClient } from "./api.js";
import type { GithubConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import type { GithubApp } from "./github.js";
import { DraftBody, GateCheckBody, MergeBody, Poller, convertToDraft, listDeliveries, mergePullRequest, readPrState, readProtections, reconcileDeliveries, reconcileRepo, setGateCheck, type OpDeps } from "./ops.js";
import { PublishBody, publishWorkspace } from "./publish.js";
import { SeedBody, seedWorkspace, type SeedDeps } from "./seed.js";
import type { WorkspaceStore } from "./workspace.js";

export interface ServerDeps {
  cfg: GithubConfig;
  app: GithubApp;
  api: ApiClient;
  store: WorkspaceStore;
  /** Test seams for the clone source. */
  cloneUrl?: SeedDeps["cloneUrl"];
  gitConfig?: string[];
  logger?: boolean;
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const Repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

export async function buildServer(d: ServerDeps): Promise<{ server: FastifyInstance; poller: Poller; ops: OpDeps }> {
  const server = Fastify({ logger: d.logger === false ? false : { level: "info", redact: ["req.headers.authorization"] }, bodyLimit: 1024 * 1024 });
  const ops: OpDeps = { cfg: d.cfg, app: d.app, api: d.api, appId: d.cfg.app.appId };
  const poller = new Poller(ops, d.cfg.pollIntervalMs, server.log);

  server.setErrorHandler((e, _req, reply) => {
    if (e instanceof BrokerError) return reply.code(e.status).send({ ok: false, msg: e.message, code: e.code, ...e.extra });
    if (e instanceof ZodError) return reply.code(422).send({ ok: false, msg: "Invalid request.", issues: e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) });
    const status = (e as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) return reply.code(status).send({ ok: false, msg: String((e as Error).message) });
    server.log.error({ err: { message: (e as Error).message, name: (e as Error).name } }, "unhandled error");
    return reply.code(500).send({ ok: false, msg: "Something went wrong in the GitHub broker." });
  });

  server.addHook("onRequest", async (req, reply) => {
    if (req.url === "/healthz") return;
    const h = req.headers.authorization ?? "";
    if (!h.startsWith("Bearer ") || !safeEqual(h.slice(7), d.cfg.githubToken)) return reply.code(401).send({ ok: false, msg: "A service token is required." });
  });

  server.get("/healthz", async () => ({ ok: true, poll: poller.lastRun }));

  server.post("/v1/workspaces/seed", async (req) =>
    seedWorkspace({ cfg: d.cfg, app: d.app, store: d.store, apiBase: d.cfg.app.baseUrl, ...(d.cloneUrl ? { cloneUrl: d.cloneUrl } : {}), ...(d.gitConfig ? { gitConfig: d.gitConfig } : {}) }, SeedBody.parse(req.body)));
  server.post("/v1/publish", async (req) => publishWorkspace({ cfg: d.cfg, app: d.app, api: d.api, store: d.store }, PublishBody.parse(req.body)));
  server.post("/v1/checks/gate", async (req) => setGateCheck(ops, GateCheckBody.parse(req.body)));
  server.get("/v1/pull-state", async (req) => {
    const q = z.object({ repo: Repo, number: z.coerce.number().int().positive() }).parse(req.query);
    return { ok: true, ...(await readPrState(ops, q.repo, q.number)) };
  });
  server.post("/v1/pulls/draft", async (req) => convertToDraft(ops, DraftBody.parse(req.body)));
  server.post("/v1/pulls/merge", async (req) => mergePullRequest(ops, MergeBody.parse(req.body)));
  server.get("/v1/protections", async (req) => ({ ok: true, ...(await readProtections(ops, z.object({ repo: Repo }).parse(req.query).repo)) }));
  server.get("/v1/deliveries", async (req) => ({ ok: true, deliveries: await listDeliveries(ops, z.coerce.number().int().min(1).max(100).default(50).parse((req.query as { limit?: string }).limit)) }));
  server.post("/v1/deliveries/reconcile", async () => ({ ok: true, ...(await reconcileDeliveries(ops)) }));
  // The `github.reconcile` job: one pass for one repository (the worker passes the repository's full name).
  server.post("/v1/reconcile", async (req) => {
    const b = z.object({ repo: Repo, branchPrefix: z.string().min(1).max(100).default("gantry/") }).strict().parse(req.body);
    return { ok: true, ...(await reconcileRepo(ops, { repo: b.repo, branchPrefix: b.branchPrefix })) };
  });

  return { server, poller, ops };
}
