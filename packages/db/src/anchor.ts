import { createHmac, timingSafeEqual } from "node:crypto";
import type { Queryable } from "./tx.js";
import { err, ok, type Result } from "./result.js";

/**
 * Signed checkpoints of the audit chain head. The chain's own hashes are unkeyed and its head lives in the same database, so whoever
 * owns the database (or restores a forged backup) can rewrite history and recompute every hash. A checkpoint is the head (seq, hash)
 * signed with a key the database never holds (HMAC-SHA256), written somewhere the database owner cannot reach (a separate volume,
 * a WORM bucket or a SIEM). Verification then requires every checkpoint to match the row now at its seq: a rewrite of anything up to
 * a checkpoint, or a truncation below it, is caught even when the chain is internally consistent.
 */
export interface Anchor {
  org: string;
  seq: number;
  hash: string;
  at: string;
  mac: string;
}

export type AnchorBreak =
  | { kind: "bad_mac"; seq: number }
  | { kind: "missing"; seq: number }
  | { kind: "rewritten"; seq: number };

const macOf = (key: Buffer, org: string, seq: number, hash: string, at: string): string =>
  createHmac("sha256", key).update(JSON.stringify(["gantry-audit-anchor", org, seq, hash, at])).digest("hex");

export const signAnchor = (key: Buffer, org: string, seq: number, hash: string, at: Date = new Date()): Anchor => {
  const a = at.toISOString();
  return { org, seq, hash, at: a, mac: macOf(key, org, seq, hash, a) };
};

const macValid = (key: Buffer, x: Anchor): boolean => {
  const want = Buffer.from(macOf(key, x.org, x.seq, x.hash, x.at), "hex");
  const got = Buffer.from(String(x.mac), "hex");
  return want.length === got.length && timingSafeEqual(want, got);
};

/** Signs the newest event row of the org (read from the log itself, not from the counter). Null while the log is empty. */
export async function signHead(db: Queryable, orgId: string, key: Buffer, now: Date = new Date()): Promise<Anchor | null> {
  const { rows } = await db.query<{ seq: string; hash: string }>(`select seq, hash from events where org_id = $1 order by seq desc limit 1`, [orgId]);
  return rows[0] ? signAnchor(key, orgId, Number(rows[0].seq), rows[0].hash, now) : null;
}

/** Every checkpoint for the org must carry a valid signature and match the event now stored at its seq. First break is returned. */
export async function verifyAnchors(db: Queryable, orgId: string, key: Buffer, anchors: Anchor[]): Promise<Result<{ checked: number; newestSeq: number }, AnchorBreak>> {
  const mine = anchors.filter((a) => a.org === orgId).sort((a, b) => a.seq - b.seq);
  for (const a of mine) if (!macValid(key, a)) return err({ kind: "bad_mac", seq: a.seq });
  if (!mine.length) return ok({ checked: 0, newestSeq: 0 });
  const { rows } = await db.query<{ seq: string; hash: string }>(`select seq, hash from events where org_id = $1 and seq = any($2::bigint[])`, [orgId, mine.map((a) => a.seq)]);
  const have = new Map(rows.map((r) => [Number(r.seq), r.hash]));
  for (const a of mine) {
    const h = have.get(a.seq);
    if (h === undefined) return err({ kind: "missing", seq: a.seq });
    if (h !== a.hash) return err({ kind: "rewritten", seq: a.seq });
  }
  return ok({ checked: mine.length, newestSeq: mine[mine.length - 1]!.seq });
}

/** One JSON object per line. Lines that are not checkpoints are skipped. */
export const parseAnchors = (text: string): Anchor[] =>
  text.split("\n").flatMap((l) => {
    if (!l.trim()) return [];
    try {
      const a = JSON.parse(l) as Anchor;
      return typeof a.org === "string" && Number.isInteger(a.seq) && typeof a.hash === "string" && typeof a.at === "string" && typeof a.mac === "string" ? [a] : [];
    } catch {
      return [];
    }
  });
