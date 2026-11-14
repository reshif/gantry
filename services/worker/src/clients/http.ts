import { TransientError, PermanentError } from "../errors.js";

export interface JsonResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
}

/** A small JSON client over fetch with a hard timeout. Internal services (launcher, broker) are reached directly, never through the egress proxy. */
export async function jsonRequest<T = Record<string, unknown>>(
  base: string,
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  o: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<JsonResponse<T>> {
  const f = o.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
    });
  } catch (e) {
    throw new TransientError(`${method} ${path} failed: ${(e as Error).message}`, "unreachable");
  }
  const text = await res.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { msg: text.slice(0, 500) };
    }
  }
  return { status: res.status, body: parsed as T };
}

/** Maps a non-2xx answer to a transient (429, 5xx) or permanent (other 4xx) error. */
export function failFor(what: string, r: { status: number; body: unknown }): never {
  const b = r.body as { msg?: string; code?: string; kind?: string };
  const msg = `${what}: ${r.status} ${b.msg ?? ""}`.trim();
  if (r.status === 429 || r.status === 408 || r.status >= 500) throw new TransientError(msg, b.kind ?? b.code ?? `http_${r.status}`);
  throw new PermanentError(msg, b.code ?? b.kind ?? `http_${r.status}`);
}
