import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseAnchors, signHead, verifyAnchors, type AnchorBreak, type Queryable } from "@gantry/db";
import type { FastifyInstance } from "fastify";
import { deriveKey } from "./config.js";

/**
 * Signed checkpoints of the audit chain head (see @gantry/db anchor.ts), written to GANTRY_AUDIT_ANCHOR_FILE on a volume the database
 * and its owner role cannot write. The key is derived from the session key, which the database never holds. Off when no file is set.
 */
export const anchorKeyFor = (sessionKey: Buffer): Buffer => deriveKey(sessionKey, "audit-anchor");

export async function writeAnchor(db: Queryable, orgId: string, file: string, key: Buffer): Promise<number | null> {
  const a = await signHead(db, orgId, key);
  if (!a) return null;
  // Same head as the last line: nothing new to attest.
  const last = parseAnchors(await readFile(file, "utf8").catch(() => "")).filter((x) => x.org === orgId).pop();
  if (last && last.seq === a.seq && last.hash === a.hash) return null;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(a)}\n`, { mode: 0o640 });
  return a.seq;
}

export async function checkAnchors(db: Queryable, orgId: string, file: string | null, key: Buffer): Promise<{ checked: number; fileMissing?: boolean } | { broken: AnchorBreak } | null> {
  if (!file) return null;
  const text = await readFile(file, "utf8").catch(() => null);
  // A file never written (fresh install) and a deleted one look the same here, so the caller is told and decides.
  if (text === null) return { checked: 0, fileMissing: true };
  const r = await verifyAnchors(db, orgId, key, parseAnchors(text));
  return r.ok ? { checked: r.value.checked } : { broken: r.error };
}

/** Checkpoint at start and then every `everyMs`; failures are logged, never thrown. */
export function startAnchoring(app: FastifyInstance, orgId: string, file: string | null, key: Buffer, everyMs = 5 * 60_000): void {
  if (!file) return;
  const tick = (): void => void writeAnchor(app.gantry.pool, orgId, file, key).catch((e: unknown) => app.log.error({ err: e }, "audit anchor write failed"));
  tick();
  const t = setInterval(tick, everyMs);
  t.unref();
  app.addHook("onClose", async () => clearInterval(t));
}
