import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

/** Agent workspace, Phase 1: station documents, questions with pause and resume, assumptions, attribution. */
d("station documents and dialogue", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const doc = async (woId: string, attemptId: string, station: string, name: string, body: string) => {
    const { recordDocument } = await import("../src/areas/workorders/documents.js");
    const hash = (await import("node:crypto")).createHash("sha256").update(body).digest("hex");
    return w.tx((tx) => recordDocument(tx, { orgId: t.orgId, id: `art-${attemptId}-${name}`, woId, attemptId, station, name, hash, mediaType: "text/markdown", size: body.length, body, author: "ag-research" }));
  };

  it("documents are versioned per name, readable by people who see the work order, and handed to the next run", async () => {
    const id = await w.atStation("research", "Documents path");
    const a1 = (await w.liveAttempt(id))!;
    expect(await doc(id, a1.id, "research", "research.md", "# Research\n\nFirst pass.")).toMatchObject({ version: 1 });
    // The run stops to ask; the next run of the same station writes version 2 of the same document.
    await w.apply(a1, { status: "needs_person", summary: "Need the owner", output: { dialogue: { questions: [{ question: "Who owns the sync job?", why: "The fix goes in their module.", blocking: true, askOf: "requester" }] } } });
    const wo = await w.get(id);
    expect(wo.bay).toBe("person");
    const dl = (await w.call("p-tomas", "GET", `/api/v1/work-orders/${id}/dialogue`)).body;
    const ans = await w.call("p-tomas", "POST", `/api/v1/work-orders/${id}/questions/${dl.questions[0].id}/answer`, { answer: "The platform team owns it." });
    expect(ans.status, JSON.stringify(ans.body)).toBe(200);
    expect(ans.body.resumed).toBe(true);
    const a2 = (await w.liveAttempt(id))!;
    expect(a2.id).not.toBe(a1.id);
    expect(a2.station).toBe("research");
    // The new run's handoff carries the earlier document and the answered question.
    const { latestDocuments, dialogueHandoff } = await import("../src/areas/workorders/documents.js");
    expect(await latestDocuments(t.db.app, t.orgId, id, { exceptAttempt: a2.id })).toMatchObject([{ name: "research.md", version: 1, markdown: "# Research\n\nFirst pass." }]);
    expect((await dialogueHandoff(t.db.app, t.orgId, id)).questions).toMatchObject([{ question: "Who owns the sync job?", status: "answered", answer: "The platform team owns it.", answeredBy: "p-tomas" }]);
    expect(await doc(id, a2.id, "research", "research.md", "# Research\n\nWith the owner.")).toMatchObject({ version: 2 });
    const list = (await w.call("p-tomas", "GET", `/api/v1/work-orders/${id}/documents`)).body.items as Array<{ id: string; version: number; supersedes: string | null; body?: string }>;
    expect(list.map((x) => x.version)).toEqual([1, 2]);
    expect(list[1]!.supersedes).toBe(list[0]!.id);
    expect(list[0]!.body).toBeUndefined();
    const one = await w.call("p-tomas", "GET", `/api/v1/work-orders/${id}/documents/${list[1]!.id}`);
    expect(one.body).toMatchObject({ doc: "research.md", version: 2, body: "# Research\n\nWith the owner.", authorKind: "agent", authorId: "ag-research" });
    // Someone who cannot see the project gets the same 404 as for the work order itself.
    expect((await w.call("p-fatima", "GET", `/api/v1/work-orders/${id}/documents`)).status).toBe(404);
  });

  it("a station that asks waits for every blocking answer, records who answered, and resumes with them", async () => {
    const id = await w.atStation("research", "Two questions");
    const att = (await w.liveAttempt(id))!;
    await doc(id, att.id, "research", "research.md", "# So far");
    const r = await w.apply(att, {
      status: "needs_person",
      output: {
        dialogue: {
          questions: [
            { question: "Which currency should refunds use?", why: "Rounding differs per currency.", blocking: true, options: ["EUR", "USD"] },
            { question: "Do refunds need an approval step?", why: "It decides whether a gate is added.", blocking: true, askOf: "approvers" },
            { question: "Any naming preference?", why: "Cosmetic.", blocking: false },
          ],
          assumptions: [{ statement: "Refunds are always full refunds", because: "The request says 'refund the order'.", impact: "high" }],
        },
      },
    });
    expect(r).toMatchObject({ applied: true, next: "person" });
    const wo = await w.get(id);
    expect(wo.bayReason).toBe("Waiting for 2 answers at Research");
    const dl = (await w.call("p-meera", "GET", `/api/v1/work-orders/${id}/dialogue`)).body;
    expect(dl.questions.map((q: { blocking: boolean }) => q.blocking)).toEqual([true, true, false]);
    expect(dl.questions[1].askOf).toBe("approvers");
    expect(dl.assumptions).toMatchObject([{ statement: "Refunds are always full refunds", impact: "high", status: "open" }]);
    // The station's own message in the session carries its document and its questions as cards.
    const msgs = await w.q<{ author: string; data: { kind: string; cards: Array<{ kind: string }> } }>(`select author, data from workorder_messages where wo_id = $1 and data->>'kind' = 'station'`, [id]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.author).toBe("ag-research");
    expect(msgs[0]!.data.cards.map((c) => c.kind)).toEqual(["document", "station_question", "station_question", "station_question", "assumptions"]);

    // Someone without the right to answer is refused and audited; the requester and a line lead may answer.
    expect((await w.call("p-rui", "POST", `/api/v1/work-orders/${id}/questions/${dl.questions[0].id}/answer`, { answer: "EUR" })).status).toBe(403);
    const first = await w.call("p-tomas", "POST", `/api/v1/work-orders/${id}/questions/${dl.questions[0].id}/answer`, { answer: "EUR" });
    expect(first.body).toMatchObject({ ok: true, resumed: false });
    expect((await w.get(id)).bay).toBe("person");
    expect((await w.call("p-tomas", "POST", `/api/v1/work-orders/${id}/questions/${dl.questions[0].id}/answer`, { answer: "USD" })).status).toBe(409);
    const second = await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/questions/${dl.questions[1].id}/answer`, { kind: "dont_know" });
    expect(second.body).toMatchObject({ ok: true, resumed: true });
    const after = (await w.call("p-meera", "GET", `/api/v1/work-orders/${id}/dialogue`)).body;
    expect(after.questions[0]).toMatchObject({ status: "answered", answer: "EUR", answeredBy: "p-tomas", answerKind: "answer" });
    expect(after.questions[1]).toMatchObject({ status: "answered", answer: "I don't know.", answeredBy: "p-meera", answerKind: "dont_know" });
    expect(after.questions[2].status).toBe("open");
    const back = await w.get(id);
    expect(back.bay).toBeNull();
    expect((await w.liveAttempt(id))!.station).toBe("research");
    const answers = await w.q<{ author: string }>(`select author from workorder_messages where wo_id = $1 and data->>'kind' = 'answer' order by created_at`, [id]);
    expect(answers.map((a) => a.author)).toEqual(["p-tomas", "p-meera"]);
    expect((await w.events("wo.answer")).filter((e: { wo_id: string; after: { question?: string } }) => e.wo_id === id && e.after?.question)).toHaveLength(2);
  });

  it("a question is answerable only by the people it is for", async () => {
    const id = await w.atStation("research", "Addressed questions");
    const att = (await w.liveAttempt(id))!;
    await w.apply(att, {
      status: "needs_person",
      output: { dialogue: { questions: [
        { question: "Is the refund policy change approved?", why: "Policy.", blocking: true, askOf: "approvers" },
        { question: "Which engineer owns the sync?", why: "Ownership.", blocking: true, askOf: "role:engineer" },
        { question: "Which team reviews security?", why: "Routing.", blocking: true, askOf: "role:security_reviewer" },
        { question: "Which region first?", why: "Rollout.", blocking: true, askOf: "anyone" },
      ] } },
    });
    const dl = (await w.call("p-tomas", "GET", `/api/v1/work-orders/${id}/dialogue`)).body;
    const qid = (n: string) => dl.questions.find((q: { question: string }) => q.question.startsWith(n)).id as string;
    const answer = (who: string, q: string) => w.call(who, "POST", `/api/v1/work-orders/${id}/questions/${qid(q)}/answer`, { answer: "Yes." });
    const open = async () => Number((await w.q<{ n: number }>(`select count(*)::int as n from wo_questions where wo_id = $1 and status = 'open'`, [id]))[0]!.n);

    // The requester (an engineer, not an approver) cannot answer what is for approvers or for a role they do not hold.
    const denied = await answer("p-tomas", "Is the refund");
    expect(denied.status).toBe(403);
    expect(denied.body.error?.message ?? JSON.stringify(denied.body)).toContain("an approver");
    expect((await answer("p-tomas", "Which team reviews")).status).toBe(403);
    expect(await open()).toBe(4);
    // The refusal is audited like any other denial, with the rule that refused it, and nothing was recorded as an answer.
    const audited = (await w.events("self.denied")).filter((e: { wo_id: string }) => e.wo_id === id);
    expect(audited).toHaveLength(2);
    expect(audited[0]).toMatchObject({ outcome: "denied", actor: "p-tomas", rule: "ASK-OF" });
    expect((await w.q<{ n: number }>(`select count(*)::int as n from workorder_messages where wo_id = $1 and data->>'kind' = 'answer'`, [id]))[0]!.n).toBe(0);
    expect((await w.get(id)).bay).toBe("person");

    // An approver may answer a question for approvers, a role holder one for their role, and anyone one for anyone.
    expect((await answer("p-meera", "Is the refund")).status).toBe(200);
    expect((await answer("p-tomas", "Which engineer")).status).toBe(200);
    expect((await answer("p-tomas", "Which region")).status).toBe(200);
    // An approver can speak for a role question too.
    const last = await answer("p-meera", "Which team reviews");
    expect(last.status).toBe(200);
    expect(last.body.resumed).toBe(true);
  });

  it("assumptions are confirmed or corrected by people, with the correction handed on", async () => {
    const id = await w.atStation("research", "Assumptions path");
    const att = (await w.liveAttempt(id))!;
    await w.apply(att, { status: "succeeded", summary: "Found the retry module.", output: { dialogue: { questions: [], assumptions: [{ statement: "Retries are idempotent", because: "The handler upserts." }, { statement: "Only EU customers", because: "The ticket mentions SEPA." }] } } });
    const dl = (await w.call("p-tomas", "GET", `/api/v1/work-orders/${id}/dialogue`)).body;
    expect(dl.assumptions).toHaveLength(2);
    const bad = await w.call("p-tomas", "POST", `/api/v1/work-orders/${id}/assumptions/${dl.assumptions[1].id}`, { status: "corrected" });
    expect(bad.status).toBe(422);
    expect((await w.call("p-tomas", "POST", `/api/v1/work-orders/${id}/assumptions/${dl.assumptions[0].id}`, { status: "confirmed" })).status).toBe(200);
    expect((await w.call("p-tomas", "POST", `/api/v1/work-orders/${id}/assumptions/${dl.assumptions[1].id}`, { status: "corrected", note: "All customers, not only EU." })).status).toBe(200);
    const { dialogueHandoff } = await import("../src/areas/workorders/documents.js");
    expect((await dialogueHandoff(t.db.app, t.orgId, id)).assumptions).toMatchObject([{ status: "confirmed" }, { status: "corrected", correction: "All customers, not only EU." }]);
    // A station that only assumed still says so in the session.
    const msgs = await w.q<{ body: string; data: { cards: Array<{ kind: string; count?: number }> } }>(`select body, data from workorder_messages where wo_id = $1 and data->>'kind' = 'station'`, [id]);
    expect(msgs[0]!.body).toContain("Found the retry module.");
    expect(msgs[0]!.data.cards).toEqual([{ kind: "assumptions", station: "research", attempt: att.id, count: 2 }]);
  });
  it("'waiting for you' is shown to the person the question asks, and everyone else sees whom it waits on", async () => {
    const id = await w.atStation("research", "Who is asked");
    const att = (await w.liveAttempt(id))!;
    await w.apply(att, { status: "needs_person", output: { dialogue: { questions: [{ question: "Which tenant goes first?", why: "Rollout order changes the plan.", blocking: true, askOf: "requester" }] } } });
    const mine = (await w.call("p-tomas", "GET", `/api/v1/work-orders/${id}/session`)).body;
    expect(mine.dialogue.askedMe).toBe(true);
    expect(mine.next).toMatchObject({ actor: "you" });
    expect(mine.waiting.text).toMatch(/^Waiting for you: 1 question from Research/);
    const lead = (await w.call("p-meera", "GET", `/api/v1/work-orders/${id}/session`)).body;
    expect(lead.dialogue.askedMe).toBe(false);
    expect(lead.next).toMatchObject({ actor: "person", text: "Research is waiting for an answer from the requester." });
    const list = async (who: string) => ((await w.call(who, "GET", "/api/v1/work-order-sessions?project=payments")).body.items as Array<{ id: string; waitingOn: string }>).find((x) => x.id === id)?.waitingOn;
    expect(await list("p-tomas")).toBe("you");
    expect(await list("p-meera")).toBe("person");
  });

  it("research: a proposed plan parks the station; an approver decides; unlisted hosts need security; the run reads only approved hosts", async () => {
    const id = await w.atStation("research", "Research plan");
    const att = (await w.liveAttempt(id))!;
    await w.apply(att, { status: "needs_person", output: { researchPlan: { questions: ["How do Nautobot jobs retry?"], hosts: ["docs.nautobot.com", "blog.example.org"], web: true, budgetUsd: 3, why: "No retry helper in the repo." } } });
    let wo = await w.get(id);
    expect(wo.bayReason).toBe("Waiting for the research plan at Research");
    const { researchHosts } = await import("../src/areas/workorders/research.js");
    const data = async () => (await w.q<{ data: Record<string, unknown> }>(`select data from work_orders where id = $1`, [id]))[0]!.data;
    expect(await researchHosts(t.db.app, t.orgId, await data())).toEqual([]);
    let ses = (await w.call("p-meera", "GET", `/api/v1/work-orders/${id}/session`)).body;
    expect(ses.research.plan).toMatchObject({ status: "proposed", hosts: ["docs.nautobot.com", "blog.example.org"], budgetUsd: 3 });
    expect(ses.research.canDecide).toBe(true);
    // The factory allow-list has docs.nautobot.com only: a line lead may approve that host, not the other.
    expect((await w.call("p-asha", "PATCH", "/api/v1/security", { path: "researchHosts", value: ["docs.nautobot.com"] })).status).toBe(200);
    expect((await w.call("p-asha", "PATCH", "/api/v1/security", { path: "researchHosts", value: ["not a host"] })).status).toBe(422);
    expect((await w.call("p-rui", "POST", `/api/v1/work-orders/${id}/research-plan`, { decision: "approve" })).status).toBe(403);
    const unlisted = await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/research-plan`, { decision: "approve" });
    expect(unlisted.status).toBe(403);
    expect(unlisted.body.msg).toMatch(/blog\.example\.org is not on the factory's research allow-list/);
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/research-plan`, { decision: "reject" })).status).toBe(422);
    const ok = await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/research-plan`, { decision: "approve", hosts: ["docs.nautobot.com"], budgetUsd: 2, note: "Docs only." });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.resumed).toBe(true);
    wo = await w.get(id);
    expect(wo.bay).toBeNull();
    expect((await w.liveAttempt(id))!.station).toBe("research");
    expect(await researchHosts(t.db.app, t.orgId, await data())).toEqual(["docs.nautobot.com"]);
    ses = (await w.call("p-meera", "GET", `/api/v1/work-orders/${id}/session`)).body;
    expect(ses.research.plan).toMatchObject({ status: "approved", hosts: ["docs.nautobot.com"], budgetUsd: 2, decidedBy: "p-meera", note: "Docs only." });
    expect((await w.events("research.plan.decided")).some((e: { wo_id: string }) => e.wo_id === id)).toBe(true);

    // A page read through the edge is recorded as source s1, then s2; people read what the agent saw.
    const { recordSource } = await import("../src/areas/workorders/research.js");
    const a2 = (await w.liveAttempt(id))!;
    const rec = (n: number) => w.tx((tx) => recordSource(tx, { orgId: t.orgId, woId: id, station: "research", attemptId: a2.id, runId: `run-${n}`, agent: "ag-research", url: `https://docs.nautobot.com/p${n}`, finalUrl: `https://docs.nautobot.com/p${n}`, title: `Page ${n}`, httpStatus: 200, contentType: "text/html", contentHash: "b".repeat(64), size: 5, truncated: false, why: "retry", excerpt: `text ${n}` }));
    expect(await rec(1)).toBe("s1");
    expect(await rec(2)).toBe("s2");
    const list = (await w.call("p-tomas", "GET", `/api/v1/work-orders/${id}/sources`)).body.items;
    expect(list.map((x: { ref: string; host: string }) => `${x.ref}:${x.host}`)).toEqual(["s1:docs.nautobot.com", "s2:docs.nautobot.com"]);
    expect(list[0].excerpt).toBeUndefined();
    expect((await w.call("p-tomas", "GET", `/api/v1/work-orders/${id}/sources/s2`)).body).toMatchObject({ title: "Page 2", excerpt: "text 2" });
    expect((await w.call("p-fatima", "GET", `/api/v1/work-orders/${id}/sources`)).status).toBe(404);
    await w.call("p-asha", "PATCH", "/api/v1/security", { path: "researchHosts", value: [] });
  });

  it("the run timeline shows the steps, model calls, pages read, documents and the result of each run, and no transcript", async () => {
    const id = await w.atStation("research", "Timeline");
    const att = (await w.liveAttempt(id))!;
    const run = `run-tl-${att.id}`;
    await t.db.admin.query(`insert into runs (org_id, id, attempt_id, wo_id, state, model_id) values ($1,$2,$3,$4,'running','claude-test')`, [t.orgId, run, att.id, id]);
    await t.db.admin.query(`insert into checkpoints (org_id, id, run_id, attempt_id, seq, content_hash, data) values ($1,$2,$3,$4,1,$5,$6::jsonb)`, [t.orgId, `ck-${run}-1`, run, att.id, "e".repeat(64), JSON.stringify({ turn: 1, kind: "transcript", steps: [{ turn: 1, tool: "Read", detail: "src/jobs.py" }, { turn: 1, tool: "gantry:web_fetch", detail: "https://docs.nautobot.com/x" }] })]);
    await t.db.admin.query(`insert into run_usage (org_id, run_id, attempt_id, wo_id, model_id, input_tokens, output_tokens, cost_micros) values ($1,$2,$3,$4,'claude-test',100,50,12000)`, [t.orgId, run, att.id, id]);
    const r = await w.call("p-tomas", "GET", `/api/v1/work-orders/${id}/timeline`);
    expect(r.status).toBe(200);
    const tl = r.body.runs[0];
    expect(tl).toMatchObject({ runId: run, station: "research", state: "running", calls: 1, tokens: 150, costUsd: 0.012, model: "claude-test" });
    expect(tl.entries.map((e: { kind: string }) => e.kind)).toEqual(["start", "step", "step"]);
    expect(tl.entries[1]).toMatchObject({ tool: "Read", detail: "src/jobs.py" });
    expect((await w.call("p-fatima", "GET", `/api/v1/work-orders/${id}/timeline`)).status).toBe(404);
  });

  it("an approved plan's budget is enforced from the approval on, for its station only", async () => {
    const id = await w.atStation("research", "Plan budget");
    const att = (await w.liveAttempt(id))!;
    const decidedAt = Date.now() - 1000;
    await t.db.admin.query(`update work_orders set data = data || $2::jsonb where id = $1`, [id, JSON.stringify({ researchPlan: { status: "approved", questions: ["q"], hosts: ["docs.nautobot.com"], web: true, budgetUsd: 0.5, why: "w", station: "research", attempt: att.id, proposedAt: decidedAt, decidedBy: "p-meera", decidedAt } })]);
    const run = `run-pb-${att.id}`;
    await t.db.admin.query(`insert into runs (org_id, id, attempt_id, wo_id, state) values ($1,$2,$3,$4,'running')`, [t.orgId, run, att.id, id]);
    const { budgetBreach } = await import("../src/areas/internal/metering.js");
    const { loadRunCtx } = await import("../src/areas/internal/context.js");
    const ctx = (await loadRunCtx(t.db.app, t.orgId, run))!;
    // spend before the approval does not count
    await t.db.admin.query(`insert into run_usage (org_id, run_id, attempt_id, wo_id, model_id, cost_micros, at) values ($1,$2,$3,$4,'m',900000, now() - interval '1 hour')`, [t.orgId, run, att.id, id]);
    expect(await budgetBreach(t.db.app, ctx)).toBeNull();
    await t.db.admin.query(`insert into run_usage (org_id, run_id, attempt_id, wo_id, model_id, cost_micros) values ($1,$2,$3,$4,'m',600000)`, [t.orgId, run, att.id, id]);
    expect(await budgetBreach(t.db.app, ctx)).toMatchObject({ scope: "plan", limitMicros: 500000, spentMicros: 600000 });
  });

  it("scouts: a run sends scouts, each result goes to the swarm, a person may stop one, and the station runs again when all ended", async () => {
    const id = await w.atStation("research", "Scouts");
    const att = (await w.liveAttempt(id))!;
    // a web scout needs an approved plan with the web: refused, it becomes a question for a person
    const refused = await w.apply(att, { status: "needs_person", output: { scouts: [{ question: "What do the docs say about retries?", focus: "web" }] } });
    expect(refused).toMatchObject({ next: "person" });
    let dl = (await w.call("p-meera", "GET", `/api/v1/work-orders/${id}/dialogue`)).body;
    expect(dl.questions[0].question).toMatch(/approved research plan with the web/);
    await w.call("p-tomas", "POST", `/api/v1/work-orders/${id}/questions/${dl.questions[0].id}/answer`, { answer: "Use the repository only." });
    const att2 = (await w.liveAttempt(id))!;
    const r = await w.apply(att2, { status: "needs_person", output: { scouts: [{ question: "Where is retry implemented?", focus: "repo" }, { question: "Which tests cover the sync job?", focus: "repo" }, { question: "How are timeouts configured?", focus: "repo" }] } });
    expect(r).toMatchObject({ applied: true, next: "research" });
    let wo = await w.get(id);
    expect(wo.bay).toBeNull();
    expect(wo.state).toBe("running");
    const scouts = await w.q<{ id: string; fencing: string; data: { scout: { id: string; question: string } } }>(`select id, fencing::text, data from attempts where wo_id = $1 and data ? 'scout' order by visit`, [id]);
    expect(scouts.map((x) => x.data.scout.id)).toEqual(["A", "B", "C"]);
    const ses = (await w.call("p-meera", "GET", `/api/v1/work-orders/${id}/session`)).body;
    expect(ses.swarm.scouts.map((x: { state: string }) => x.state)).toEqual(["queued", "queued", "queued"]);
    // the scout's handoff names its own question
    const { applyScoutResult } = await import("../src/areas/workorders/swarm.js");
    expect(await w.tx((tx) => applyScoutResult(tx, scouts[0]!.id, Number(scouts[0]!.fencing), { status: "succeeded", summary: "Retry is in jobs.py.", output: { dialogue: { questions: [{ question: "Should retries be capped?", why: "Budget", blocking: true }] } } }))).toMatchObject({ applied: true, closed: false });
    expect((await w.call("p-rui", "POST", `/api/v1/work-orders/${id}/scouts/B/stop`, { reason: "Not needed" })).status).toBe(403);
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/scouts/B/stop`, { reason: "Not needed" })).status).toBe(200);
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/scouts/B/stop`, {})).status).toBe(409);
    // a scout's late result after it was stopped is ignored
    expect(await w.tx((tx) => applyScoutResult(tx, scouts[1]!.id, Number(scouts[1]!.fencing), { status: "succeeded", summary: "late", output: null }))).toMatchObject({ applied: false });
    const last = await w.tx((tx) => applyScoutResult(tx, scouts[2]!.id, Number(scouts[2]!.fencing), { status: "failed", summary: "", output: null, error: { msg: "harness crashed" } }));
    expect(last).toMatchObject({ applied: true, closed: true });
    const next = (await w.liveAttempt(id))!;
    expect(next.station).toBe("research");
    expect(scouts.map((x) => x.id)).not.toContain(next.id);
    wo = await w.get(id);
    expect(wo.state).toBe("running");
    const after = (await w.call("p-meera", "GET", `/api/v1/work-orders/${id}/session`)).body;
    expect(after.swarm.scouts.map((x: { id: string; state: string }) => `${x.id}:${x.state}`)).toEqual(["A:done", "B:stopped", "C:failed"]);
    dl = (await w.call("p-meera", "GET", `/api/v1/work-orders/${id}/dialogue`)).body;
    expect(dl.questions.find((q: { question: string }) => q.question === "Should retries be capped?").blocking).toBe(false);
    // the run after the swarm gets what each scout did
    const { loadRunCtx } = await import("../src/areas/internal/context.js");
    const { composeRunSpec } = await import("../src/areas/internal/spec.js");
    const run = `run-sw-${next.id}`;
    await t.db.admin.query(`insert into runs (org_id, id, attempt_id, wo_id, state, data) values ($1,$2,$3,$4,'running','{"adapter":"stub"}'::jsonb)`, [t.orgId, run, next.id, id]);
    const spec = await composeRunSpec(t.db.app, (await loadRunCtx(t.db.app, t.orgId, run))!, "http://edge") as { input: { scouts: Array<{ id: string; state: string; summary: string }> } };
    expect(spec.input.scouts.map((x) => `${x.id}:${x.state}`)).toEqual(["A:done", "B:stopped", "C:failed"]);
    expect(spec.input.scouts[0]!.summary).toBe("Retry is in jobs.py.");
  });

  it("objections: one agent objects to another's document; a person decides with a reason; the gate decision records what was open", async () => {
    const id = await w.atStation("research", "Objections");
    const att = (await w.liveAttempt(id))!;
    const { recordDocument } = await import("../src/areas/workorders/documents.js");
    await w.tx((tx) => recordDocument(tx, { orgId: t.orgId, id: `art-${att.id}-r`, woId: id, attemptId: att.id, station: "research", name: "research.md", hash: "f".repeat(64), mediaType: "text/markdown", size: 3, body: "# R", author: "ag-research" }));
    await w.apply(att);
    const spec = (await w.walk(id, (x: any) => x.state === "running" && x.station !== undefined && x.allowed !== undefined && !x.bay && x.history.at(-1)?.station === "spec"));
    void spec;
    const sAtt = (await w.liveAttempt(id))!;
    await w.apply(sAtt, { status: "succeeded", summary: "Spec written.", output: { dialogue: { objections: [
      { targetDoc: "research.md", section: "Findings", claim: "Jobs retry by default", reason: "The cited page says retries must be coded explicitly.", severity: "high" },
      { targetDoc: "spec.md", reason: "An agent cannot object to its own station's document.", severity: "low" },
      { targetDoc: "missing.md", reason: "There is no such document on this work order.", severity: "low" },
    ] } } });
    const dl = (await w.call("p-meera", "GET", `/api/v1/work-orders/${id}/dialogue`)).body;
    expect(dl.objections).toHaveLength(1);
    expect(dl.objections[0]).toMatchObject({ targetDoc: "research.md", targetStation: "research", station: "spec", severity: "high", status: "open" });
    const oid = dl.objections[0].id;
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/objections/${oid}`, { decision: "upheld" })).status).toBe(422);
    expect((await w.call("p-rui", "POST", `/api/v1/work-orders/${id}/objections/${oid}`, { decision: "upheld", note: "Right" })).status).toBe(403);
    const wo = await w.get(id);
    const gate = wo.allowed.approve?.gate;
    if (gate) {
      for (const who of w.APPROVERS) {
        const g = await w.call(who, "POST", `/api/v1/gate-instances/${encodeURIComponent(`${id}:${gate}`)}/approve`, {});
        if (g.status === 200) break;
      }
      const evs = (await w.events("gate.decision")).filter((e: { wo_id: string }) => e.wo_id === id);
      expect(evs.at(-1).after).toMatchObject({ openObjections: 1 });
    }
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/objections/${oid}`, { decision: "upheld", note: "The docs are explicit; research must be corrected." })).status).toBe(200);
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/objections/${oid}`, { decision: "overruled", note: "again" })).status).toBe(409);
    const { dialogueHandoff } = await import("../src/areas/workorders/documents.js");
    expect((await dialogueHandoff(t.db.app, t.orgId, id)).objections).toMatchObject([{ against: "research.md", status: "upheld", decisionNote: "The docs are explicit; research must be corrected." }]);
  });
});

