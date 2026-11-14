import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { command, type CommandResult, type EventSpec } from "../../core/command.js";
import { notFound, refuse } from "../../core/errors.js";
import { applyFacts } from "./store.js";
import { GithubFacts } from "./facts.js";
import { ATTEMPT_PURPOSES, WO_PURPOSES, fenceAttempt, fenceWorkOrder, type FenceResult } from "./fence.js";

const Id = z.object({ id: z.string().min(1).max(200) });
const Repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200);
const AttemptFence = z.object({ fencing: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).transform(Number), purpose: z.enum(ATTEMPT_PURPOSES).default("publish"), repo: Repo.optional() });
const WoFence = z.object({ purpose: z.enum(WO_PURPOSES), repo: Repo.optional() });

/** Only the GitHub broker's service token may call these. */
function brokerOnly(req: FastifyRequest): void {
  const p = req.gx.principal;
  if (!p || p.kind !== "service" || p.id !== "github") throw refuse("denied", "These endpoints are for the GitHub broker.", { rule: { kind: "invariant", id: "SERVICE", name: "Service identity" } });
}

const svc = (action: string) => ({ action, service: true }) as const;

function fenceEvents(subject: { type: string; id: string }, purpose: string, r: FenceResult, extra: Record<string, unknown>): EventSpec[] {
  const base = { category: "integrations" as const, subject, projectId: r.projectId, woId: r.woId };
  return r.allow
    ? [{ ...base, type: "github.fence.passed", after: { purpose, ...extra, ...(r.stopsIgnored ? { underStop: true } : {}) } }]
    : [{ ...base, type: "github.fence.denied", outcome: "denied", after: { purpose, code: r.code, reason: r.reason, ...extra } }];
}

const fenceBody = (r: FenceResult): Record<string, unknown> =>
  r.allow ? { allow: true, woId: r.woId, attemptId: r.attemptId, projectId: r.projectId, repoId: r.repoId, repo: r.githubFullName ?? r.repoName, branch: r.branch, reason: "ok" } : { allow: false, code: r.code, reason: r.reason, woId: r.woId };

export const githubInternalRoutes: FastifyPluginAsync = async (app) => {
  // Fence check for attempt writes (publish). A denial is a 200 with allow:false and an audit event, like the edge's authorize.
  app.post("/internal/v1/attempts/:id/fence-check", async (req) => {
    brokerOnly(req);
    const { id } = Id.parse(req.params);
    const b = AttemptFence.parse(req.body);
    return command(req, svc("github.fence"), async (tx, actor): Promise<CommandResult<Record<string, unknown>>> => {
      const r = await fenceAttempt(tx, actor.orgId, id, b.fencing, b.purpose, b.repo);
      return { msg: r.allow ? "Attempt is current." : r.reason, events: fenceEvents({ type: "attempt", id }, b.purpose, r, { fencing: b.fencing }), extra: fenceBody(r), changes: [] };
    });
  });

  // Fence check for writes that belong to a work order rather than an attempt: gate check, PR update, merge, stop enforcement.
  app.post("/internal/v1/work-orders/:id/fence-check", async (req) => {
    brokerOnly(req);
    const { id } = Id.parse(req.params);
    const b = WoFence.parse(req.body);
    return command(req, svc("github.fence"), async (tx, actor): Promise<CommandResult<Record<string, unknown>>> => {
      const r = await fenceWorkOrder(tx, actor.orgId, id, b.purpose, b.repo);
      return { msg: r.allow ? "Work order is writable." : r.reason, events: fenceEvents({ type: "work_order", id }, b.purpose, r, {}), extra: fenceBody(r), changes: [] };
    });
  });

  // Polled, published or webhook-derived facts (spec 11.4, 11.6).
  app.post("/internal/v1/github/events", async (req) => {
    brokerOnly(req);
    const facts = GithubFacts.parse(req.body);
    return command(req, svc("github.events"), async (tx, actor): Promise<CommandResult<Record<string, unknown>>> => {
      const r = await applyFacts(tx, actor.orgId, facts, { now: actor.now });
      if (r.unknownRepo) throw notFound(`Repository ${facts.repo} is not connected to Gantry.`);
      return { msg: r.events.length ? "Stored." : "Nothing changed.", events: r.events, extra: { counts: r.counts, merged: r.merged }, changes: r.changes };
    });
  });

  // The repositories the broker polls: connected repos that have a GitHub identity.
  app.get("/internal/v1/github/repos", async (req) => {
    brokerOnly(req);
    const { rows } = await req.server.gantry.pool.query(
      `select r.id, r.name, coalesce(r.github_full_name, case when position('/' in r.name) > 0 then r.name end) as full_name, r.installation_id::text as installation_id, r.project_id,
              coalesce(c.default_branch, 'main') as default_branch, coalesce(c.branch_prefix, 'gantry/') as branch_prefix
         from repos r left join repo_config c on c.org_id = r.org_id and c.repo_id = r.id where r.org_id = $1 order by r.id`,
      [req.gx.orgId],
    );
    const repos = rows.filter((r) => r.full_name).map((r) => ({ id: r.id, repo: r.full_name, installationId: r.installation_id ? Number(r.installation_id) : null, projectId: r.project_id, defaultBranch: r.default_branch, branchPrefix: r.branch_prefix }));
    return { ok: true, repos };
  });
};
