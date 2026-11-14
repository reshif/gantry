/**
 * Repository onboarding (spec 8.6, 11.3). Owns:
 *   GET /api/v1/projects/{id}/repos, GET /api/v1/projects/{id}/repos/available, POST /api/v1/projects/{id}/repos, PATCH /api/v1/repos/{id}/config
 *   POST /api/v1/repos/{id}/onboarding/{assess|open-pr|merge|request-changes|exception|verify}
 *   GET/PUT /api/v1/guidelines, PUT /api/v1/projects/{id}/guidelines
 *   POST /internal/v1/onboarding/fence (the GitHub broker's check before it writes to a repository)
 *
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4): the decision point, the audit of success and denial, state and event in one
 * transaction, idempotent creates and the refusal in a stopped scope. What needs GitHub is a job for the worker (areas/onboarding/apply.ts is what those jobs do to the state).
 */
import { visibleProjects } from "@gantry/domain";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { fenceOnboarding } from "../areas/onboarding/fence.js";
import { OrgBody, ProjectBody, readOrgGuidelines, readProjectGuidelines, saveOrgGuidelines, saveProjectGuidelines } from "../areas/onboarding/guidelines.js";
import { configureRepo, connectRepo, markException, mergeOnboardingPr, openOnboardingPr, rerunAssessment, requestChanges, verifyNow } from "../areas/onboarding/commands.js";
import { ChangesBody, ConfigBody, ConnectBody, EmptyBody, ExceptionBody } from "../areas/onboarding/schemas.js";
import { readRepoRow } from "../areas/onboarding/state.js";
import { command, decide, policyState, readRepos, refuse, refuseDecision, type CommandResult } from "../core/index.js";

const Id = z.object({ id: z.string().min(1).max(100) });
const FenceBody = z.object({ repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200), purpose: z.enum(["write", "merge", "canary"]) }).strict();

const requirePerson = (req: FastifyRequest): string => {
  const p = req.gx.principal;
  if (p?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
  return p.id;
};

export const onboardingRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;

  /** The project, if the viewer may see it. A project the viewer cannot see does not exist for them. */
  async function visibleProject(req: FastifyRequest, id: string): Promise<void> {
    const who = requirePerson(req);
    const st = await policyState(req);
    if (!visibleProjects(st, who).some((x) => x.id === id)) throw refuse("not_found", "No such project.");
  }

  /** The repo a command is about, with its project, for the viewer who may see that project. */
  async function repoOf(req: FastifyRequest, idOrName: string) {
    const who = requirePerson(req);
    const row = await readRepoRow(g.pool, g.orgId, idOrName);
    if (!row) throw refuse("not_found", "No such repo.");
    const st = await policyState(req);
    if (!visibleProjects(st, who).some((x) => x.id === row.project_id)) throw refuse("not_found", "No such repo.");
    return row;
  }

  /** The repositories of a project, in the legacy Repo shape (onboarding stage, halt). The Floor reads it to find a Ready repo for a new work order. */
  app.get("/api/v1/projects/:id/repos", async (req) => {
    const { id } = Id.parse(req.params);
    await visibleProject(req, id);
    const st = await policyState(req);
    return (await readRepos(g.pool, g.orgId, st.activeStops)).filter((r) => r.project === id);
  });

  /** Repositories the GitHub App can see and that are not connected yet, for the connect wizard. `available: null` when GitHub cannot be asked (no broker, no keys). */
  app.get("/api/v1/projects/:id/repos/available", async (req) => {
    const { id } = Id.parse(req.params);
    await visibleProject(req, id);
    const d = await decide(req, "repo.onboard", { project: id });
    if (!d.allowed) throw refuseDecision(d);
    const base = g.config.brokerUrl;
    if (!base) return { available: null, unavailable: "GitHub is not configured for this install." };
    try {
      const res = await fetch(`${base}/v1/installation/repos`, { headers: { authorization: `Bearer ${g.config.secrets.githubToken}` }, signal: AbortSignal.timeout(20_000) });
      const body = (await res.json().catch(() => ({}))) as { repos?: Array<{ repo: string; language: string | null; archived: boolean }>; msg?: string };
      if (!res.ok || !Array.isArray(body.repos)) return { available: null, unavailable: body.msg ?? `GitHub answered ${res.status}.` };
      const have = new Set((await g.pool.query<{ n: string }>(`select lower(coalesce(github_full_name, name)) as n from repos where org_id = $1`, [g.orgId])).rows.map((r) => r.n));
      const list = body.repos.filter((r) => !have.has(r.repo.toLowerCase()) && !r.archived).map((r) => ({ repo: r.repo, lang: r.language ?? "Unknown" }));
      return { available: list, hidden: body.repos.length - list.length };
    } catch (e) {
      return { available: null, unavailable: `The GitHub broker did not answer: ${(e as Error).message}` };
    }
  });

  /** The files of the repo's onboarding pull request with the lines each adds, for the pull request tab (the repo list carries only the counts). */
  app.get("/api/v1/repos/:id/onboarding/pr", async (req) => {
    const { id } = Id.parse(req.params);
    const repo = await repoOf(req, id);
    const row = (await g.pool.query<{ number: number; title: string; branch: string; url: string | null; head_sha: string | null; files: unknown; state: string }>(
      `select number, title, branch, url, head_sha, files, state from onboarding_prs where org_id = $1 and repo_id = $2 order by created_at desc, id desc limit 1`, [g.orgId, repo.id],
    )).rows[0];
    return row ? { number: row.number, title: row.title, branch: row.branch, url: row.url, headSha: row.head_sha, state: row.state, files: row.files } : { number: null, files: [] };
  });

  app.post("/api/v1/projects/:id/repos", async (req) => {
    const { id } = Id.parse(req.params);
    const body = ConnectBody.parse(req.body);
    return command(req, { action: "repo.onboard", scope: { project: id }, idempotent: true }, (tx, a) => connectRepo(tx, a, id, body));
  });

  /** Runs a repo command in the repo's own scope: the decision point sees its project and the repo's halt. */
  const repoVersion = (repoId: string) => async (tx: import("@gantry/db").Tx): Promise<number | null> =>
    (await tx.query<{ version: number }>(`select version from repos where org_id = $1 and id = $2`, [g.orgId, repoId])).rows[0]?.version ?? null;
  const onRepo = <X extends object>(action: string, fn: (tx: import("@gantry/db").Tx, a: import("../core/index.js").Actor, repoId: string) => Promise<CommandResult<X>>, o: { versionRequired?: boolean } = {}) =>
    async (req: FastifyRequest) => {
      const { id } = Id.parse(req.params);
      const repo = await repoOf(req, id);
      return command(req, { action, scope: { project: repo.project_id, repo: repo.id }, ifMatch: repoVersion(repo.id), ...(o.versionRequired ? { ifMatchRequired: true } : {}) }, (tx, a) => fn(tx, a, repo.id));
    };

  app.patch("/api/v1/repos/:id/config", async (req) => {
    const { id } = Id.parse(req.params);
    const body = ConfigBody.parse(req.body);
    return onRepo("onboarding.manage", (tx, a, repoId) => configureRepo(tx, a, repoId, body), { versionRequired: true })(req);
  });

  app.post("/api/v1/repos/:id/onboarding/assess", async (req) => { EmptyBody.parse(req.body); return onRepo("onboarding.manage", rerunAssessment)(req); });
  app.post("/api/v1/repos/:id/onboarding/open-pr", async (req) => { EmptyBody.parse(req.body); return onRepo("onboarding.manage", openOnboardingPr)(req); });
  app.post("/api/v1/repos/:id/onboarding/merge", async (req) => { EmptyBody.parse(req.body); return onRepo("onboarding.merge", mergeOnboardingPr)(req); });
  app.post("/api/v1/repos/:id/onboarding/verify", async (req) => { EmptyBody.parse(req.body); return onRepo("onboarding.manage", verifyNow)(req); });
  app.post("/api/v1/repos/:id/onboarding/request-changes", async (req) => {
    const b = ChangesBody.parse(req.body);
    return onRepo("onboarding.manage", (tx, a, repoId) => requestChanges(tx, a, repoId, b.text))(req);
  });
  app.post("/api/v1/repos/:id/onboarding/exception", async (req) => {
    const b = ExceptionBody.parse(req.body);
    return onRepo("onboarding.exception", (tx, a, repoId) => markException(tx, a, repoId, b.reason))(req);
  });

  /* ------------------------------------------------------------------ guidelines */

  app.get("/api/v1/guidelines", async (req) => {
    requirePerson(req);
    return readOrgGuidelines(g.pool, g.orgId);
  });

  app.put("/api/v1/guidelines", async (req) => {
    const body = OrgBody.parse(req.body);
    return command(req, { action: "agent.edit", ifMatch: async (tx) => (await readOrgGuidelines(tx, g.orgId)).version, ifMatchRequired: true }, (tx, a) => saveOrgGuidelines(tx, a, body));
  });

  app.put("/api/v1/projects/:id/guidelines", async (req) => {
    const { id } = Id.parse(req.params);
    const body = ProjectBody.parse(req.body);
    await visibleProject(req, id);
    const name = (await g.pool.query<{ name: string }>(`select name from projects where org_id = $1 and id = $2`, [g.orgId, id])).rows[0]?.name ?? id;
    const version = async (tx: import("@gantry/db").Tx): Promise<number | null> => (await readProjectGuidelines(tx, g.orgId, id))?.version ?? 0;
    return command(req, { action: "onboarding.guidelines", scope: { project: id }, ifMatch: version, ifMatchRequired: true }, async (tx, a) => {
      const st = (await tx.query<{ status: string }>(`select status from projects where org_id = $1 and id = $2`, [g.orgId, id])).rows[0];
      if (st?.status === "archived") throw refuse("stopped", `${name} is archived and read-only. Unarchive it to change it.`);
      return saveProjectGuidelines(tx, a, id, name, body);
    });
  });

  /* ------------------------------------------------------------------ for the GitHub broker */

  app.post("/internal/v1/onboarding/fence", async (req) => {
    const p = req.gx.principal;
    if (!p || p.kind !== "service" || p.id !== "github") throw refuse("denied", "This endpoint is for the GitHub broker.", { rule: { kind: "invariant", id: "SERVICE", name: "Service identity" } });
    const b = FenceBody.parse(req.body);
    return command(req, { action: "github.fence", service: true }, async (tx, actor): Promise<CommandResult<Record<string, unknown>>> => {
      const r = await fenceOnboarding(tx, actor.orgId, b.repo, b.purpose);
      return {
        msg: r.allow ? "Repository is writable." : r.reason,
        events: [{
          category: "integrations", subject: { type: "repo", id: r.repoId ?? b.repo }, projectId: r.projectId,
          ...(r.allow ? { type: "github.fence.passed", after: { purpose: b.purpose, repo: b.repo } } : { type: "github.fence.denied", outcome: "denied" as const, after: { purpose: b.purpose, repo: b.repo, code: r.code, reason: r.reason } }),
        }],
        extra: r.allow ? { allow: true, repoId: r.repoId, projectId: r.projectId } : { allow: false, code: r.code, reason: r.reason },
        changes: [],
      };
    });
  });
};
