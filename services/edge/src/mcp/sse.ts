/** A minimal Server-Sent Events reader (WHATWG framing): yields `{ event, data }` for each dispatched event. */
export interface SseEvent {
  event: string;
  data: string;
}

export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: !done });
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
