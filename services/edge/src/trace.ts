import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { S3Config } from "./config.js";

/** Content-addressed object store (spec 7.4): sha256/<hash>. */
export interface ObjectStore {
  put(content: Buffer | string, contentType: string): Promise<string>;
}

export const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

export class S3ObjectStore implements ObjectStore {
  private readonly c: S3Client;
  constructor(private readonly cfg: S3Config) {
    this.c = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 2,
    });
  }

  /** Stores the bytes under sha256/<hash> and returns that key. Throws when the store is unreachable. */
  async put(content: Buffer | string, contentType: string): Promise<string> {
    const body = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const key = `sha256/${sha256(body)}`;
    await this.c.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType }), { abortSignal: AbortSignal.timeout(10_000) });
    return key;
  }
}

/** An unconfigured store: every put fails, so callers take their fail-closed or degraded path. */
export class NoObjectStore implements ObjectStore {
  async put(): Promise<string> {
    throw new Error("object storage is not configured");
  }
}

interface RunTraceState {
  seen: number;
  systemHash: string | null;
  toolsHash: string | null;
}

/**
 * Trace increments (spec 7.4: by reference, not full repeats). A Messages request repeats the whole conversation each turn, so the
 * stored record carries only the messages added since the previous call of the same run, plus the system prompt and tool list only
 * when they changed. The state is per edge process; after a restart the first record of a run is simply a full one.
 */
export class TraceIncrements {
  private readonly runs = new Map<string, RunTraceState>();

  build(runId: string, req: Record<string, unknown>): { delta: Record<string, unknown>; messageCount: number } {
    const messages = Array.isArray(req.messages) ? (req.messages as unknown[]) : [];
    const st = this.runs.get(runId) ?? { seen: 0, systemHash: null, toolsHash: null };
    const from = st.seen <= messages.length ? st.seen : 0;
    const systemHash = req.system === undefined ? null : sha256(JSON.stringify(req.system));
    const toolsHash = req.tools === undefined ? null : sha256(JSON.stringify(req.tools));
    const delta: Record<string, unknown> = { messagesFrom: from, messages: messages.slice(from) };
    if (systemHash !== st.systemHash) delta.system = req.system;
    if (toolsHash !== st.toolsHash) delta.tools = req.tools;
    for (const k of ["model", "max_tokens", "temperature", "stream", "thinking"]) if (req[k] !== undefined) delta[k] = req[k];
    this.runs.set(runId, { seen: messages.length, systemHash, toolsHash });
    if (this.runs.size > 5000) this.runs.delete(this.runs.keys().next().value as string);
    return { delta, messageCount: messages.length };
  }

  forget(runId: string): void {
    this.runs.delete(runId);
  }
}
