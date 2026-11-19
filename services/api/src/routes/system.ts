/**
 * System health (admin). Owns:
 *   GET  /api/v1/system/health                  services, backup and restore drill, outbox and dead letters, stuck jobs (read gate: integrations.view, a factory-level right)
 *   POST /api/v1/system/outbox/{id}/retry       requeue one dead delivery (integration.edit at factory level, so a project admin cannot retry; audited)
 * Nothing here deletes or edits a payload: a retry only makes a dead row pending again, so the dispatcher sends it with its original content.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { command, conflict, notFound, refuse } from "../core/index.js";
import { collectHealth, httpProbe, redactError, shownDestination, targetsFromEnv, type Probe, type Targets } from "../areas/system/health.js";

/** Tests replace the probe, the targets and the backups directory; production reads the environment. */
export const systemOverrides: { probe?: Probe; targets?: Targets; backupsDir?: string } = {};

export const systemRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  app.get("/api/v1/system/health", async (req) => {
    if (req.gx.principal?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
    return collectHealth({
      pool: g.pool, orgId: g.orgId, probe: systemOverrides.probe ?? httpProbe, targets: systemOverrides.targets ?? targetsFromEnv(),
      backupsDir: systemOverrides.backupsDir ?? process.env.GANTRY_BACKUPS_DIR ?? "/backups",
    });
  });

  app.post("/api/v1/system/outbox/:id/retry", async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    return command(req, { action: "integration.edit", scope: {} }, async (tx, a) => {
      const r = await tx.query<{ destination: string; attempts: number; event_id: string; last_error: string | null; project_id: string | null }>(
        `select o.destination, o.attempts, o.event_id, o.last_error, e.project_id from outbox o join events e on e.id = o.event_id
          where o.org_id = $1 and o.id = $2 and o.status = 'dead' for update of o`, [a.orgId, id]);
      const row = r.rows[0];
      if (!row) {
        const any = (await tx.query(`select 1 from outbox where org_id = $1 and id = $2`, [a.orgId, id])).rowCount;
        throw any ? conflict("That delivery is not dead any more. Nothing to retry.") : notFound("No such delivery.");
      }
      await tx.query(
        `update outbox set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null, lease_owner = null, lease_until = null, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, id]);
      return {
        msg: `Requeued the delivery to ${shownDestination(row.destination, !!row.project_id)}.`,
        events: [{ type: "system.outbox.retry", subject: { type: "outbox", id }, // The retry clears last_error on the row, so the reason it died is kept here (masked the same way the view masks it).
        before: { status: "dead", attempts: row.attempts, lastError: redactError(row.last_error, !!row.project_id, 500) }, after: { status: "pending", destination: shownDestination(row.destination, !!row.project_id), event: row.event_id } }],
        changes: ["system"],
      };
    });
  });
};
