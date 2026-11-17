/**
 * People's side of the station documents: a comment on one section of a document, a direct edit (a new version in the person's name) and accepting
 * a version as the station's output. Each is attributed and audited, runs under the person's own rights (the route names the right) and leaves a
 * line in the work order's thread. Agents keep writing their own documents; a person's edit is one more version, and the next run starts from it.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Queryable, Tx } from "@gantry/db";
import type { Actor } from "../../core/command.js";
import { conflict, invalid, refuse } from "../../core/errors.js";
import { note, ev } from "./engine.js";
import { begin, done, person, type CmdResult } from "./ctx.js";
import { saveWo } from "./model.js";
import { readDocument, recordDocument } from "./documents.js";
import { addWoMessage } from "./session/store.js";

export interface DocCommentRow {
  id: string;
  artefactId: string;
  doc: string;
  version: number;
  section: string;
  body: string;
  author: string;
  status: "open" | "resolved";
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
}

const cRow = (r: Record<string, unknown>): DocCommentRow => ({
  id: String(r.id), artefactId: String(r.artefact_id), doc: String(r.doc), version: Number(r.version), section: String(r.section ?? ""), body: String(r.body), author: String(r.author),
  status: r.status as DocCommentRow["status"], resolvedBy: (r.resolved_by as string | null) ?? null, resolvedAt: r.resolved_at ? (r.resolved_at as Date).getTime() : null, createdAt: (r.created_at as Date).getTime(),
});

export async function listDocComments(db: Queryable, orgId: string, woId: string): Promise<DocCommentRow[]> {
  return (await db.query(`select * from wo_doc_comments where org_id = $1 and wo_id = $2 order by created_at, id`, [orgId, woId])).rows.map(cRow);
}

/** What the next run of the station is told: the comments nobody has resolved, with where they were made. */
export async function commentsHandoff(db: Queryable, orgId: string, woId: string): Promise<unknown[]> {
  return (await listDocComments(db, orgId, woId)).filter((c) => c.status === "open").map((c) => ({ document: c.doc, version: c.version, section: c.section || null, comment: c.body, by: c.author }));
}

const headingsOf = (md: string): string[] => {
  const out: string[] = [];
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    const m = !fence ? /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (m) out.push(m[1]!.replace(/[`*_~]/g, "").trim());
  }
  return out;
};

/** The same key shapes the edge redacts from agent documents: a person's text is checked before it is stored, and refused rather than silently changed. */
const SECRET_SHAPES: Array<[string, RegExp]> = [
  ["a private key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ["an API key", /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})/],
  ["a cloud access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a bearer token", /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{24,}/],
  ["a signed token", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["a password in a link", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{4,}@[^\s/]+/i],
];
const refuseSecrets = (text: string): void => {
  const hit = SECRET_SHAPES.find(([, re]) => re.test(text));
  if (hit) throw invalid(`The text looks like it contains ${hit[0]}. Remove it, and refer to it by name instead.`);
};

const MAX_DOC = 200_000;
const docCard = (d: { id: string; name: string; version: number }) => ({ kind: "document", id: d.id, name: d.name, version: d.version }) as never;

export async function commentOnDocument(tx: Tx, actor: Actor, woId: string, artefactId: string, b: { section?: string; text: string }): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.answer");
  const by = person(actor, "Commenting is");
  const d = await readDocument(tx, fx.orgId, w.id, artefactId);
  if (!d) throw refuse("not_found", "No such document on this work order.");
  const text = b.text.trim();
  if (text.length < 1) throw invalid("Write the comment.");
  const section = (b.section ?? "").replace(/[`*_~]/g, "").trim();
  if (section && !headingsOf(d.body ?? "").includes(section)) throw invalid("That section is not in this version of the document.");
  const id = `DC-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await tx.query(`insert into wo_doc_comments (org_id, id, wo_id, artefact_id, doc, version, section, body, author, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [fx.orgId, id, w.id, d.id, d.doc, d.version, section, text, by, fx.now]);
  const where = section ? `${d.doc}, “${section}”` : d.doc;
  await addWoMessage(tx, fx.orgId, w.id, "user", by, `Comment on ${where}: ${text}`, { kind: "answer", cards: [docCard({ id: d.id, name: d.doc, version: d.version })] }, fx.now);
  ev(fx, w, "document.comment", { doc: d.doc, version: d.version, section, comment: id, text: text.slice(0, 200) });
  note(w, fx, by, `Commented on ${where}.`);
  await saveWo(tx, fx.orgId, w);
  return done(fx, "Comment added. The agent reads open comments the next time the station runs.", w.project, { id, version: w.version });
}

export async function resolveDocComment(tx: Tx, actor: Actor, woId: string, commentId: string): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.answer");
  const by = person(actor, "Resolving a comment is");
  const c = (await tx.query(`select * from wo_doc_comments where org_id = $1 and wo_id = $2 and id = $3 for update`, [fx.orgId, w.id, commentId])).rows[0];
  if (!c) throw refuse("not_found", "No such comment on this work order.");
  if (c.status !== "open") throw conflict("That comment was already resolved.");
  await tx.query(`update wo_doc_comments set status = 'resolved', resolved_by = $4, resolved_at = $5 where org_id = $1 and wo_id = $2 and id = $3`, [fx.orgId, w.id, commentId, by, fx.now]);
  ev(fx, w, "document.comment.resolved", { doc: c.doc, comment: commentId, by });
  await saveWo(tx, fx.orgId, w);
  return done(fx, "Comment resolved.", w.project, { version: w.version });
}

/** A person's edit is the next version of the document, written by them. Only the newest version can be edited, so nobody overwrites a newer agent run. */
export async function editDocument(tx: Tx, actor: Actor, woId: string, artefactId: string, b: { markdown: string; note?: string }): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "gate.approve");
  const by = person(actor, "Editing a document is");
  const base = await readDocument(tx, fx.orgId, w.id, artefactId);
  if (!base) throw refuse("not_found", "No such document on this work order.");
  const latest = (await tx.query<{ version: number }>(`select max(version) as version from artefacts where org_id = $1 and wo_id = $2 and doc = $3`, [fx.orgId, w.id, base.doc])).rows[0]!.version;
  if (Number(latest) !== base.version) throw conflict(`There is a newer version of ${base.doc} (version ${latest}). Open it and edit that one.`);
  const body = b.markdown.replace(/\r\n/g, "\n");
  if (!body.trim()) throw invalid("A document cannot be empty.");
  if (body.length > MAX_DOC) throw invalid(`A document can be at most ${MAX_DOC.toLocaleString("en-US")} characters.`);
  if (body === (base.body ?? "")) throw invalid("Nothing changed in the text.");
  refuseSecrets(body);
  const hash = createHash("sha256").update(body).digest("hex");
  const id = `art-ed-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const { version } = await recordDocument(tx, { orgId: fx.orgId, id, woId: w.id, attemptId: null, station: base.station ?? "", name: base.doc, hash, mediaType: "text/markdown", size: Buffer.byteLength(body), body, author: by, authorKind: "person" });
  const why = (b.note ?? "").trim().slice(0, 500);
  await addWoMessage(tx, fx.orgId, w.id, "user", by, `Edited ${base.doc} (now version ${version})${why ? `: ${why}` : "."}`, { kind: "answer", cards: [docCard({ id, name: base.doc, version })] }, fx.now);
  ev(fx, w, "document.edit", { doc: base.doc, version, from: base.version, hash, ...(why ? { text: why } : {}) }, { category: "approvals" });
  note(w, fx, by, `Edited ${base.doc} (version ${version}).`);
  await saveWo(tx, fx.orgId, w);
  return done(fx, `Saved as version ${version}. It is marked as edited by you, and the gate shows that.`, w.project, { id, doc: base.doc, documentVersion: version, version: w.version });
}

/** A person accepts one version of a document as what the station produced. One version per document is accepted at a time. */
export async function acceptDocument(tx: Tx, actor: Actor, woId: string, artefactId: string): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "gate.approve");
  const by = person(actor, "Accepting a document is");
  const d = await readDocument(tx, fx.orgId, w.id, artefactId);
  if (!d) throw refuse("not_found", "No such document on this work order.");
  if (d.acceptedBy) throw conflict(`Version ${d.version} of ${d.doc} is already accepted.`);
  await tx.query(`update artefacts set accepted_by = null, accepted_at = null where org_id = $1 and wo_id = $2 and doc = $3 and accepted_by is not null`, [fx.orgId, w.id, d.doc]);
  await tx.query(`update artefacts set accepted_by = $4, accepted_at = $5 where org_id = $1 and wo_id = $2 and id = $3`, [fx.orgId, w.id, d.id, by, fx.now]);
  await addWoMessage(tx, fx.orgId, w.id, "user", by, `Accepted ${d.doc} version ${d.version} as the ${d.station ?? "station"} output.`, { kind: "answer", cards: [docCard({ id: d.id, name: d.doc, version: d.version })] }, fx.now);
  ev(fx, w, "document.accept", { doc: d.doc, version: d.version, hash: d.contentHash, station: d.station, authorKind: d.authorKind }, { category: "approvals" });
  note(w, fx, by, `Accepted ${d.doc} version ${d.version} as station output.`);
  await saveWo(tx, fx.orgId, w);
  return done(fx, `Version ${d.version} of ${d.doc} is accepted as the station output.`, w.project, { id: d.id, version: w.version });
}
