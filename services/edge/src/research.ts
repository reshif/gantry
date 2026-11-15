/**
 * Governed web research (agent workspace, Phase 2, G2): the one way a station agent reads the web.
 *
 *   POST /run/v1/research/fetch  {url, why?}
 *
 * The API says which hosts this run may read (the factory's research allow-list, the project's, and the hosts a person approved in the work
 * order's research plan). The edge then fetches: HTTPS only, no credentials in the URL, every redirect hop re-checked, names that resolve to a
 * private address refused at connect time, a byte cap, text and HTML only. The page becomes plain text (scripts and styles dropped), secrets
 * are redacted, the text is stored by hash as the snapshot of what the agent saw, and the API records it as a source (`s1`, `s2`, ...) with an
 * audit event. The agent gets the text back marked as untrusted data, with the source id to cite.
 */
import dns from "node:dns";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Agent, fetch as ufetch } from "undici";
import type { ApiClient } from "./api.js";
import { hostAllowed, isPrivateAddress } from "./proxy.js";
import { scanText } from "./secrets-scan.js";
import type { ObjectStore } from "./trace.js";

export const RESEARCH_LIMITS = { maxBytes: 2 * 1024 * 1024, maxText: 60_000, maxRedirects: 4, timeoutMs: 20_000 } as const;
const TEXT_TYPES = /^(text\/(html|plain|markdown|csv|xml)|application\/(xhtml\+xml|json|xml|rss\+xml|atom\+xml))\b/i;
const SECRET_PARAM = /^(token|access_token|api_key|apikey|key|sig|signature|auth|password|secret|code|session)$/i;

/** The URL as it is recorded: query parameters that look like credentials are dropped, the fragment too. */
export function recordedUrl(u: URL): string {
  const x = new URL(u.toString());
  x.hash = "";
  for (const k of [...x.searchParams.keys()]) if (SECRET_PARAM.test(k)) x.searchParams.delete(k);
  return x.toString();
}

/** Plain text of an HTML page: scripts, styles and comments dropped, block tags become line breaks, entities decoded. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  let t = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|object|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote|table|ul|ol|dd|dt)\s*>/gi, "\n")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n${"#".repeat(Number(n))} `)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  const ent: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    }
    return ent[e.toLowerCase()] ?? m;
  });
  t = t.split("\n").map((l) => l.replace(/[ \t\f\v\r]+/g, " ").trim()).filter((l, i, a) => l || (a[i - 1] ?? "") !== "").join("\n").replace(/\n\n(?=- )/g, "\n").trim();
  return { title, text: t };
}

/** A dispatcher whose DNS lookup refuses names that resolve to a private, loopback or link-local address (no SSRF through an allow-listed name). */
export function publicOnlyAgent(): Agent {
  return new Agent({
    connect: {
      lookup: (hostname, options, cb) => {
        dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
          if (err) return cb(err, "", 4);
          const list = (addrs as unknown as dns.LookupAddress[]) ?? [];
          if (!list.length || list.some((a) => isPrivateAddress(a.address))) return cb(Object.assign(new Error(`${hostname} resolves to a private address`), { code: "EPRIVATE" }), "", 4);
          const first = list[0]!;
          // undici asks with `all`; answer in the form it asked for
          if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
          cb(null, first.address, first.family);
        });
      },
    },
    connectTimeout: 10_000,
  });
}

export interface ResearchDeps {
  api: ApiClient;
  store: ObjectStore;
  knownKeys: () => string[];
  runAuth: (req: FastifyRequest) => { runId: string; token: string } | null;
  jsonBody: (req: FastifyRequest) => Record<string, unknown> | null;
  /** Tests pass a fetch; production uses undici with the public-only dispatcher. */
  fetchImpl?: (url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;
}

type Refusal = { status: number; msg: string };

async function readCapped(res: Response, max: number): Promise<{ buf: Buffer; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { buf: Buffer.alloc(0), cut: false };
  const parts: Buffer[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      parts.push(Buffer.from(value.subarray(0, value.byteLength - (n - max))));
      await reader.cancel().catch(() => undefined);
      return { buf: Buffer.concat(parts), cut: true };
    }
    parts.push(Buffer.from(value));
  }
  return { buf: Buffer.concat(parts), cut: false };
}

export function registerResearchRoutes(app: FastifyInstance, deps: ResearchDeps): { fetched: number; refused: number } {
  const metrics = { fetched: 0, refused: 0 };
  const agent = deps.fetchImpl ? null : publicOnlyAgent();
  const doFetch = deps.fetchImpl ?? ((url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => ufetch(url, { ...init, dispatcher: agent! }) as unknown as Promise<Response>);

  const refuse = async (reply: FastifyReply, a: { runId: string; token: string }, url: string, r: Refusal): Promise<FastifyReply> => {
    metrics.refused++;
    // the refusal is a ledger fact too: someone reviewing the run sees what the agent tried to read
    await deps.api.call("POST", `/internal/v1/runs/${encodeURIComponent(a.runId)}/research/refused`, { token: a.token, url, reason: r.msg }).catch(() => undefined);
    return reply.code(r.status).send({ ok: false, msg: r.msg });
  };

  app.post("/run/v1/research/fetch", async (req, reply) => {
    const a = deps.runAuth(req);
    if (!a) return reply.code(401).send({ ok: false, msg: "A valid run token is required." });
    const b = deps.jsonBody(req);
    const raw = typeof b?.url === "string" ? b.url.trim() : "";
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return reply.code(422).send({ ok: false, msg: "Give a full https:// URL." });
    }
    if (url.protocol !== "https:") return refuse(reply, a, raw, { status: 422, msg: "Only https:// pages can be read." });
    if (url.username || url.password) return refuse(reply, a, raw, { status: 422, msg: "URLs with credentials are not allowed." });
    url.hash = "";
    if (url.port && url.port !== "443") return refuse(reply, a, raw, { status: 403, msg: "Only the standard HTTPS port is allowed." });

    const allow = await deps.api.call("POST", `/internal/v1/runs/${encodeURIComponent(a.runId)}/research/hosts`, { token: a.token });
    if (allow.kind === "unavailable") return reply.code(503).send({ ok: false, msg: "The control plane is unavailable." });
    if (allow.kind === "refused") return reply.code(allow.status).send(allow.body);
    const hosts = Array.isArray(allow.body.hosts) ? (allow.body.hosts as string[]) : [];
    if (!hosts.length) return refuse(reply, a, raw, { status: 403, msg: "Web research is not enabled for this work order: no hosts are on its research allow-list." });

    let cur = url;
    let res: Response | null = null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RESEARCH_LIMITS.timeoutMs);
    try {
      for (let hop = 0; hop <= RESEARCH_LIMITS.maxRedirects; hop++) {
        if (!hostAllowed(cur.hostname.toLowerCase(), hosts)) return await refuse(reply, a, recordedUrl(cur), { status: 403, msg: `${cur.hostname} is not on this work order's research allow-list.${hop ? " (reached by a redirect)" : ""}` });
        res = await doFetch(cur.toString(), { redirect: "manual", signal: ac.signal, headers: { "user-agent": "GantryResearch/1.0", accept: "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1" } });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          const next = new URL(res.headers.get("location")!, cur);
          if (next.protocol !== "https:") return await refuse(reply, a, recordedUrl(next), { status: 403, msg: "A redirect left HTTPS." });
          cur = next;
          res = null;
          continue;
        }
        break;
      }
      if (!res) return await refuse(reply, a, recordedUrl(cur), { status: 502, msg: "Too many redirects." });
      const type = res.headers.get("content-type") ?? "";
      if (!TEXT_TYPES.test(type)) return await refuse(reply, a, recordedUrl(cur), { status: 415, msg: `Only text pages can be read (this is ${type || "of unknown type"}).` });
      const { buf, cut } = await readCapped(res, RESEARCH_LIMITS.maxBytes);
      const body = buf.toString("utf8");
      const isHtml = /html/i.test(type);
      const page = isHtml ? htmlToText(body) : { title: "", text: body };
      const scanned = scanText(page.text, deps.knownKeys());
      const truncated = cut || scanned.text.length > RESEARCH_LIMITS.maxText;
      const text = scanned.text.slice(0, RESEARCH_LIMITS.maxText);
      const ref = await deps.store.put(Buffer.from(text, "utf8"), "text/plain; charset=utf-8");
      const rec = await deps.api.call("POST", `/internal/v1/runs/${encodeURIComponent(a.runId)}/research/source`, {
        token: a.token, url: recordedUrl(url), finalUrl: recordedUrl(cur), title: page.title.slice(0, 300), httpStatus: res.status, contentType: type.slice(0, 120),
        contentHash: ref.slice("sha256/".length), size: Buffer.byteLength(text), truncated, why: typeof b?.why === "string" ? b.why.slice(0, 500) : "", excerpt: text,
      });
      if (rec.kind !== "ok") return reply.code(rec.kind === "refused" ? rec.status : 503).send(rec.kind === "refused" ? rec.body : { ok: false, msg: "The control plane is unavailable." });
      metrics.fetched++;
      return { ok: true, source: rec.body.ref, url: recordedUrl(cur), title: page.title, httpStatus: res.status, truncated, text };
    } catch (e) {
      const msg = e instanceof Error ? ((e as { cause?: { code?: string } }).cause?.code === "EPRIVATE" || /private address/.test(String((e as { cause?: Error }).cause?.message ?? e.message)) ? `${cur.hostname} resolves to a private address.` : ac.signal.aborted ? "The page took too long." : `The page could not be read: ${e.message}`) : "The page could not be read.";
      return refuse(reply, a, recordedUrl(cur), { status: 502, msg });
    } finally {
      clearTimeout(timer);
    }
  });
  return metrics;
}
