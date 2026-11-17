import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

/** Station documents, people's side: comments on a section, a direct edit, accepting a version as the station output. */
d("document collaboration", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const BODY = "# Research\n\nIntro.\n\n## Findings\n\nThe retry module upserts.\n\n```\n## not a heading\n```\n\n## Open questions\n\nNone.";
  const seed = async (title: string, body = BODY) => {
    const { recordDocument } = await import("../src/areas/workorders/documents.js");
    const id = await w.atStation("research", title);
    const att = (await w.liveAttempt(id))!;
    const hash = (await import("node:crypto")).createHash("sha256").update(body).digest("hex");
    const r = await w.tx((tx) => recordDocument(tx, { orgId: t.orgId, id: `art-${att.id}-r`, woId: id, attemptId: att.id, station: "research", name: "research.md", hash, mediaType: "text/markdown", size: body.length, body, author: "ag-research" }));
    return { id, art: r.id };
  };
  const url = (id: string, art: string, tail: string) => `/api/v1/work-orders/${id}/documents/${art}/${tail}`;

  it("a comment is pinned to a section of one version, attributed, audited, in the thread and handed to the next run", async () => {
    const { id, art } = await seed("Comment path");
    const ok = await w.call("p-tomas", "POST", url(id, art, "comments"), { section: "Findings", text: "Which retry module? Name the file." });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // The whole document needs no section; a heading inside a code fence is not a section; an unknown section is refused.
    expect((await w.call("p-tomas", "POST", url(id, art, "comments"), { text: "Overall: good." })).status).toBe(200);
    expect((await w.call("p-tomas", "POST", url(id, art, "comments"), { section: "not a heading", text: "x" })).status).toBe(422);
    expect((await w.call("p-tomas", "POST", url(id, art, "comments"), { section: "Nowhere", text: "x" })).status).toBe(422);
    expect((await w.call("p-tomas", "POST", url(id, art, "comments"), { text: "   " })).status).toBe(422);
    // Someone who cannot see the work order gets a 404, nothing is stored.
    expect((await w.call("p-fatima", "POST", url(id, art, "comments"), { text: "hi" })).status).toBe(404);

    const list = (await w.call("p-meera", "GET", `/api/v1/work-orders/${id}/document-comments`)).body.items as Array<{ id: string; section: string; version: number; author: string; status: string }>;
    expect(list).toMatchObject([{ section: "Findings", version: 1, author: "p-tomas", status: "open" }, { section: "", version: 1, author: "p-tomas", status: "open" }]);
    expect((await w.events("document.comment")).filter((e: { wo_id: string }) => e.wo_id === id)).toHaveLength(2);
    const msgs = await w.q<{ body: string; author: string; data: { cards: Array<{ kind: string; name: string }> } }>(`select body, author, data from workorder_messages where wo_id = $1 and role = 'user' order by created_at`, [id]);
    expect(msgs[0]).toMatchObject({ author: "p-tomas", body: "Comment on research.md, “Findings”: Which retry module? Name the file." });
    expect(msgs[0]!.data.cards[0]).toMatchObject({ kind: "document", name: "research.md" });

    const { commentsHandoff } = await import("../src/areas/workorders/doccollab.js");
    expect(await commentsHandoff(t.db.app, t.orgId, id)).toMatchObject([{ document: "research.md", section: "Findings", comment: "Which retry module? Name the file.", by: "p-tomas" }, { section: null }]);
    // Resolving takes a comment out of the handoff, once.
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/document-comments/${list[0]!.id}/resolve`, {})).status).toBe(200);
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/document-comments/${list[0]!.id}/resolve`, {})).status).toBe(409);
    expect(await commentsHandoff(t.db.app, t.orgId, id)).toHaveLength(1);
  });

  it("a person's edit is the next version in their name, audited, refused for secrets and for a stale base", async () => {
    const { id, art } = await seed("Edit path");
    // Editing is the approvers' right: the requester alone may comment but not rewrite the agent's document.
    const denied = await w.call("p-tomas", "POST", url(id, art, "edit"), { markdown: "# Mine" });
    expect(denied.status).toBe(403);
    expect((await w.events("gate.approve.denied")).filter((e: { wo_id: string }) => e.wo_id === id)).toHaveLength(1);

    const edited = "# Research\n\nIntro, corrected.\n\n## Findings\n\nThe retry module upserts (checked by hand).";
    const ok = await w.call("p-meera", "POST", url(id, art, "edit"), { markdown: edited, note: "Fixed the finding." });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ doc: "research.md", documentVersion: 2 });
    const one = (await w.call("p-tomas", "GET", `/api/v1/work-orders/${id}/documents/${ok.body.id}`)).body;
    expect(one).toMatchObject({ version: 2, supersedes: art, authorKind: "person", authorId: "p-meera", body: edited, acceptedBy: null });
    expect((await w.events("document.edit")).filter((e: { wo_id: string }) => e.wo_id === id)).toHaveLength(1);
    // The old version cannot be edited any more (a newer one exists), an empty or unchanged text is refused.
    expect((await w.call("p-meera", "POST", url(id, art, "edit"), { markdown: edited + "\nmore" })).status).toBe(409);
    expect((await w.call("p-meera", "POST", url(id, ok.body.id, "edit"), { markdown: edited })).status).toBe(422);
    expect((await w.call("p-meera", "POST", url(id, ok.body.id, "edit"), { markdown: "  \n " })).status).toBe(422);
    const secret = await w.call("p-meera", "POST", url(id, ok.body.id, "edit"), { markdown: `${edited}\n\nkey: sk-ant-${"a".repeat(30)}` });
    expect(secret.status).toBe(422);
    expect(secret.body.error?.message ?? JSON.stringify(secret.body)).toContain("API key");
    // The next station run is handed the person's version and told a person wrote it.
    const { latestDocuments } = await import("../src/areas/workorders/documents.js");
    expect(await latestDocuments(t.db.app, t.orgId, id)).toMatchObject([{ name: "research.md", version: 2, markdown: edited, editedByPerson: true }]);
    // The gate decision later records which documents a person edited.
    const { editedByPeople } = await import("../src/areas/workorders/documents.js");
    expect(await editedByPeople(t.db.app, t.orgId, id)).toEqual([{ doc: "research.md", version: 2, by: "p-meera" }]);
  });

  it("accepting a version as the station output is an approver's act, attributed, audited, one per document", async () => {
    const { id, art } = await seed("Accept path");
    expect((await w.call("p-tomas", "POST", url(id, art, "accept"), {})).status).toBe(403);
    const ok = await w.call("p-meera", "POST", url(id, art, "accept"), {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await w.call("p-meera", "POST", url(id, art, "accept"), {})).status).toBe(409);
    const ev = (await w.events("document.accept")).filter((e: { wo_id: string }) => e.wo_id === id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor: "p-meera" });
    expect(ev[0].after).toMatchObject({ doc: "research.md", version: 1, authorKind: "agent" });
    expect(ev[0].after.hash).toMatch(/^[0-9a-f]{64}$/);
    const one = (await w.call("p-tomas", "GET", `/api/v1/work-orders/${id}/documents/${art}`)).body;
    expect(one).toMatchObject({ acceptedBy: "p-meera" });
    expect(typeof one.acceptedAt).toBe("number");
    // A newer version is accepted instead: only one version of a document holds the acceptance.
    const e2 = await w.call("p-meera", "POST", url(id, art, "edit"), { markdown: "# Research\n\nRewritten." });
    expect((await w.call("p-meera", "POST", url(id, e2.body.id, "accept"), {})).status).toBe(200);
    const accepted = await w.q<{ id: string }>(`select id from artefacts where wo_id = $1 and accepted_by is not null`, [id]);
    expect(accepted.map((r) => r.id)).toEqual([e2.body.id]);
    expect((await w.call("p-meera", "POST", url(id, "no-such", "accept"), {})).status).toBe(404);
    expect((await w.call("p-fatima", "POST", url(id, art, "accept"), {})).status).toBe(404);
  });
});
