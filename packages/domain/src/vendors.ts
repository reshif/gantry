/**
 * Vendor templates and the known-model catalogue (spec 10.4 Vendor templates).
 *
 * A template says what a person must enter to connect a vendor (and nothing else), how its models are listed, and whether the
 * edge gateway can call it as it is. The gateway speaks the Anthropic Messages API, so only `protocol: "anthropic"` vendors (and an
 * OpenAI-compatible endpoint that also accepts Messages) are invocable today; the rest are connected and listed but their models stay off.
 */

export interface VendorField {
  key: string;
  label: string;
  type: "text" | "url" | "secret" | "select" | "bool";
  required: boolean;
  placeholder?: string;
  /** Prefilled value (a base URL, a region, an API version). */
  default?: string;
  options?: string[];
  help?: string;
  /** A regular expression the value must match. */
  pattern?: string;
  patternMsg?: string;
}

export type VendorProtocol = "anthropic" | "openai" | "bedrock" | "azure" | "gemini" | "vertex";

export interface VendorTemplate {
  id: string;
  name: string;
  tagline: string;
  icon: string;
  /** How the vendor is authenticated, for display. */
  auth: string;
  protocol: VendorProtocol;
  /** The vendor's base URL when it is fixed. `{region}` and `{location}` are filled from the fields. Empty when the person enters it. */
  endpoint: string;
  fields: VendorField[];
  /** The gateway can call this vendor today. When false its models are listed but stay disabled. */
  invocable: boolean;
  /** Why not, in words for the screen. */
  invocationNote?: string;
  /** Hosted vendors have a fixed endpoint and need no per-station qualification; a generic endpoint does. */
  custom: boolean;
  region?: string;
  residency: string;
}

const f = (key: string, label: string, type: VendorField["type"], required: boolean, extra: Partial<VendorField> = {}): VendorField => ({ key, label, type, required, ...extra });

export const AWS_REGIONS = ["us-east-1", "us-east-2", "us-west-2", "eu-west-1", "eu-west-3", "eu-central-1", "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ca-central-1"];
const GATEWAY_NOTE = "The model gateway speaks the Anthropic Messages API only, so models on this vendor are listed but cannot be switched on until a translating gateway is added.";

export const VENDOR_TEMPLATES: readonly VendorTemplate[] = [
  {
    id: "anthropic", name: "Anthropic", tagline: "Claude through the Anthropic API.", icon: "A", auth: "API key", protocol: "anthropic", endpoint: "https://api.anthropic.com",
    fields: [f("apiKey", "API key", "secret", true, { placeholder: "sk-ant-...", help: "From console.anthropic.com. Stored encrypted; only the edge sees it." })],
    invocable: true, custom: false, residency: "Processed in the US by default.",
  },
  {
    id: "bedrock", name: "AWS Bedrock", tagline: "Claude and other models in your AWS account.", icon: "B", auth: "AWS access key (SigV4)", protocol: "bedrock", endpoint: "https://bedrock-runtime.{region}.amazonaws.com",
    fields: [
      f("region", "AWS region", "select", true, { default: "us-east-1", options: AWS_REGIONS, help: "Models and inference profiles are listed for this region." }),
      f("accessKeyId", "Access key id", "secret", true, { placeholder: "AKIA...", pattern: "^[A-Z0-9]{16,128}$", patternMsg: "An access key id is 16 to 128 capital letters and digits." }),
      f("secretAccessKey", "Secret access key", "secret", true),
      f("sessionToken", "Session token", "secret", false, { help: "Only for temporary credentials." }),
    ],
    invocable: false, invocationNote: GATEWAY_NOTE, custom: false, residency: "Stays in the chosen AWS region.",
  },
  {
    id: "openai", name: "OpenAI", tagline: "GPT and o-series models through the OpenAI API.", icon: "O", auth: "API key", protocol: "openai", endpoint: "https://api.openai.com",
    fields: [f("apiKey", "API key", "secret", true, { placeholder: "sk-..." })],
    invocable: false, invocationNote: GATEWAY_NOTE, custom: false, residency: "Processed in the US by default.",
  },
  {
    id: "azure-openai", name: "Azure OpenAI", tagline: "Deployments in your Azure OpenAI resource.", icon: "Z", auth: "API key", protocol: "azure", endpoint: "",
    fields: [
      f("endpoint", "Resource endpoint", "url", true, { placeholder: "https://my-resource.openai.azure.com" }),
      f("apiKey", "API key", "secret", true),
      f("apiVersion", "API version", "text", true, { default: "2024-10-21", pattern: "^\\d{4}-\\d{2}-\\d{2}(-preview)?$", patternMsg: "An API version looks like 2024-10-21." }),
    ],
    invocable: false, invocationNote: GATEWAY_NOTE, custom: false, residency: "Stays in the Azure region of your resource.",
  },
  {
    id: "gemini", name: "Google Gemini", tagline: "Gemini through Google AI Studio.", icon: "G", auth: "API key", protocol: "gemini", endpoint: "https://generativelanguage.googleapis.com",
    fields: [f("apiKey", "API key", "secret", true, { placeholder: "AIza...", help: "From aistudio.google.com." })],
    invocable: false, invocationNote: GATEWAY_NOTE, custom: false, residency: "Processed by Google; no region guarantee.",
  },
  {
    id: "vertex", name: "Google Vertex AI", tagline: "Gemini in your Google Cloud project.", icon: "V", auth: "Service account", protocol: "vertex", endpoint: "https://{location}-aiplatform.googleapis.com",
    fields: [
      f("location", "Location", "text", true, { default: "us-central1", pattern: "^[a-z]+-[a-z]+\\d+$", patternMsg: "A location looks like us-central1." }),
      f("serviceAccount", "Service account key (JSON)", "secret", true, { help: "The JSON key of a service account with the Vertex AI User role." }),
    ],
    invocable: false, invocationNote: GATEWAY_NOTE, custom: false, residency: "Stays in the chosen Google Cloud location.",
  },
  {
    id: "openai-compatible", name: "OpenAI-compatible endpoint", tagline: "Any server with a /v1/models list: LiteLLM, vLLM, Ollama, OpenRouter.", icon: "C", auth: "Bearer key (optional)", protocol: "openai", endpoint: "",
    fields: [
      f("endpoint", "Base URL", "url", true, { placeholder: "https://llm.example.com/v1" }),
      f("apiKey", "API key", "secret", false, { help: "Leave empty for a server on your own network without one." }),
      f("anthropicCompat", "Also accepts the Anthropic Messages API (/v1/messages)", "bool", false, { help: "Turn on when the server translates Messages (LiteLLM does). Agents can only run on models of a server that does." }),
    ],
    invocable: false, invocationNote: "Agents call models with the Anthropic Messages API. Tick the box when this server accepts it; otherwise models are listed but stay off.", custom: true, residency: "Wherever the server runs.",
  },
];

export const vendorTemplate = (id: string): VendorTemplate | undefined => VENDOR_TEMPLATES.find((t) => t.id === id);

/** The template's endpoint with its placeholders filled from the entered values. */
export function templateEndpoint(t: VendorTemplate, values: Record<string, string>): string {
  const raw = t.endpoint || values.endpoint || "";
  return raw.replace("{region}", values.region ?? "").replace("{location}", values.location ?? "").replace(/\/+$/, "");
}

/** Checks entered values against a template's fields. Returns the first problem in words, or null. */
export function validateTemplateValues(t: VendorTemplate, values: Record<string, string>): string | null {
  for (const fl of t.fields) {
    const v = (values[fl.key] ?? "").trim();
    if (!v) {
      if (fl.required) return `${fl.label} is required.`;
      continue;
    }
    if (fl.type === "select" && fl.options && !fl.options.includes(v)) return `${fl.label} must be one of ${fl.options.join(", ")}.`;
    if (fl.pattern && !new RegExp(fl.pattern).test(v)) return fl.patternMsg ?? `${fl.label} is not valid.`;
    if (fl.type === "url") {
      try {
        const u = new URL(v);
        if (u.protocol !== "https:" && u.protocol !== "http:") return `${fl.label} must start with https://.`;
      } catch {
        return `${fl.label} must be a full URL.`;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ known models ----- */

export interface KnownModel {
  /** Same model on any vendor shares this id (same-model fallback). */
  canonical: string;
  name: string;
  tier: "fast" | "standard" | "frontier";
  /** Tokens, used when the vendor's list does not say. */
  context: number;
  /** US dollars per million tokens. */
  inPrice: number;
  outPrice: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * A vendor's model id reduced to the id the same model has everywhere: lower case, no region or vendor prefix (`us.anthropic.`, `models/`),
 * no Bedrock `-v1:0` or date suffix, dots as dashes.
 */
export function canonicalModelId(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^models\//, "").replace(/^publishers\/[^/]+\/models\//, "");
  s = s.replace(/^(us|eu|apac|global|us-gov|jp|au)\./, "");
  s = s.replace(/^(anthropic|openai|google|meta|mistral|amazon|cohere|ai21|deepseek)\./, "");
  s = s.replace(/-v\d+(:\d+)?$/, "").replace(/:\d+$/, "");
  s = s.replace(/\./g, "-").replace(/@\d{8}$/, "").replace(/-\d{8}$/, "").replace(/-latest$/, "");
  return s;
}

type Rule = [RegExp, Omit<KnownModel, "canonical" | "name"> & { name?: string }];
const R = (re: RegExp, inPrice: number, outPrice: number, context: number, tier: KnownModel["tier"], extra: Partial<KnownModel> = {}): Rule => [re, { inPrice, outPrice, context, tier, ...extra }];

/** First match wins, so the narrower rule goes first. Prices are the public list prices; where unsure a model is left out and the person enters them. */
const RULES: Rule[] = [
  R(/^claude-opus-(4-1|4|3)$/, 15, 75, 200_000, "frontier"),
  R(/^claude-opus-(4-[5-9]|[5-9](-\d+)?)$/, 5, 25, 500_000, "frontier"),
  R(/^claude-sonnet-([3-9])(-\d+)?$/, 3, 15, 200_000, "standard"),
  R(/^claude-3-7-sonnet$/, 3, 15, 200_000, "standard"),
  R(/^claude-3-5-sonnet$/, 3, 15, 200_000, "standard"),
  R(/^claude-(haiku-4-5|haiku-[5-9](-\d+)?)$/, 1, 5, 200_000, "fast"),
  R(/^claude-3-5-haiku$/, 0.8, 4, 200_000, "fast"),
  R(/^claude-3-haiku$/, 0.25, 1.25, 200_000, "fast"),
  R(/^claude-3-opus$/, 15, 75, 200_000, "frontier"),
  R(/^gpt-5(-\d+)?$/, 1.25, 10, 400_000, "frontier"),
  R(/^gpt-5-mini$/, 0.25, 2, 400_000, "standard"),
  R(/^gpt-5-nano$/, 0.05, 0.4, 400_000, "fast"),
  R(/^gpt-4-1$/, 2, 8, 1_047_576, "standard"),
  R(/^gpt-4-1-mini$/, 0.4, 1.6, 1_047_576, "fast"),
  R(/^gpt-4-1-nano$/, 0.1, 0.4, 1_047_576, "fast"),
  R(/^gpt-4o$/, 2.5, 10, 128_000, "standard"),
  R(/^gpt-4o-mini$/, 0.15, 0.6, 128_000, "fast"),
  R(/^o3$/, 2, 8, 200_000, "frontier"),
  R(/^o4-mini$/, 1.1, 4.4, 200_000, "standard"),
  R(/^o3-mini$/, 1.1, 4.4, 200_000, "standard"),
  R(/^gemini-2-5-pro$/, 1.25, 10, 1_048_576, "frontier"),
  R(/^gemini-2-5-flash$/, 0.3, 2.5, 1_048_576, "standard"),
  R(/^gemini-2-5-flash-lite$/, 0.1, 0.4, 1_048_576, "fast"),
  R(/^gemini-2-0-flash$/, 0.1, 0.4, 1_048_576, "fast"),
];

const prettyName = (canonical: string): string =>
  canonical.split("-").map((w, i, a) => (/^\d+$/.test(w) ? (/^\d+$/.test(a[i - 1] ?? "") ? `.${w}` : ` ${w}`) : ` ${w.charAt(0).toUpperCase()}${w.slice(1)}`)).join("").replace(/ \./g, ".").replace(/^ /, "").replace(/\bGpt\b/, "GPT");

/** What the catalogue knows about a vendor's model id, or null (the person then enters price and context). */
export function knownModel(raw: string): KnownModel | null {
  const canonical = canonicalModelId(raw);
  for (const [re, m] of RULES) if (re.test(canonical)) return { canonical, name: m.name ?? prettyName(canonical), ...m };
  return null;
}

/** A readable name for a model the catalogue does not know. */
export const modelDisplayName = (raw: string): string => prettyName(canonicalModelId(raw));
