/**
 * The connector contract (spec 12.1). Built-in and custom types share one shape: a manifest (id, category, version), a config schema whose
 * `secret` fields are sealed and returned masked, capabilities, operations (test, health, send) and delivery rules. The first version ships
 * real GitHub (through gantry-github), Slack, SMTP email and a signed outbound webhook. The catalogue lists the rest as not yet available.
 * Custom types are limited to a signed webhook in and templated HTTP out.
 */
import { randomBytes } from "node:crypto";
import { INTEGRATION_TYPES, type IntegrationField, type IntegrationType } from "@gantry/domain";

export type Capability = "notify" | "interactive" | "trigger_source" | "identity";

export interface Manifest {
  /** Connector version: bumped when the config schema or the operations change. */
  version: string;
  capabilities: Capability[];
  operations: Array<"test" | "health" | "send" | "receive">;
  delivery: {
    /** What makes a delivery unique: the event id and the destination. A retry sends the same key. */
    idempotencyKey: string;
    retryable: string;
    permanent: string;
    rateLimit: string;
  };
}

export interface ConnectorType extends IntegrationType {
  manifest: Manifest;
}

const DELIVERY = { idempotencyKey: "event id + destination", retryable: "network errors, HTTP 408, 425, 429 and 5xx, Slack rate limits", permanent: "other 4xx, bad channel or token, a refused recipient", rateLimit: "backoff with jitter; Slack Retry-After honoured" };

const f = (key: string, label: string, type: IntegrationField["type"], required: boolean, extra: Partial<IntegrationField> = {}): IntegrationField => ({ key, label, type, required, ...extra });

/** Real connectors. Their field sets replace the legacy sketch where the real service needs different settings. */
const REAL: Record<string, Partial<ConnectorType> & { manifest: Manifest }> = {
  github: {
    name: "GitHub",
    auth: "app",
    fields: [
      f("org", "Organisation", "text", true),
      f("host", "Host", "url", false, { placeholder: "https://github.com (cloud) or your Enterprise URL" }),
      f("webhookSecret", "Webhook secret", "secret", true),
    ],
    manifest: { version: "1.0.0", capabilities: ["trigger_source", "identity"], operations: ["test", "health", "receive"], delivery: { ...DELIVERY, idempotencyKey: "X-GitHub-Delivery id (inbound)" } },
  },
  slack: {
    fields: [
      f("workspace", "Workspace", "text", true),
      f("botToken", "Bot token", "secret", true),
      f("signingSecret", "Signing secret", "secret", true),
      f("defaultChannel", "Default channel", "text", false, { placeholder: "#factory-gates" }),
      f("approve", "Allow approvals from Slack", "bool", false),
      f("approveGates", "Gates that may be approved from Slack", "text", false, { placeholder: "G2, G3d (comma-separated gate ids; low-risk gates only)" }),
    ],
    events: ["message.posted", "button.clicked"],
    actions: ["post_card", "update_card", "dm"],
    manifest: { version: "1.0.0", capabilities: ["notify", "interactive", "identity"], operations: ["test", "health", "send", "receive"], delivery: DELIVERY },
  },
  email: {
    fields: [
      f("from", "From address", "text", true),
      f("smtpHost", "SMTP host", "text", false, { placeholder: "Blank uses the platform's SMTP relay" }),
      f("smtpPort", "SMTP port", "number", false, { placeholder: "587" }),
      f("smtpUser", "SMTP user", "text", false),
      f("smtpPassword", "SMTP password", "secret", false),
    ],
    manifest: { version: "1.0.0", capabilities: ["notify"], operations: ["test", "health", "send"], delivery: { ...DELIVERY, retryable: "connection trouble, SMTP 4xx", permanent: "SMTP 5xx, a refused recipient" } },
  },
  webhook: {
    fields: [
      f("url", "Endpoint URL", "url", true),
      f("secret", "Signing secret", "secret", true),
      f("format", "Payload format", "select", true, { options: ["json", "cloudevents"] }),
    ],
    manifest: { version: "1.0.0", capabilities: ["notify"], operations: ["test", "health", "send"], delivery: { ...DELIVERY, idempotencyKey: "X-Gantry-Delivery id; the signature covers a timestamp and the body" } },
  },
};

const NOT_YET = "Not yet available in this version. It is listed so you can see what is coming.";

export function builtinTypes(): ConnectorType[] {
  return INTEGRATION_TYPES.map((t) => {
    const real = REAL[t.id];
    if (!real) {
      const reason = t.id === "teams" ? "Microsoft Teams is listed but not yet available: Gantry cannot send to Teams in this version." : NOT_YET;
      return { ...t, available: false, unavailableReason: reason, manifest: { version: "0.0.0", capabilities: [], operations: [], delivery: DELIVERY } };
    }
    const { manifest, ...over } = real;
    const out: ConnectorType = { ...t, ...over, available: true, manifest };
    delete (out as { unavailableReason?: string }).unavailableReason;
    return out;
  });
}

export const BUILTIN_IDS: ReadonlySet<string> = new Set(INTEGRATION_TYPES.map((t) => t.id));
export const REAL_IDS: ReadonlySet<string> = new Set(Object.keys(REAL));

/** Categories a custom type may use. Source control is excluded: a custom type cannot act as source control (spec 12.1). */
export const CUSTOM_CATEGORIES = ["chat", "email", "issues", "ci", "paging", "webhook", "custom"] as const;

export const typeCapabilities = (t: Pick<IntegrationType, "source" | "destination">): Capability[] => [...(t.destination ? (["notify"] as const) : []), ...(t.source ? (["trigger_source"] as const) : [])];

/**
 * Secrets that Gantry verifies deliveries with (the GitHub webhook secret, a Slack or hook signing secret) or signs with are chosen by an admin,
 * and a captured HMAC lets an attacker brute-force a short one offline and then forge deliveries. They need real entropy. Tokens issued by a
 * third party stay at the small minimum because Gantry cannot choose them.
 */
export const SIGNING_SECRET_MIN = 32;
/** A long but patterned value ("a" x 32, "abab...") has little entropy: it needs at least this many distinct characters. */
export const SIGNING_SECRET_MIN_DISTINCT = 8;
export const weakSigningSecret = (v: string): boolean => new Set(v).size < SIGNING_SECRET_MIN_DISTINCT;
/** A fresh random signing secret (256 bits, hex) for a form's "generate" button or an operator script. */
export const generateSigningSecret = (): string => randomBytes(32).toString("hex");
const SIGNING_KEYS: ReadonlySet<string> = new Set(["webhookSecret", "signingSecret", "secret"]);
const secretMin = (t: Pick<IntegrationType, "fields"> & { source?: boolean }, key: string): number => {
  const firstSecret = t.fields.find((x) => x.type === "secret")?.key;
  return SIGNING_KEYS.has(key) || (t.source === true && firstSecret === key) ? SIGNING_SECRET_MIN : 6;
};

/** Config validation by the type's schema. Returns the first problem, as a sentence the form shows. */
export function validateConfig(t: Pick<IntegrationType, "fields"> & { source?: boolean }, config: Record<string, unknown>, secrets: Record<string, string>, o: { needSecret: boolean }): string | null {
  for (const fld of t.fields) {
    if (fld.type === "bool") continue;
    if (fld.type === "secret") {
      const v = (secrets[fld.key] ?? "").trim();
      if (o.needSecret && fld.required !== false && !v) return `Add the ${fld.label.toLowerCase()}.`;
      const min = secretMin(t, fld.key);
      if (v && v.length < min) return min > 6 ? `${fld.label} must be at least ${min} characters (use a random value, for example the output of \`openssl rand -hex 32\`).` : `${fld.label} looks too short.`;
      if (v && min > 6 && weakSigningSecret(v)) return `${fld.label} is too repetitive: use a random value, for example the output of \`openssl rand -hex 32\`.`;
      continue;
    }
    const raw = config[fld.key];
    const v = raw == null ? "" : String(raw).trim();
    if (fld.required !== false && !v) return `Fill in ${fld.label}.`;
    if (fld.type === "url" && v && !/^https:\/\/[^\s/]+\.[^\s]+/.test(v) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(v)) return `${fld.label} must be an https URL.`;
    if (fld.type === "number" && v && Number.isNaN(Number(v))) return `${fld.label} must be a number.`;
    if (fld.type === "select" && v && fld.options && !fld.options.includes(v)) return `${fld.label} must be one of ${fld.options.join(", ")}.`;
  }
  return null;
}

/** Only the schema's own non-secret keys survive; numbers and booleans keep their type. */
export function cleanConfig(t: Pick<IntegrationType, "fields">, config: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const fld of t.fields) {
    if (fld.type === "secret") continue;
    const v = config[fld.key];
    if (v === undefined || v === null || v === "") continue;
    out[fld.key] = fld.type === "number" ? Number(v) : fld.type === "bool" ? v === true || v === "true" : String(v).trim();
  }
  return out;
}

/** The default target of an instance (where a notification goes when a route names none, and for the fallback of mandatory events). */
export function defaultTarget(typeId: string, config: Record<string, unknown>): string {
  if (typeId === "slack") return typeof config.defaultChannel === "string" && config.defaultChannel ? config.defaultChannel : "";
  if (typeId === "email") return "project admins";
  return "";
}
