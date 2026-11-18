import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import type { ApiClient } from "./api.js";
import type { GithubConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import type { GithubApp } from "./github.js";
import { DescribeBody, DraftBody, GateCheckBody, MergeBody, Poller, convertToDraft, describePullRequest, listDeliveries, mergePullRequest, readPrState, readProtections, reconcileDeliveries, reconcileRepo, setGateCheck, type OpDeps } from "./ops.js";
import { CanaryBody, FileBody, InspectBody, OnboardMergeBody, PrBody, inspectRepo, listAvailable, mergeOnboardingPr, openOnboardingPr, readRepoFile, runCanary } from "./onboarding.js";
import { PublishBody, publishWorkspace } from "./publish.js";
import { SeedBody, seedWorkspace, type SeedDeps } from "./seed.js";
import type { WorkspaceStore } from "./workspace.js";

export interface ServerDeps {
  cfg: GithubConfig;
  /** Null when the GitHub App is not configured. */
  app: GithubApp | null;
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

const Repo = z.string().regex(/^(?!\.{1,2}\/)(?!.*\/\.{1,2}$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

export async function buildServer(d: ServerDeps): Promise<{ server: FastifyInstance; poller: Poller; ops: OpDeps }> {
  const server = Fastify({ logger: d.logger === false ? false : { level: "info", redact: ["req.headers.authorization"] }, bodyLimit: 1024 * 1024 });
  // Routes only run when configured (the hook below answers 503 otherwise), so these casts are never reached unconfigured.
  const app = d.app as GithubApp, appCfg = d.cfg.app as NonNullable<GithubConfig["app"]>;
  const configured = d.app !== null && d.cfg.app !== null;
  const ops: OpDeps = { cfg: d.cfg, app, api: d.api, appId: configured ? appCfg.appId : 0 };
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

  server.addHook("preHandler", async (req, reply) => {
    if (!configured && req.url.startsWith("/v1/")) return reply.code(503).send({ ok: false, code: "not_configured", msg: "GitHub App is not configured. Add the App ID and key in Integrations or deploy/secrets." });
  });

  server.get("/healthz", async () => configured
    ? { ok: true, configured: true, poll: poller.lastRun }
    : { ok: true, configured: false, reason: d.cfg.notConfiguredReason ?? "GitHub App is not configured" });

  server.post("/v1/workspaces/seed", async (req) =>
    seedWorkspace({ cfg: d.cfg, app, store: d.store, apiBase: appCfg.baseUrl, ...(d.cloneUrl ? { cloneUrl: d.cloneUrl } : {}), ...(d.gitConfig ? { gitConfig: d.gitConfig } : {}) }, SeedBody.parse(req.body)));
  server.post("/v1/publish", async (req) => publishWorkspace({ cfg: d.cfg, app, api: d.api, store: d.store }, PublishBody.parse(req.body)));
  server.post("/v1/checks/gate", async (req) => setGateCheck(ops, GateCheckBody.parse(req.body)));
  server.get("/v1/pull-state", async (req) => {
    const q = z.object({ repo: Repo, number: z.coerce.number().int().positive() }).parse(req.query);
    return { ok: true, ...(await readPrState(ops, q.repo, q.number)) };
  });
  server.post("/v1/pulls/draft", async (req) => convertToDraft(ops, DraftBody.parse(req.body)));
  server.post("/v1/pulls/describe", async (req) => describePullRequest(ops, DescribeBody.parse(req.body)));
  server.post("/v1/pulls/merge", async (req) => mergePullRequest(ops, MergeBody.parse(req.body)));
  // Repository onboarding and readiness (spec 11.3).
  server.post("/v1/onboarding/inspect", async (req) => { const b = InspectBody.parse(req.body); return inspectRepo(ops, b.repo, { scan: b.scan }); });
  server.post("/v1/onboarding/file", async (req) => readRepoFile(ops, FileBody.parse(req.body)));
  server.post("/v1/onboarding/pr", async (req) => openOnboardingPr(ops, PrBody.parse(req.body)));
  server.post("/v1/onboarding/merge", async (req) => mergeOnboardingPr(ops, OnboardMergeBody.parse(req.body)));
  server.post("/v1/onboarding/canary", async (req) => runCanary(ops, CanaryBody.parse(req.body)));
  server.get("/v1/installation/repos", async () => ({ ok: true, repos: await listAvailable(ops) }));
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
