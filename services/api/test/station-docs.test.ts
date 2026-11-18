import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { briefMarkdown, documentFromResult } from "../src/areas/workorders/station-docs.js";

describe("document rendering", () => {
  it("renders the agent's own fields and Gantry's observed facts, and says it was recorded from the result", () => {
    const md = documentFromResult("Build", { status: "succeeded", summary: "Added the zero case.", output: { files: [{ path: "a.py", step: 1 }], notes: ["Tests not run"], documents: ["x"], dialogue: {} }, observed: { headSha: "abc123", files: [{ path: "a.py", additions: 3, deletions: 1 }] } });
    expect(md).toContain("# Build");
    expect(md).toContain("Recorded by Gantry from this run's structured result");
    expect(md).toContain("Added the zero case.");
    expect(md).toContain("## Files");
    expect(md).toContain("path: a.py");
    expect(md).toContain("- Tests not run");
    expect(md).not.toContain("## Dialogue");
    expect(md).toContain("Head commit: abc123");
    expect(md).toContain("File: a.py (+3 −1)");
  });
  it("renders a confirmed brief", () => {
    const md = briefMarkdown({ goal: "Report secrets groups", ac: ["Lists devices"], scopeIn: ["jobs"], note: "ok" }, { version: 2, cls: "feature", route: ["Spec", "Build"], by: "Tomas" });
    expect(md).toContain("# Brief (version 2)");
    expect(md).toContain("Spec → Build");
    expect(md).toContain("## Acceptance criteria");
    expect(md).toContain("- Lists devices");
  });
});

const d = TEST_URL ? describe : describe.skip;
d("every station leaves a document", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);

  it("confirming the brief stores brief.md, versioned, recorded by Gantry from the confirmed brief", async () => {
    const id = await w.atStation("research", "Brief document");
    const rows = await w.q<{ doc: string; version: number; station: string; author_kind: string; author_id: string; body: string }>(`select doc, version, station, author_kind, author_id, body from artefacts where wo_id = $1 and doc = 'brief.md' order by version`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1, station: "intake", author_kind: "system" });
    expect(rows[0]!.body).toContain("# Brief (version 1)");
  });

  it("a succeeded run that wrote no document is recorded from its result (the WO-1006 research gap); one that wrote its own is left alone", async () => {
    const id = await w.atStation("spec", "No spec doc");
    const att = (await w.liveAttempt(id))!;
    const r = await w.apply(att, { status: "succeeded", summary: "Spec ready.", output: { acceptanceCriteria: ["Zero case says every device has a group"], scopeOut: ["UI"] } });
    expect(r.applied).toBe(true);
    const docs = await w.q<{ doc: string; author_kind: string; body: string }>(`select doc, author_kind, body from artefacts where wo_id = $1 and doc = 'spec.md'`, [id]);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ author_kind: "system" });
    expect(docs[0]!.body).toContain("Zero case says every device has a group");

    const id2 = await w.atStation("spec", "Own spec doc");
    const a2 = (await w.liveAttempt(id2))!;
    await w.q(`insert into artefacts (org_id, id, wo_id, attempt_id, kind, name, content_hash, media_type, size_bytes, station, doc, version, author_kind, author_id, body) values ($1,$2,$3,$4,'document','spec.md','0000000000000000000000000000000000000000000000000000000000000000','text/markdown',3,'spec','spec.md',1,'agent','ag-spec','# mine')`, [t.orgId, `art-${a2.id}-own`, id2, a2.id]);
    await w.apply(a2, { status: "succeeded", summary: "ok", output: { acceptanceCriteria: [] } });
    const own = await w.q<{ version: number; author_kind: string }>(`select version, author_kind from artefacts where wo_id = $1 and doc = 'spec.md'`, [id2]);
    expect(own).toEqual([{ version: 1, author_kind: "agent" }]);
  });

  it("Build, which stores no document of its own, gets build.md from its result and the observed files", async () => {
    const id = await w.atStation("build", "Build document");
    const att = (await w.liveAttempt(id))!;
    await w.apply(att, { status: "succeeded", summary: "Implemented step 1.", output: { files: [{ path: "src/x.py", step: 1 }], notes: ["Deviated: kept the old helper"] }, observed: { headSha: "d".repeat(40), files: [{ path: "src/x.py", additions: 4, deletions: 0 }] } });
    const [row] = await w.q<{ body: string; station: string }>(`select body, station from artefacts where wo_id = $1 and doc = 'build.md'`, [id]);
    expect(row?.station).toBe("build");
    expect(row!.body).toContain("Deviated: kept the old helper");
    expect(row!.body).toContain("File: src/x.py (+4 −0)");
  });
});
