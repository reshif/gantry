/**
 * Token usage from an Anthropic Messages response, streamed (SSE) or not. Streams report input and cache tokens in message_start
 * and the cumulative output tokens in message_delta; the last value wins.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  seen: boolean;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, seen: false });

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

function apply(u: Usage, x: unknown): void {
  if (!x || typeof x !== "object") return;
  const o = x as Record<string, unknown>;
  const i = num(o.input_tokens);
  const out = num(o.output_tokens);
  const cr = num(o.cache_read_input_tokens);
  const cw = num(o.cache_creation_input_tokens);
  if (i !== undefined) u.inputTokens = i;
  if (out !== undefined) u.outputTokens = out;
  if (cr !== undefined) u.cacheReadTokens = cr;
  if (cw !== undefined) u.cacheWriteTokens = cw;
  if (i !== undefined || out !== undefined) u.seen = true;
}

export function usageFromJson(body: unknown): Usage {
  const u = emptyUsage();
  if (body && typeof body === "object") apply(u, (body as { usage?: unknown }).usage);
  return u;
}

/** Incremental SSE reader: feed chunks, read `usage` at the end. */
export class SseUsage {
  readonly usage = emptyUsage();
  private buf = "";
  /** The vendor's request id, when the stream carries a message id. */
  messageId: string | undefined;
  /** The assembled message: text, thinking and tool-call deltas joined per content block, so scanners see whole strings, not fragments. */
  readonly message: { id?: string; model?: string; stop_reason?: string | null; content: Array<Record<string, unknown>> } = { content: [] };
  private readonly partial = new Map<number, string>();

  push(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i).replace(/^\r?\n\r?\n/, "");
      this.block(block);
    }
  }

  end(): void {
    if (this.buf.trim()) this.block(this.buf);
    this.buf = "";
  }

  private block(b: string): void {
    const data = b
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      const j = JSON.parse(data) as {
        type?: string;
        index?: number;
        message?: { usage?: unknown; id?: string; model?: string };
        usage?: unknown;
        content_block?: Record<string, unknown>;
        delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string | null };
      };
      if (j.type === "message_start") {
        apply(this.usage, j.message?.usage);
        if (typeof j.message?.id === "string") this.message.id = this.messageId = j.message.id;
        if (typeof j.message?.model === "string") this.message.model = j.message.model;
      } else if (j.type === "message_delta") {
        apply(this.usage, j.usage);
        if (j.delta && "stop_reason" in j.delta) this.message.stop_reason = j.delta.stop_reason ?? null;
      } else if (j.type === "content_block_start" && typeof j.index === "number" && j.content_block) {
        this.message.content[j.index] = { ...j.content_block };
      } else if (j.type === "content_block_delta" && typeof j.index === "number" && j.delta) {
        const blk = (this.message.content[j.index] ??= {});
        if (typeof j.delta.text === "string") blk.text = `${typeof blk.text === "string" ? blk.text : ""}${j.delta.text}`;
        else if (typeof j.delta.thinking === "string") blk.thinking = `${typeof blk.thinking === "string" ? blk.thinking : ""}${j.delta.thinking}`;
        else if (typeof j.delta.partial_json === "string") this.partial.set(j.index, `${this.partial.get(j.index) ?? ""}${j.delta.partial_json}`);
      } else if (j.type === "content_block_stop" && typeof j.index === "number" && this.partial.has(j.index)) {
        const raw = this.partial.get(j.index)!;
        this.partial.delete(j.index);
        const blk = (this.message.content[j.index] ??= {});
        try {
          blk.input = JSON.parse(raw);
        } catch {
          blk.input_json = raw;
        }
      }
    } catch {
      /* not JSON: ignore, the stream is passed through untouched */
    }
  }
}
