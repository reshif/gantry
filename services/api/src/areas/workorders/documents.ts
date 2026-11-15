/**
 * Station documents and the dialogue log (agent workspace, Phase 1).
 *
 * Documents: each station run hands over the markdown documents its agent wrote (`write_document`); each becomes the next version of that
 * document on the work order, with who wrote it and which version it supersedes. The text is the edge's scanned copy.
 *
 * Dialogue: the questions a station agent asked (`ask`) and the assumptions it proceeded on (`assume`). They are first-class rows, answered and
 * decided by people with attribution, and they travel with the station handoff so a later station does not ask again what was settled.
 */
import type { Queryable, Tx } from "@gantry/db";

export interface DocumentRow {
  id: string;
  doc: string;
  station: string | null;
  version: number;
  supersedes: string | null;
  authorKind: "agent" | "person" | "system";
  authorId: string | null;
  attemptId: string | null;
  size: number;
  contentHash: string;
  createdAt: number;
  acceptedBy: string | null;
  body?: string;
}

export interface QuestionRow {
  id: string;
  station: string;
  attemptId: string | null;
  askedBy: string;
  question: string;
  why: string;
  options: string[];
  blocking: boolean;
  askOf: string;
  status: "open" | "answered" | "dismissed";
  answer: string | null;
  answerKind: "answer" | "dont_know" | "not_relevant" | null;
  answeredBy: string | null;
  answeredAt: number | null;
  createdAt: number;
}

export interface AssumptionRow {
  id: string;
  station: string;
  attemptId: string | null;
  madeBy: string;
  statement: string;
  because: string;
  impact: "low" | "medium" | "high";
  status: "open" | "confirmed" | "corrected";
  note: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
}

/** A station run's document: the next version of its name on this work order. */
export async function recordDocument(
  tx: Tx,
  d: { orgId: string; id: string; woId: string; attemptId: string | null; station: string; name: string; hash: string; mediaType: string; size: number; body: string; author: string | null; authorKind?: "agent" | "person" },
): Promise<{ id: string; version: number }> {
  // One writer at a time per document name: the advisory lock makes "max + 1" safe without a sequence per document.
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`doc:${d.orgId}:${d.woId}:${d.name}`]);
  const prev = (await tx.query<{ id: string; version: number }>(`select id, version from artefacts where org_id = $1 and wo_id = $2 and doc = $3 order by version desc limit 1`, [d.orgId, d.woId, d.name])).rows[0];
  const version = (prev?.version ?? 0) + 1;
  await tx.query(
    `insert into artefacts (org_id, id, wo_id, attempt_id, kind, name, content_hash, media_type, size_bytes, station, doc, version, supersedes, author_kind, author_id, body)
     values ($1,$2,$3,$4,'document',$5,$6,$7,$8,$9,$5,$10,$11,$12,$13,$14)`,
    [d.orgId, d.id, d.woId, d.attemptId, d.name, d.hash, d.mediaType, d.size, d.station, version, prev?.id ?? null, d.authorKind ?? "agent", d.author, d.body],
  );
  return { id: d.id, version };
}

const docRow = (r: Record<string, unknown>, withBody: boolean): DocumentRow => ({
  id: String(r.id), doc: String(r.doc), station: (r.station as string | null) ?? null, version: Number(r.version), supersedes: (r.supersedes as string | null) ?? null,
  authorKind: r.author_kind as DocumentRow["authorKind"], authorId: (r.author_id as string | null) ?? null, attemptId: (r.attempt_id as string | null) ?? null,
  size: Number(r.size_bytes), contentHash: String(r.content_hash), createdAt: (r.created_at as Date).getTime(), acceptedBy: (r.accepted_by as string | null) ?? null,
  ...(withBody ? { body: String(r.body ?? "") } : {}),
});

/** Every version of every document on the work order (no bodies), oldest first. */
export async function listDocuments(db: Queryable, orgId: string, woId: string): Promise<DocumentRow[]> {
  const { rows } = await db.query(
    `select id, doc, station, version, supersedes, author_kind, author_id, attempt_id, size_bytes, content_hash, created_at, accepted_by from artefacts where org_id = $1 and wo_id = $2 and doc is not null order by created_at, doc, version`,
    [orgId, woId],
  );
  return rows.map((r) => docRow(r, false));
}

export async function readDocument(db: Queryable, orgId: string, woId: string, id: string): Promise<DocumentRow | null> {
  const { rows } = await db.query(
    `select id, doc, station, version, supersedes, author_kind, author_id, attempt_id, size_bytes, content_hash, created_at, accepted_by, body from artefacts where org_id = $1 and wo_id = $2 and id = $3 and doc is not null`,
    [orgId, woId, id],
  );
  return rows[0] ? docRow(rows[0], true) : null;
}

/** The latest version of each document, with its text, for the station handoff. Bodies are capped so a handoff stays a handoff. */
export async function latestDocuments(db: Queryable, orgId: string, woId: string, o: { exceptAttempt?: string; perDoc?: number; total?: number } = {}): Promise<Array<{ name: string; station: string | null; version: number; markdown: string; truncated: boolean }>> {
  const { rows } = await db.query<{ doc: string; station: string | null; version: number; body: string | null }>(
    `select distinct on (doc) doc, station, version, body from artefacts where org_id = $1 and wo_id = $2 and doc is not null and ($3::text is null or attempt_id is distinct from $3) order by doc, version desc`,
    [orgId, woId, o.exceptAttempt ?? null],
  );
  const perDoc = o.perDoc ?? 40_000;
  let left = o.total ?? 160_000;
  const out: Array<{ name: string; station: string | null; version: number; markdown: string; truncated: boolean }> = [];
  for (const r of rows) {
    const text = r.body ?? "";
    const take = Math.max(0, Math.min(perDoc, left, text.length));
    left -= take;
    out.push({ name: r.doc, station: r.station, version: r.version, markdown: text.slice(0, take), truncated: take < text.length });
  }
  return out;
}

const qRow = (r: Record<string, unknown>): QuestionRow => ({
  id: String(r.id), station: String(r.station), attemptId: (r.attempt_id as string | null) ?? null, askedBy: String(r.asked_by), question: String(r.question), why: String(r.why ?? ""),
  options: Array.isArray(r.options) ? (r.options as unknown[]).map(String) : [], blocking: r.blocking === true, askOf: String(r.ask_of), status: r.status as QuestionRow["status"],
  answer: (r.answer as string | null) ?? null, answerKind: (r.answer_kind as QuestionRow["answerKind"]) ?? null, answeredBy: (r.answered_by as string | null) ?? null,
  answeredAt: r.answered_at ? (r.answered_at as Date).getTime() : null, createdAt: (r.created_at as Date).getTime(),
});
const aRow = (r: Record<string, unknown>): AssumptionRow => ({
  id: String(r.id), station: String(r.station), attemptId: (r.attempt_id as string | null) ?? null, madeBy: String(r.made_by), statement: String(r.statement), because: String(r.because ?? ""),
  impact: r.impact as AssumptionRow["impact"], status: r.status as AssumptionRow["status"], note: (r.note as string | null) ?? null, decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: r.decided_at ? (r.decided_at as Date).getTime() : null, createdAt: (r.created_at as Date).getTime(),
});

export interface ObjectionRow {
  id: string; station: string; attemptId: string | null; raisedBy: string; targetDoc: string; targetStation: string | null; section: string; claim: string; reason: string;
  severity: "low" | "medium" | "high"; status: "open" | "upheld" | "overruled"; note: string | null; decidedBy: string | null; decidedAt: number | null; createdAt: number;
}
const oRow = (r: Record<string, unknown>): ObjectionRow => ({
  id: String(r.id), station: String(r.station), attemptId: (r.attempt_id as string | null) ?? null, raisedBy: String(r.raised_by), targetDoc: String(r.target_doc), targetStation: (r.target_station as string | null) ?? null,
  section: String(r.section ?? ""), claim: String(r.claim ?? ""), reason: String(r.reason), severity: r.severity as ObjectionRow["severity"], status: r.status as ObjectionRow["status"],
  note: (r.note as string | null) ?? null, decidedBy: (r.decided_by as string | null) ?? null, decidedAt: r.decided_at ? (r.decided_at as Date).getTime() : null, createdAt: (r.created_at as Date).getTime(),
});

export async function listDialogue(db: Queryable, orgId: string, woId: string): Promise<{ questions: QuestionRow[]; assumptions: AssumptionRow[]; objections: ObjectionRow[] }> {
  const q = await db.query(`select * from wo_questions where org_id = $1 and wo_id = $2 order by created_at, id`, [orgId, woId]);
  const a = await db.query(`select * from wo_assumptions where org_id = $1 and wo_id = $2 order by created_at, id`, [orgId, woId]);
  const o = await db.query(`select * from wo_objections where org_id = $1 and wo_id = $2 order by created_at, id`, [orgId, woId]);
  return { questions: q.rows.map(qRow), assumptions: a.rows.map(aRow), objections: o.rows.map(oRow) };
}

export async function lockObjection(tx: Tx, orgId: string, woId: string, id: string): Promise<ObjectionRow | null> {
  const r = (await tx.query(`select * from wo_objections where org_id = $1 and wo_id = $2 and id = $3 for update`, [orgId, woId, id])).rows[0];
  return r ? oRow(r) : null;
}

export async function lockQuestion(tx: Tx, orgId: string, woId: string, id: string): Promise<QuestionRow | null> {
  const r = (await tx.query(`select * from wo_questions where org_id = $1 and wo_id = $2 and id = $3 for update`, [orgId, woId, id])).rows[0];
  return r ? qRow(r) : null;
}
export async function lockAssumption(tx: Tx, orgId: string, woId: string, id: string): Promise<AssumptionRow | null> {
  const r = (await tx.query(`select * from wo_assumptions where org_id = $1 and wo_id = $2 and id = $3 for update`, [orgId, woId, id])).rows[0];
  return r ? aRow(r) : null;
}

const s = (v: unknown, n: number): string => (typeof v === "string" ? v.trim().slice(0, n) : "");
const ASK_OF = /^(requester|approvers|anyone|role:[a-z0-9_]{1,40})$/;

/**
 * Records what a station run asked and assumed (its `output.dialogue`, from the runner's station tools). The rails are re-checked here: the runner
 * is not trusted to have enforced them. Returns the new questions, so the caller can tell whether any blocks.
 */
export async function recordDialogue(tx: Tx, d: { orgId: string; woId: string; station: string; attemptId: string; agent: string; dialogue: unknown; now: Date }): Promise<{ questions: QuestionRow[]; assumptions: number }> {
  const dl = (d.dialogue && typeof d.dialogue === "object" ? d.dialogue : {}) as { questions?: unknown; assumptions?: unknown };
  const qs = (Array.isArray(dl.questions) ? dl.questions : []).slice(0, 6);
  const os = (Array.isArray((dl as { objections?: unknown }).objections) ? ((dl as { objections: unknown[] }).objections) : []).slice(0, 3);
  let k = 0;
  for (const raw of os) {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const target = s(o.targetDoc, 130).toLowerCase();
    const reason = s(o.reason, 1200);
    if (!target || reason.length < 10) continue;
    // The document must exist on this work order, written by another station: an agent objects to someone else's work, not to its own.
    const doc = (await tx.query<{ station: string | null }>(`select station from artefacts where org_id = $1 and wo_id = $2 and doc = $3 order by version desc limit 1`, [d.orgId, d.woId, target])).rows[0];
    if (!doc || doc.station === d.station) continue;
    const sev = o.severity === "low" || o.severity === "high" ? o.severity : "medium";
    await tx.query(
      `insert into wo_objections (org_id, id, wo_id, station, attempt_id, raised_by, target_doc, target_station, section, claim, reason, severity, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) on conflict (org_id, id) do nothing`,
      [d.orgId, `O-${d.attemptId}-${++k}`, d.woId, d.station, d.attemptId, d.agent, target, doc.station, s(o.section, 200), s(o.claim, 600), reason, sev, d.now],
    );
  }
  const as = (Array.isArray(dl.assumptions) ? dl.assumptions : []).slice(0, 30);
  const out: QuestionRow[] = [];
  let i = 0;
  for (const raw of qs) {
    const q = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const text = s(q.question, 1200);
    if (text.length < 5) continue;
    const askOf = ASK_OF.test(s(q.askOf, 60)) ? s(q.askOf, 60) : "requester";
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => s(o, 160)).filter(Boolean).slice(0, 5);
    const id = `Q-${d.attemptId}-${++i}`;
    const r = await tx.query(
      `insert into wo_questions (org_id, id, wo_id, station, attempt_id, asked_by, question, why, options, blocking, ask_of, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$12)
       on conflict (org_id, id) do nothing returning *`,
      [d.orgId, id, d.woId, d.station, d.attemptId, d.agent, text, s(q.why, 1200), JSON.stringify(options), q.blocking === true, askOf, d.now],
    );
    if (r.rows[0]) out.push(qRow(r.rows[0]));
  }
  let n = 0;
  for (const raw of as) {
    const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const st = s(a.statement, 1200);
    if (st.length < 5) continue;
    const impact = a.impact === "low" || a.impact === "high" ? a.impact : "medium";
    const r = await tx.query(
      `insert into wo_assumptions (org_id, id, wo_id, station, attempt_id, made_by, statement, because, impact, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) on conflict (org_id, id) do nothing`,
      [d.orgId, `A-${d.attemptId}-${++n}`, d.woId, d.station, d.attemptId, d.agent, st, s(a.because, 1200), impact, d.now],
    );
    void r;
  }
  return { questions: out, assumptions: n };
}

/** The dialogue as a later station receives it: what was asked and answered, and the assumptions with their status. */
export async function dialogueHandoff(db: Queryable, orgId: string, woId: string): Promise<{ questions: unknown[]; assumptions: unknown[]; objections: unknown[] }> {
  const { questions, assumptions, objections } = await listDialogue(db, orgId, woId);
  return {
    questions: questions.map((q) => ({ station: q.station, question: q.question, why: q.why, status: q.status, ...(q.answer !== null ? { answer: q.answer, answerKind: q.answerKind, answeredBy: q.answeredBy } : {}) })),
    assumptions: assumptions.map((a) => ({ station: a.station, statement: a.statement, because: a.because, impact: a.impact, status: a.status, ...(a.note ? { correction: a.note } : {}) })),
    objections: objections.map((o) => ({ raisedAt: o.station, against: o.targetDoc, section: o.section, claim: o.claim, reason: o.reason, severity: o.severity, status: o.status, ...(o.note ? { decisionNote: o.note } : {}) })),
  };
}
