/**
 * Fetch wrapper for /api/v1.
 *
 * - Always sends the session cookie (credentials: "include").
 * - State-changing requests carry X-CSRF-Token (the `csrf` field of GET /api/v1/me).
 * - Creates carry an Idempotency-Key; versioned entities take If-Match.
 * - Commands never throw for expected outcomes. A refusal (403 permission, 409 conflict / stale /
 *   stopped, 422 validation) is a value: { ok: false, msg, rule?, needs?, status }. Network
 *   failures and unexpected statuses are values too. Reads throw ApiError so TanStack Query can
 *   retry and surface them.
 */
import type { RuleRef } from "./types";

export const API_BASE = "/api/v1";

export interface CommandOk {
  ok: true;
  msg: string;
  status: number;
}
export interface CommandRefusal {
  ok: false;
  msg: string;
  status: number;
  /** The rule that refused it (403/409). */
  rule?: RuleRef;
  /** What the person needs to do it (403). */
  needs?: string;
}
/** `{ ok, msg, ...extra }`: the result shape of every command, as the legacy G.ops returned. */
export type ApiResult<T extends object = Record<string, unknown>> = (CommandOk & T) | CommandRefusal;

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  method?: Method;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Creates: send an Idempotency-Key. Pass a string to reuse a key across a retry. */
  idempotent?: boolean | string;
  /** Versioned entities: sent as If-Match. */
  ifMatch?: string | number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, msg: string, body: unknown) {
    super(msg);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/* ---------- session state kept by the client ---------- */

let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}
export function getCsrfToken(): string | null {
  return csrfToken;
}
/** Called once when any request answers 401 while a session was believed to exist. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

export function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = path.startsWith("/") ? path : `${API_BASE}/${path}`;
  if (!query) return url;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `${url}${url.includes("?") ? "&" : "?"}${s}` : url;
}

/** Path under /api/v1 from a relative path ("projects/p1/floor"). */
export const api = (path: string): string => `${API_BASE}/${path.replace(/^\/+/, "")}`;

function newKey(): string {
  return globalThis.crypto.randomUUID();
}

function isMutation(m: Method): boolean {
  return m !== "GET";
}

async function ensureCsrf(): Promise<void> {
  if (csrfToken) return;
  try {
    const res = await fetch(`${API_BASE}/me`, { credentials: "include", headers: { Accept: "application/json" } });
    if (res.ok) {
      const body = (await res.json()) as { csrf?: string };
      if (typeof body.csrf === "string") csrfToken = body.csrf;
    }
  } catch {
    /* the command below reports the network failure */
  }
}

/**
 * Idle timeout counts a person's own activity. Timed polling from an unattended tab must not keep the session alive, so reads sent
 * when there has been no pointer or key input for a while carry a background marker the server does not count.
 */
let lastInput = Date.now();
if (typeof window !== "undefined") for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(ev, () => (lastInput = Date.now()), { passive: true, capture: true });
const ACTIVE_MS = 60_000;

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  if (isMutation(method)) {
    await ensureCsrf();
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotent) headers["Idempotency-Key"] = typeof opts.idempotent === "string" ? opts.idempotent : newKey();
  }
  if (!isMutation(method) && Date.now() - lastInput > ACTIVE_MS) headers["X-Gantry-Background"] = "1";
  if (opts.ifMatch !== undefined) headers["If-Match"] = String(opts.ifMatch);
  const init: RequestInit = { method, credentials: "include", headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  if (opts.signal) init.signal = opts.signal;
  return fetch(buildUrl(path, opts.query), init);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function refusalFrom(status: number, body: unknown, fallback: string): CommandRefusal {
  const b = asRecord(body);
  const out: CommandRefusal = { ok: false, msg: typeof b.msg === "string" && b.msg ? b.msg : fallback, status };
  if (b.rule && typeof b.rule === "object") out.rule = b.rule as RuleRef;
  if (typeof b.needs === "string" && b.needs) out.needs = b.needs;
  return out;
}

function defaultMessage(status: number): string {
  switch (status) {
    case 401:
      return "Your session has ended. Sign in again.";
    case 403:
      return "You are not permitted to do that.";
    case 404:
      return "That no longer exists.";
    case 409:
      return "That conflicts with the current state. Refresh and try again.";
    case 422:
      return "That input is not valid.";
    case 429:
      return "Too many requests. Wait a moment and try again.";
    default:
      return status >= 500 ? "The server could not complete that. Try again." : `Request failed (${status}).`;
  }
}

/* ---------- step-up (spec 14.1) ---------- */

/** What the step-up prompt shows and what it resolves to. `error` is set when the sign-in itself failed (e.g. a different person). */
export type StepUpOutcome = { ok: true } | { ok: false; error?: string };
export type StepUpHandler = (refusal: CommandRefusal) => Promise<StepUpOutcome>;

let stepUpHandler: StepUpHandler | null = null;
/** Mounted once by the shell: every command refused with `needs: "step_up"` is routed through it (see ui/stepup.tsx). */
export function setStepUpHandler(fn: StepUpHandler | null): void {
  stepUpHandler = fn;
}

/** One attempt: send, read, shape. `key` is the idempotency key reused if the attempt is repeated. */
async function attempt<T extends object>(path: string, opts: RequestOptions): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await send(path, { method: "POST", ...opts });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return { ok: false, msg: "Cancelled.", status: 0 };
    return { ok: false, msg: "Could not reach Gantry. Check your connection and try again.", status: 0 };
  }
  const body = await readBody(res);
  if (res.status === 401) unauthorizedHandler?.();
  if (res.ok) {
    const b = asRecord(body);
    // A 2xx body that says ok:false is still a refusal the caller must see.
    if (b.ok === false) return refusalFrom(res.status, body, defaultMessage(res.status));
    const { ok: _ok, msg, ...rest } = b;
    return { ...rest, ok: true, msg: typeof msg === "string" ? msg : "", status: res.status } as ApiResult<T>;
  }
  return refusalFrom(res.status, body, defaultMessage(res.status));
}

const isStepUpRefusal = (r: ApiResult<object>): r is CommandRefusal => !r.ok && r.needs === "step_up";

/** Asks the person for a reason when the server refuses with `needs: "override_reason"` (Factory Admin break-glass). Resolves null on cancel. */
export type ReasonHandler = (refusal: CommandRefusal) => Promise<string | null>;
let reasonHandler: ReasonHandler | null = null;
/** Mounted once by the shell (see ui/override.tsx). */
export function setReasonHandler(fn: ReasonHandler | null): void {
  reasonHandler = fn;
}
const isReasonRefusal = (r: ApiResult<object>): r is CommandRefusal => !r.ok && r.needs === "override_reason";

/**
 * Run a command. Resolves to `{ ok: true, msg, ...extra }` or a refusal value. Never rejects
 * (except for programmer errors such as an unserialisable body).
 *
 * A step-up refusal (the server stopped before running anything) is handled here for every caller: the prompt asks the person to sign
 * in again, and on success the same request is sent once more (same body, If-Match and Idempotency-Key). Cancel, failure or a second
 * step-up refusal resolves to the refusal, so callers need no step-up code.
 */
export async function command<T extends object = Record<string, unknown>>(
  path: string,
  opts: RequestOptions = {},
): Promise<ApiResult<T>> {
  // Fix the key up front so a repeat is the same request, never a second create.
  const first: RequestOptions = opts.idempotent === true ? { ...opts, idempotent: newKey() } : opts;
  const r = await withStepUp<T>(path, first);
  // A Factory Admin override asks for a reason, then sends the same request once more with `reason` added (and a fresh key: it is a
  // different request, and the refused one ran nothing). Cancel resolves to the refusal.
  if (!isReasonRefusal(r) || !reasonHandler) return r;
  let reason: string | null;
  try {
    reason = await reasonHandler(r);
  } catch {
    return r;
  }
  if (!reason) return r;
  const body = { ...((first.body && typeof first.body === "object" ? first.body : {}) as Record<string, unknown>), reason };
  return withStepUp<T>(path, { ...first, body, ...(opts.idempotent === true ? { idempotent: newKey() } : {}) });
}

async function withStepUp<T extends object>(path: string, first: RequestOptions): Promise<ApiResult<T>> {
  const r = await attempt<T>(path, first);
  if (!isStepUpRefusal(r) || !stepUpHandler) return r;
  let out: StepUpOutcome;
  try {
    out = await stepUpHandler(r);
  } catch {
    return r;
  }
  if (!out.ok) return out.error ? { ...r, msg: out.error } : r;
  return attempt<T>(path, first);
}

/** GET returning the parsed JSON body. Throws ApiError on any non-2xx so queries can retry. */
export async function get<T>(path: string, query?: RequestOptions["query"], signal?: AbortSignal): Promise<T> {
  const opts: RequestOptions = { method: "GET" };
  if (query) opts.query = query;
  if (signal) opts.signal = signal;
  const res = await send(path, opts);
  const body = await readBody(res);
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    throw new ApiError(res.status, refusalFrom(res.status, body, defaultMessage(res.status)).msg, body);
  }
  return body as T;
}

/** GET that returns text (record.md). */
export async function getText(path: string, query?: RequestOptions["query"]): Promise<string> {
  const opts: RequestOptions = { method: "GET", headers: { Accept: "text/markdown, text/plain" } };
  if (query) opts.query = query;
  const res = await send(path, opts);
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, defaultMessage(res.status), text);
  return text;
}

/** Convenience verbs for command(). */
export const post = <T extends object = Record<string, unknown>>(path: string, body?: unknown, o: Omit<RequestOptions, "method" | "body"> = {}) =>
  command<T>(path, { ...o, method: "POST", body });
export const put = <T extends object = Record<string, unknown>>(path: string, body?: unknown, o: Omit<RequestOptions, "method" | "body"> = {}) =>
  command<T>(path, { ...o, method: "PUT", body });
export const patch = <T extends object = Record<string, unknown>>(path: string, body?: unknown, o: Omit<RequestOptions, "method" | "body"> = {}) =>
  command<T>(path, { ...o, method: "PATCH", body });
export const del = <T extends object = Record<string, unknown>>(path: string, body?: unknown, o: Omit<RequestOptions, "method" | "body"> = {}) =>
  command<T>(path, { ...o, method: "DELETE", body });

/**
 * POST whose response is a text stream (console answers). Calls onChunk with each decoded chunk and
 * resolves to a command-shaped result when the stream ends.
 */
export async function streamCommand(
  path: string,
  body: unknown,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  /** A create: send an Idempotency-Key (a retry then returns the first result as JSON instead of streaming again). */
  idempotent?: boolean | string,
): Promise<ApiResult> {
  let res: Response;
  try {
    const o: RequestOptions = { method: "POST", body, headers: { Accept: "text/event-stream, text/plain, application/json" } };
    if (signal) o.signal = signal;
    if (idempotent) o.idempotent = idempotent;
    res = await send(path, o);
  } catch {
    return { ok: false, msg: "Could not reach Gantry. Check your connection and try again.", status: 0 };
  }
  if (!res.ok || !res.body) return refusalFrom(res.status, await readBody(res), defaultMessage(res.status));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(dec.decode(value, { stream: true }));
    }
  } catch {
    return { ok: false, msg: "The answer stream was interrupted.", status: res.status };
  }
  return { ok: true, msg: "", status: res.status };
}
