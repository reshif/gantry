/**
 * Model discovery (spec 10.4 Vendor templates): list the models a vendor offers from the vendor's own API, with the credentials the person
 * just entered (or the stored ones). Runs in the API process and leaves through the egress proxy like every third-party call, so the system
 * allow-list applies. It never throws: a failure comes back as a message that says what to fix.
 */
import { createSign } from "node:crypto";
import { knownModel, modelDisplayName, templateEndpoint, type VendorTemplate } from "@gantry/domain";
import { NetworkError, type OutboundHttp } from "../notifications/http.js";
import { signV4 } from "./sigv4.js";

export interface Discovered {
  /** The id the vendor's API expects (Azure: the deployment name). */
  upstream: string;
  name: string;
  /** Context window in tokens when the vendor's list says. */
  context?: number;
  /** What to look the model up as in the known-model catalogue when the id is not itself the model (Azure deployments). */
  match?: string;
}
export type DiscoverResult = { ok: true; models: Discovered[]; warnings: string[] } | { ok: false; msg: string };

type Json = Record<string, unknown>;
const TIMEOUT = 25_000;
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === "object") : []);
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);

class Fail extends Error {}

/** One GET or POST that returns parsed JSON, or throws `Fail` with a message for the person. */
async function call(http: OutboundHttp, who: string, method: "GET" | "POST", url: string, headers: Record<string, string>, body?: string): Promise<Json> {
  let res;
  try {
    res = await http.request({ method, url, headers: { accept: "application/json", ...headers }, ...(body !== undefined ? { body } : {}), timeoutMs: TIMEOUT });
  } catch (e) {
    const m = e instanceof NetworkError ? e.message : (e as Error).message;
    throw new Fail(`Could not reach ${who}: ${m}`);
  }
  let json: Json | null = null;
  try {
    const p: unknown = JSON.parse(res.body);
    if (p && typeof p === "object") json = p as Json;
  } catch {
    /* judged by the status below */
  }
  if (res.status >= 200 && res.status < 300) {
    if (!json) throw new Fail(`${who} answered, but not with a model list. Check the base URL.`);
    return json;
  }
  const detail = s((json?.error as Json | undefined)?.message) || s(json?.message) || s(json?.Message);
  const tail = detail ? ` (${detail.slice(0, 160)})` : "";
  if (res.status === 401 || res.status === 403) throw new Fail(`${who} rejected the credentials (HTTP ${res.status})${tail}. Check the key and its permissions.`);
  if (res.status === 404) throw new Fail(`${who} has no model list at this address (HTTP 404)${tail}. Check the base URL.`);
  if (res.status === 429) throw new Fail(`${who} is rate limiting us (HTTP 429). Try again in a minute.`);
  throw new Fail(`${who} answered HTTP ${res.status || "with nothing"}${tail}.`);
}

const NOT_CHAT = /(embed|whisper|tts|dall-e|image|audio|realtime|moderation|transcribe|rerank|davinci|babbage|search|computer-use|sora)/i;

/** `<base>/v1/models` whether or not the base already ends in /v1. */
export const modelsUrl = (base: string): string => (/\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`);

async function anthropic(http: OutboundHttp, base: string, key: string, who: string, bearer: boolean): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let after = "";
  for (let page = 0; page < 5; page++) {
    const j = await call(http, who, "GET", `${modelsUrl(base)}?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`, { "x-api-key": key, "anthropic-version": "2023-06-01", ...(bearer ? { authorization: `Bearer ${key}` } : {}) });
    for (const m of arr(j.data)) if (s(m.id)) out.push({ upstream: s(m.id), name: s(m.display_name) || modelDisplayName(s(m.id)), ...(n(m.max_input_tokens) ? { context: n(m.max_input_tokens)! } : {}) });
    if (j.has_more === true && s(j.last_id)) after = s(j.last_id);
    else break;
  }
  return out;
}

async function openaiList(http: OutboundHttp, base: string, key: string, who: string, strict: boolean): Promise<Discovered[]> {
  const j = await call(http, who, "GET", modelsUrl(base), key ? { authorization: `Bearer ${key}` } : {});
  return arr(j.data)
    .map((m) => s(m.id))
    .filter((id) => id && !NOT_CHAT.test(id) && (!strict || /^(gpt|o\d|chatgpt|codex)/i.test(id)))
    .map((id) => ({ upstream: id, name: modelDisplayName(id) }));
}

async function bedrock(http: OutboundHttp, v: Record<string, string>, warnings: string[]): Promise<Discovered[]> {
  const region = v.region ?? "";
  const creds = { region, service: "bedrock", accessKeyId: v.accessKeyId ?? "", secretAccessKey: v.secretAccessKey ?? "", sessionToken: v.sessionToken || undefined };
  const get = (path: string): Promise<Json> => {
    const url = `https://bedrock.${region}.amazonaws.com${path}`;
    return call(http, `AWS Bedrock (${region})`, "GET", url, signV4({ method: "GET", url, ...creds }));
  };
  const out: Discovered[] = [];
  const fm = await get("/foundation-models?byOutputModality=TEXT");
  for (const m of arr(fm.modelSummaries)) {
    const id = s(m.modelId);
    const inp = Array.isArray(m.inputModalities) ? m.inputModalities : ["TEXT"];
    if (id && inp.includes("TEXT") && !NOT_CHAT.test(id)) out.push({ upstream: id, name: s(m.modelName) ? `${s(m.providerName)} ${s(m.modelName)}`.trim() : modelDisplayName(id) });
  }
  try {
    const ip = await get("/inference-profiles?maxResults=1000");
    for (const m of arr(ip.inferenceProfileSummaries)) {
      const id = s(m.inferenceProfileId);
      if (id && s(m.status) !== "INACTIVE" && !NOT_CHAT.test(id)) out.push({ upstream: id, name: s(m.inferenceProfileName) || modelDisplayName(id) });
    }
  } catch (e) {
    warnings.push(`Inference profiles were not listed: ${(e as Error).message}`);
  }
  return out;
}

async function azure(http: OutboundHttp, v: Record<string, string>): Promise<Discovered[]> {
  const base = (v.endpoint ?? "").replace(/\/+$/, "");
  const who = "Azure OpenAI";
  const h = { "api-key": v.apiKey ?? "" };
  let j: Json;
  try {
    j = await call(http, who, "GET", `${base}/openai/deployments?api-version=${encodeURIComponent(v.apiVersion || "2024-10-21")}`, h);
  } catch (e) {
    // Newer GA api-versions dropped the data-plane deployments list; the preview version that has it is tried next.
    if (!(e instanceof Fail) || !/HTTP 404/.test(e.message)) throw e;
    j = await call(http, who, "GET", `${base}/openai/deployments?api-version=2023-03-15-preview`, h);
  }
  return arr(j.data).filter((d) => s(d.id) && (!s(d.status) || s(d.status) === "succeeded")).map((d) => ({ upstream: s(d.id), name: s(d.id), ...(s(d.model) ? { match: s(d.model) } : {}) }));
}

async function gemini(http: OutboundHttp, base: string, key: string): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let token = "";
  for (let page = 0; page < 5; page++) {
    const j = await call(http, "Google Gemini", "GET", `${base}/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, { "x-goog-api-key": key });
    for (const m of arr(j.models)) {
      const id = s(m.name).replace(/^models\//, "");
      const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
      if (id && methods.includes("generateContent") && !NOT_CHAT.test(id)) out.push({ upstream: id, name: s(m.displayName) || modelDisplayName(id), ...(n(m.inputTokenLimit) ? { context: n(m.inputTokenLimit)! } : {}) });
    }
    if (s(j.nextPageToken)) token = s(j.nextPageToken);
    else break;
  }
  return out;
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

/** An access token for a Google service account: a signed JWT exchanged at Google's fixed token endpoint. */
async function googleToken(http: OutboundHttp, saJson: string, now: Date): Promise<string> {
  let sa: Json;
  try {
    sa = JSON.parse(saJson) as Json;
  } catch {
    throw new Fail("The service account key is not valid JSON. Paste the whole key file.");
  }
  if (!s(sa.client_email) || !s(sa.private_key)) throw new Fail("The service account key needs client_email and private_key.");
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64u(JSON.stringify({ iss: s(sa.client_email), scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3000 }));
  let sig: string;
  try {
    sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(s(sa.private_key)).toString("base64url");
  } catch {
    throw new Fail("The service account private key could not be read.");
  }
  const body = `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${head}.${claims}.${sig}`;
  const j = await call(http, "Google sign-in", "POST", "https://oauth2.googleapis.com/token", { "content-type": "application/x-www-form-urlencoded" }, body);
  if (!s(j.access_token)) throw new Fail("Google sign-in did not return an access token.");
  return s(j.access_token);
}

async function vertex(http: OutboundHttp, v: Record<string, string>, now: Date): Promise<Discovered[]> {
  const token = await googleToken(http, v.serviceAccount ?? "", now);
  const base = `https://${v.location}-aiplatform.googleapis.com`;
  const j = await call(http, `Vertex AI (${v.location})`, "GET", `${base}/v1beta1/publishers/google/models?pageSize=200`, { authorization: `Bearer ${token}` });
  return arr(j.publisherModels)
    .map((m) => s(m.name).replace(/^publishers\/google\/models\//, ""))
    .filter((id) => /^gemini/i.test(id) && !NOT_CHAT.test(id))
    .map((id) => ({ upstream: id, name: modelDisplayName(id) }));
}

/** The hosts a template's discovery calls, for the egress allow-list. */
export function discoveryHosts(t: VendorTemplate, values: Record<string, string>): string[] {
  const host = (u: string): string[] => {
    try {
      return [new URL(u).hostname.toLowerCase()];
    } catch {
      return [];
    }
  };
  switch (t.protocol) {
    case "bedrock": return values.region ? [`bedrock.${values.region}.amazonaws.com`, `bedrock-runtime.${values.region}.amazonaws.com`] : [];
    case "vertex": return [...(values.location ? [`${values.location}-aiplatform.googleapis.com`] : []), "oauth2.googleapis.com"];
    default: return host(templateEndpoint(t, values));
  }
}

export async function discoverModels(http: OutboundHttp, t: VendorTemplate, values: Record<string, string>, now: Date = new Date()): Promise<DiscoverResult> {
  const warnings: string[] = [];
  try {
    const base = templateEndpoint(t, values);
    let models: Discovered[];
    switch (t.protocol) {
      case "anthropic": models = await anthropic(http, base, values.apiKey ?? "", "Anthropic", false); break;
      case "openai":
        models = t.id === "openai-compatible" ? await openaiList(http, base, values.apiKey ?? "", "The endpoint", false) : await openaiList(http, base, values.apiKey ?? "", "OpenAI", true);
        break;
      case "bedrock": models = await bedrock(http, values, warnings); break;
      case "azure": models = await azure(http, values); break;
      case "gemini": models = await gemini(http, base, values.apiKey ?? ""); break;
      case "vertex": models = await vertex(http, values, now); break;
    }
    const seen = new Set<string>();
    models = models.filter((m) => !seen.has(m.upstream) && (seen.add(m.upstream), true));
    // A compatible endpoint that also speaks Messages is probed on its own base path only when asked; the list is what it advertises.
    if (!models.length) return { ok: false, msg: `${t.name} answered but lists no models for these credentials.` };
    return { ok: true, models, warnings };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, msg: e.message };
    return { ok: false, msg: `Model discovery failed: ${(e as Error).message}` };
  }
}

export { knownModel };
