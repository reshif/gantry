/**
 * Processing a stored webhook delivery (the `github.event` job, spec 11.6). Webhooks are hints: the payload is turned into the same facts a poll
 * delivers and applied by `applyFacts`, so the two paths cannot disagree. Call it inside the job's transaction (the worker owns the transaction).
 */
import { appendEvent, type Tx } from "@gantry/db";
import { publishChange } from "../../core/changes.js";
import { applyFacts, findRepo } from "./store.js";
import { GithubFacts, type PullRequestFact } from "./facts.js";

export type DeliveryOutcome = { status: "processed"; applied: number; drift: number } | { status: "ignored"; reason: string } | { status: "failed"; reason: string } | { status: "missing" };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const labels = (v: unknown): string[] => (Array.isArray(v) ? v.map((l) => str(obj(l).name)).filter((x): x is string => !!x) : []);

function prFact(p: Json): PullRequestFact {
  const head = obj(p.head);
  const merged = p.merged === true || !!str(p.merged_at);
  return {
    number: Number(p.number), githubId: typeof p.id === "number" ? p.id : null, title: str(p.title) ?? "", state: merged ? "merged" : p.state === "closed" ? "closed" : "open", draft: p.draft === true,
    headSha: str(head.sha), baseBranch: str(obj(p.base).ref), headBranch: str(head.ref), url: str(p.html_url), mergedAt: str(p.merged_at), mergeCommitSha: merged ? str(p.merge_commit_sha) : null,
    labels: labels(p.labels), author: str(obj(p.user).login),
  };
}

/** Maps one webhook payload to facts; null means the event type carries nothing Gantry stores (it is acknowledged and marked ignored). */
export function factsFromWebhook(event: string, payload: Json): { facts: GithubFacts } | { ignore: string } {
  const repo = str(obj(payload.repository).full_name);
  if (!repo) return { ignore: "no repository in the payload" };
  const base = { source: "hook" as const, repo };
  switch (event) {
    case "pull_request":
      return { facts: GithubFacts.parse({ ...base, pullRequests: [prFact(obj(payload.pull_request))] }) };
    case "pull_request_review": {
      const r = obj(payload.review);
      const pr = obj(payload.pull_request);
      return { facts: GithubFacts.parse({ ...base, pullRequests: [prFact(pr)], reviews: [{ prNumber: Number(pr.number), githubId: typeof r.id === "number" ? r.id : null, reviewer: str(obj(r.user).login) ?? "unknown", state: String(r.state ?? "commented").toLowerCase(), body: str(r.body) ?? "", submittedAt: str(r.submitted_at), commitId: str(r.commit_id) }] }) };
    }
    case "check_run": {
      const c = obj(payload.check_run);
      const sha = str(c.head_sha);
      if (!sha) return { ignore: "check_run without head_sha" };
      return { facts: GithubFacts.parse({ ...base, checks: [{ headSha: sha, name: str(c.name) ?? "check", status: c.status === "completed" ? "completed" : c.status === "in_progress" ? "in_progress" : "queued", conclusion: str(c.conclusion), githubId: typeof c.id === "number" ? c.id : null, completedAt: str(c.completed_at), appSlug: str(obj(c.app).slug) }] }) };
    }
    case "issues": {
      const i = obj(payload.issue);
      if (!["labeled", "opened"].includes(String(payload.action))) return { ignore: `issues.${String(payload.action)}` };
      return { facts: GithubFacts.parse({ ...base, issues: [{ number: Number(i.number), title: str(i.title) ?? "", labels: labels(i.labels), author: str(obj(i.user).login), url: str(i.html_url) }] }) };
    }
    default:
      return { ignore: `${event} is not stored` };
  }
}

export async function processGithubDelivery(tx: Tx, orgId: string, deliveryId: string, o: { now?: Date } = {}): Promise<DeliveryOutcome> {
  const d = (await tx.query<{ event_type: string; payload_hash: string; status: string }>(
    `select event_type, payload_hash, status from inbound_deliveries where org_id = $1 and source = 'github' and delivery_id = $2 for update`, [orgId, deliveryId])).rows[0];
  if (!d) return { status: "missing" };
  if (d.status !== "received") return { status: "ignored", reason: `already ${d.status}` };
  const mark = (s: "processed" | "failed" | "ignored") => tx.query(`update inbound_deliveries set status = $3, processed_at = now(), updated_at = now() where org_id = $1 and source = 'github' and delivery_id = $2`, [orgId, deliveryId, s]);
  const blob = (await tx.query<{ content: Buffer }>(`select content from github_blobs where org_id = $1 and hash = $2`, [orgId, d.payload_hash])).rows[0];
  let payload: Json;
  try { payload = obj(JSON.parse(blob?.content.toString("utf8") ?? "")); } catch { await mark("failed"); return { status: "failed", reason: "stored payload is unreadable" }; }
  let m: ReturnType<typeof factsFromWebhook>;
  try { m = factsFromWebhook(d.event_type, payload); } catch (e) { await mark("failed"); return { status: "failed", reason: `unexpected payload shape: ${(e as Error).message.slice(0, 200)}` }; }
  if ("ignore" in m) { await mark("ignored"); return { status: "ignored", reason: m.ignore }; }
  if (!(await findRepo(tx, orgId, m.facts.repo))) { await mark("ignored"); return { status: "ignored", reason: `repository ${m.facts.repo} is not connected` }; }
  const r = await applyFacts(tx, orgId, m.facts, o.now ? { now: o.now } : {});
  for (const e of r.events) {
    await appendEvent(tx, { orgId, type: e.type, category: e.category ?? "integrations", actor: "github", channel: "github", subject: e.subject ?? null, projectId: e.projectId ?? null, woId: e.woId ?? null, outcome: e.outcome ?? "ok", before: e.before, after: { ...(e.after as object | undefined), delivery: deliveryId }, causationId: deliveryId });
  }
  await publishChange(tx, { org: orgId, keys: [...r.changes, ...(r.events.length ? ["audit"] : [])] });
  await mark("processed");
  return { status: "processed", applied: r.events.length, drift: r.counts.drift };
}
