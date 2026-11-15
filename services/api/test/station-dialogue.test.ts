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
});

