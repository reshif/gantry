import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_URL } from "./db.js";
import { startWorld, type World } from "./world.js";

const d = TEST_URL ? describe : describe.skip;
const HEAD = "d".repeat(40);

/** Finding 17: the Review agent's description reaches the work order's pull request, and a re-run updates it. */
d("pr.describe", () => {
  let w: World;
  beforeEach(async () => { w = await startWorld(); });
  afterEach(async () => { await w.close(); });

  async function reviewed(id: string, review: Record<string, unknown>, pr = 7) {
    await w.q(`update repos set github_full_name = 'acme/payments-api' where org_id = $1 and id = 'payments-api'`, [w.orgId]);
    await w.q(
      `insert into work_orders (org_id, id, project_id, repo_id, title, class, priority, position, state, flow_version, submitter, risk, sla_due_at, data)
       values ($1,$2,'payments','payments-api','Describe me','feature','P2','review','waiting',(select current_flow_version from projects where org_id = $1 and id = 'payments'),'p-tomas','normal', now() + interval '3 days', $3::jsonb)`,
      [w.orgId, id, JSON.stringify({ history: [], log: [], review })],
    );
    await w.q(`insert into pull_requests (org_id, id, repo_id, wo_id, number, title, state, head_sha) values ($1,$2,'payments-api',$3,$4,'x','open',$5)`, [w.orgId, `pr-${id}`, id, pr, HEAD]);
    w.broker.prs.set(pr, { number: pr, state: "open", head: HEAD, draft: false, mergeSha: null, body: `Gantry work order ${id}` });
  }
  const rv = (attempt: string, body: string, title: string | null = "Add the refund idempotency key") => ({ verdict: "approve", attempt, headSha: HEAD, description: { title, body } });

  it("writes the description and title to the work order's pull request, and updates it when review runs again", async () => {
    await reviewed("WO-9301", rv("ATT-1", "## Summary\nAdds the key."));
    await w.enqueue("pr.describe", { woId: "WO-9301", attemptId: "ATT-1" }, { dedupeKey: "pr.describe:WO-9301:ATT-1" });
    await w.drain();
    const call = w.broker.calls.find((c) => c.op === "describe")!;
    expect(call.body).toMatchObject({ woId: "WO-9301", repo: "acme/payments-api", number: 7, title: "Add the refund idempotency key" });
    expect(String(call.body.body)).toContain("## Summary\nAdds the key.");
    expect(String(call.body.body)).toContain("Gantry work order WO-9301");
    expect(w.broker.prs.get(7)!.body).toContain("Adds the key.");
    expect((await w.q(`select type from events where wo_id = 'WO-9301' and type = 'github.pr.described'`)).length).toBe(1);
    // Review runs again with a better description: the pull request is updated, not left with the first one.
    await w.q(`update work_orders set data = data || $2::jsonb where id = $1`, ["WO-9301", JSON.stringify({ review: rv("ATT-2", "## Summary\nSecond pass.") })]);
    await w.enqueue("pr.describe", { woId: "WO-9301", attemptId: "ATT-2" }, { dedupeKey: "pr.describe:WO-9301:ATT-2" });
    await w.drain();
    expect(w.broker.count("describe")).toBe(2);
    expect(w.broker.prs.get(7)!.body).toContain("Second pass.");
    expect(w.broker.prs.get(7)!.body).not.toContain("Adds the key.");
  });

  it("a replaced review, a review with no description and a work order with no open pull request write nothing", async () => {
    await reviewed("WO-9302", rv("ATT-9", "## Summary\nNewer."));
    await w.enqueue("pr.describe", { woId: "WO-9302", attemptId: "ATT-OLD" }, { dedupeKey: "pr.describe:WO-9302:ATT-OLD" });
    await reviewed("WO-9303", { verdict: "approve", attempt: "ATT-3", description: null }, 8);
    await w.enqueue("pr.describe", { woId: "WO-9303", attemptId: "ATT-3" }, { dedupeKey: "pr.describe:WO-9303:ATT-3" });
    await w.q(`update pull_requests set state = 'closed' where wo_id = 'WO-9302'`);
    await w.drain();
    expect(w.broker.count("describe")).toBe(0);
  });

  it("a halt on the work order stops the write", async () => {
    await reviewed("WO-9304", rv("ATT-4", "## Summary\nHalted."));
    await w.q(`insert into stops (org_id, id, scope_type, wo_id, mode, reason, set_by) values ($1,'STOP-9304','wo','WO-9304','halt','test','p-asha')`, [w.orgId]);
    await w.enqueue("pr.describe", { woId: "WO-9304", attemptId: "ATT-4" }, { dedupeKey: "pr.describe:WO-9304:ATT-4" });
    await w.drain();
    expect(w.broker.count("describe")).toBe(0);
  });
});
