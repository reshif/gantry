/** A minimal Server-Sent Events reader (WHATWG framing): yields `{ event, data }` for each dispatched event. */
export interface SseEvent {
  event: string;
  data: string;
}

/** Thrown when a stream grows past its limit; the reader is cancelled. */
export class SseLimitError extends Error {
  constructor(readonly limit: number) {
    super(`An event larger than ${limit} bytes.`);
    this.name = "SseLimitError";
  }
}

/** `maxEventBytes` bounds one event (and an unterminated line); the stream of a request-bound answer is bounded as a whole by `maxTotalBytes`. */
export async function* sseEvents(body: ReadableStream<Uint8Array>, limits: { maxEventBytes?: number; maxTotalBytes?: number } = {}): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  let total = 0;
  const dec = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        total += value.byteLength;
        if (limits.maxTotalBytes && total > limits.maxTotalBytes) throw new SseLimitError(limits.maxTotalBytes);
        buf += dec.decode(value, { stream: !done });
        if (limits.maxEventBytes && buf.length + data.reduce((n, x) => n + x.length, 0) > limits.maxEventBytes) throw new SseLimitError(limits.maxEventBytes);
      }
      let nl: number;
      while ((nl = buf.search(/\r\n|\n|\r/)) >= 0) {
        if (!done && buf[nl] === "\r" && nl === buf.length - 1) break; // a CR at the end of a chunk may be the first half of CRLF
        const line = buf.slice(0, nl);
        buf = buf.slice(buf.startsWith("\r\n", nl) ? nl + 2 : nl + 1);
        if (line === "") {
          if (data.length) yield { event: event || "message", data: data.join("\n") };
          event = "";
          data = [];
        } else if (!line.startsWith(":")) {
          const i = line.indexOf(":");
          const field = i < 0 ? line : line.slice(0, i);
          const v = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
          if (field === "event") event = v;
          else if (field === "data") data.push(v);
        }
      }
      if (done) {
        if (data.length) yield { event: event || "message", data: data.join("\n") };
        return;
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
