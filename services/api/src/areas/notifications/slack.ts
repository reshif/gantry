/**
 * Slack (spec 12.1): a bot token calls chat.postMessage and chat.update through the egress proxy; interactive callbacks and slash commands arrive at
 * /hooks/slack, signed with the app's signing secret (v0 scheme) and refused outside a five-minute window (replay protection, spec 5.3).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { OutboundHttp } from "./http.js";

export const SLACK_API = "https://slack.com/api";

/** Slack error codes that a retry can fix; everything else (bad channel, bad token, not in channel) is permanent. */
const TRANSIENT = new Set(["ratelimited", "rate_limited", "internal_error", "service_unavailable", "fatal_error", "request_timeout", "accesslimited"]);

export interface SlackResult {
  ok: boolean;
  /** Slack's error code when not ok, or `http_<status>`. */
  error?: string;
  transient: boolean;
  status: number;
  data: Record<string, unknown>;
}

export async function slackCall(http: OutboundHttp, token: string, method: string, body: Record<string, unknown>, base = SLACK_API): Promise<SlackResult> {
  const res = await http.request({
    method: "POST", url: `${base.replace(/\/+$/, "")}/${method}`, timeoutMs: 15_000,
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}`, "user-agent": "gantry" },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    const j: unknown = JSON.parse(res.body);
    if (j && typeof j === "object") data = j as Record<string, unknown>;
  } catch {
    /* not JSON: judged by the status */
  }
  if (res.status === 429 || res.status >= 500) return { ok: false, error: `http_${res.status}`, transient: true, status: res.status, data };
  if (res.status < 200 || res.status >= 300) return { ok: false, error: `http_${res.status}`, transient: res.status === 408 || res.status === 425, status: res.status, data };
  if (data.ok === true) return { ok: true, transient: false, status: res.status, data };
  const error = typeof data.error === "string" ? data.error : "unknown_error";
  return { ok: false, error, transient: TRANSIENT.has(error), status: res.status, data };
}

export const slackAuthTest = (http: OutboundHttp, token: string, base?: string): Promise<SlackResult> => slackCall(http, token, "auth.test", {}, base);

export interface PostInput { channel: string; text: string; blocks?: unknown[] }
export const slackPost = (http: OutboundHttp, token: string, m: PostInput, base?: string): Promise<SlackResult> =>
  slackCall(http, token, "chat.postMessage", { channel: m.channel, text: m.text, ...(m.blocks?.length ? { blocks: m.blocks } : {}), unfurl_links: false }, base);
/** Updates a message in place with the stored message reference (`channel` is the channel id Slack returned, `ts` the message timestamp). */
export const slackUpdate = (http: OutboundHttp, token: string, ref: { channel: string; ts: string }, m: { text: string; blocks?: unknown[] }, base?: string): Promise<SlackResult> =>
  slackCall(http, token, "chat.update", { channel: ref.channel, ts: ref.ts, text: m.text, ...(m.blocks?.length ? { blocks: m.blocks } : {}) }, base);

export const SIGNATURE_TOLERANCE_SEC = 300;

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing" | "stale" | "mismatch" };

/** Verifies `X-Slack-Signature` (`v0=` HMAC-SHA256 of `v0:<timestamp>:<raw body>`) in constant time, and that the timestamp is within five minutes of now. */
export function verifySlackSignature(raw: Buffer, timestamp: string | undefined, signature: string | undefined, secret: string, nowMs = Date.now()): SignatureCheck {
  if (!timestamp || !signature || !secret) return { ok: false, reason: "missing" };
  const t = Number(timestamp);
  if (!Number.isInteger(t) || Math.abs(nowMs / 1000 - t) > SIGNATURE_TOLERANCE_SEC) return { ok: false, reason: "stale" };
  const want = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(raw).digest("hex")}`);
  const got = Buffer.from(signature);
  return got.length === want.length && timingSafeEqual(got, want) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** Signs a body the way Slack does (for tests and for a local Slack double). */
export const signSlack = (raw: string, timestamp: string, secret: string): string => `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
