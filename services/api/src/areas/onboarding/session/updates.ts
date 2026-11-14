/**
 * Event-driven follow-ups in the onboarding session (spec 11.3). When the sync, the assessment or a verification observes something about a repo (checks turned green or
 * red, no CI reported, the PR merged or closed elsewhere, readiness verified or lost), Gantry posts one system message into the repo's session thread with the observed facts.
 * The post is idempotent per observed transition (a deterministic message id from `key`), so a sync tick that sees the same thing again posts nothing. The same call appends
 * the `onboarding.session.update` event, which the notification producer turns into deliveries along the project's routes (Slack, email, webhooks). The bell lists the
 * update for the people involved (see `involved`). When `followUp` is set the message asks for an agent turn, which the API's follow-up runner takes (it summarises and puts up
 * the next proposal). Nothing here writes to GitHub.
 */
import { createHash } from "node:crypto";
import { appendEvent, type Queryable, type Tx } from "@gantry/db";
import { addSessionMessage } from "./store.js";

export interface UpdateOpts { key: string; event: string; text: string; now: Date; runId?: string | null; number?: number | null; followUp?: boolean }

/** Posts the update once. Returns false when this transition was already posted. */
export async function postUpdate(tx: Tx, orgId: string, repo: { id: string; project_id: string; name: string }, o: UpdateOpts): Promise<boolean> {
  const id = `om-ev-${createHash("sha1").update(`${orgId}:${repo.id}:${o.key}`).digest("hex").slice(0, 20)}`;
  const { rowCount } = await tx.query(`select 1 from onboarding_messages where org_id = $1 and id = $2`, [orgId, id]);
  if (rowCount) return false;
  await addSessionMessage(tx, orgId, repo.id, o.runId ?? null, "system", "system", o.text, { kind: "update", mode: "rule-based", cards: [], ...(o.followUp ? { followUp: "pending" } : {}), event: o.event } as never, o.now, id);
  await appendEvent(tx, {
    orgId, type: "onboarding.session.update", category: "onboarding", actor: "system", channel: "system", subject: { type: "repo", id: repo.id }, projectId: repo.project_id, outcome: "ok", occurredAt: o.now,
    after: { repo: repo.name, repoId: repo.id, ...(o.number ? { number: o.number } : {}), event: o.event, text: o.text },
  });
  return true;
}

/** Who a session update concerns: whoever started the run or spoke in the thread, and the project's admins and release managers (through teams too). */
export async function involved(db: Queryable, orgId: string, repoId: string, projectId: string): Promise<string[]> {
  const { rows } = await db.query<{ p: string }>(
    `select author as p from onboarding_messages where org_id = $1 and repo_id = $2 and role = 'user'
     union select started_by from onboarding_runs where org_id = $1 and repo_id = $2 and started_by is not null
     union select person_id from effective_role_assignments where org_id = $1 and project_id = $3 and role_id in ('project_admin','release_manager') and revoked_at is null and (expires_at is null or expires_at > now())`,
    [orgId, repoId, projectId],
  );
  return [...new Set(rows.map((r) => r.p).filter((p) => p && !p.startsWith("apikey:") && p !== "system"))];
}

export async function markSeen(tx: Tx, orgId: string, repoId: string, person: string): Promise<void> {
  await tx.query(
    `insert into onboarding_session_seen (org_id, repo_id, person_id, seen_at) values ($1,$2,$3,clock_timestamp()) on conflict (org_id, repo_id, person_id) do update set seen_at = clock_timestamp()`,
    [orgId, repoId, person],
  );
}
