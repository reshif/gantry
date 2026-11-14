import { z } from "zod";
import { CUSTOM_CATEGORIES } from "./connectors.js";

const id = z.string().trim().min(1).max(120);
const ProjectScope = z.union([z.literal("all"), z.array(id).max(200)]);
const SecretMap = z.record(z.string().min(1).max(60), z.string().max(8000));

export const IdParam = z.object({ id });
export const TypeIdParam = z.object({ type: id });

const Field = z.object({
  key: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]{0,23}$/, "Field keys are letters and digits, starting with a letter."),
  label: z.string().trim().min(1).max(80),
  type: z.enum(["text", "url", "secret", "select", "bool", "number"]),
  required: z.boolean().optional(),
  placeholder: z.string().max(200).optional(),
  options: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
});

export const CustomTypeBody = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,23}$/).optional(),
  name: z.string().trim().min(1).max(80),
  category: z.enum(CUSTOM_CATEGORIES).default("custom"),
  icon: z.string().trim().max(24).default("plug"),
  auth: z.enum(["token", "oauth", "hmac", "basic", "app", "smtp", "none"]).default("hmac"),
  payload: z.enum(["json", "cloudevents", "form", "blocks", "adaptive", "html"]).default("json"),
  source: z.boolean().default(false),
  destination: z.boolean().default(true),
  targetLabel: z.string().trim().max(80).default("Target"),
  fields: z.array(Field).max(20).default([]),
  events: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  actions: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  /** Templated HTTP out: the request body, with `{{head}}`, `{{woId}}`, `{{link}}`... placeholders. Empty sends the event envelope. */
  httpTemplate: z.object({ method: z.enum(["POST", "PUT"]).default("POST"), body: z.string().max(20_000).default(""), contentType: z.string().trim().max(100).default("application/json") }).optional(),
});

export const TestBody = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
  /** The first secret field's value (legacy shape), or `secrets` keyed by field key. */
  secret: z.string().max(8000).optional(),
  secrets: SecretMap.optional(),
});

export const AddInstanceBody = TestBody.extend({
  type: id,
  name: z.string().trim().min(1).max(80),
  projects: ProjectScope.optional(),
  targetId: z.string().trim().max(40).optional(),
  /** Instances are created switched off (spec 15.3). Pass true to switch it on as part of creating it. */
  enable: z.boolean().optional(),
  via: z.string().optional(),
});

export const PatchInstanceBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().max(8000).optional(),
  secrets: SecretMap.optional(),
  projects: ProjectScope.optional(),
  connected: z.boolean().optional(),
  via: z.string().optional(),
});

export const LinkBody = z.object({ channel: z.enum(["slack"]).default("slack"), integration: id.optional() });
