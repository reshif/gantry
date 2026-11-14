import { z } from "zod";

const Id = z.string().min(1).max(200);
const Names = z.array(Id).max(500);
export const ScopeIds = z.union([z.literal("all"), Names]);

export const AUTH_MODES = ["none", "bearer", "header"] as const;
export const SENSITIVITIES = ["public", "internal", "confidential", "restricted"] as const;
const Transport = z.preprocess((v) => (v === "streamable-http" || v === "streamable_http" ? "http" : v), z.enum(["http", "sse"]));
const HeaderName = z.string().trim().regex(/^[A-Za-z0-9-]{1,60}$/, "A header name is letters, digits and dashes.");
const Secret = z.string().min(1).max(4000);
const Url = z.string().trim().min(8).max(2000);

/** The connection part of a server, as sent to discovery. A secret is never echoed back. */
export const ConnectionFields = {
  transport: Transport.default("http"),
  url: Url,
  authMode: z.enum(AUTH_MODES).default("none"),
  authHeader: HeaderName.optional(),
  secret: Secret.optional(),
};

export const DiscoverBody = z.object({ ...ConnectionFields, name: z.string().trim().max(80).optional(), via: z.string().optional() });

/** What the admin chose in the Add dialog for a discovered tool. The definition and its hash come from a fresh discovery, never from the browser. */
export const ToolChoice = z.object({ name: z.string().min(1).max(300), write: z.boolean().optional(), allowed: z.boolean().optional() });

export const ScopeFields = {
  projects: ScopeIds.optional(),
  repos: ScopeIds.optional(),
  agents: ScopeIds.optional(),
  stations: ScopeIds.optional(),
  classes: ScopeIds.optional(),
};

export const AddBody = z.object({
  name: z.string().trim().min(1).max(80),
  ...ConnectionFields,
  sensitivity: z.enum(SENSITIVITIES).default("internal"),
  tools: z.array(ToolChoice).max(500).default([]),
  ...ScopeFields,
  via: z.string().optional(),
});

export const PatchBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  url: Url.optional(),
  transport: Transport.optional(),
  authMode: z.enum(AUTH_MODES).optional(),
  authHeader: HeaderName.nullable().optional(),
  secret: Secret.optional(),
  sensitivity: z.enum(SENSITIVITIES).optional(),
  enabled: z.boolean().optional(),
  tools: z.array(ToolChoice).max(500).optional(),
  ...ScopeFields,
  via: z.string().optional(),
});

export const IdParam = z.object({ id: Id });
export const GrantBody = z.object({ wo: Id, tools: z.array(z.string().regex(/^[^/\s]+\/(\*|[^\s]+)$/, "Use server/tool or server/*.")).min(1).max(50), via: z.string().optional() });

export const CheckQuery = z.object({
  server: Id,
  tool: z.string().min(1).max(300),
  agent: Id,
  project: Id,
  repo: Id.optional(),
  station: Id,
  cls: Id.optional(),
});

export const CallsQuery = z.object({
  server: Id.optional(),
  agent: Id.optional(),
  project: Id.optional(),
  outcome: z.enum(["allowed", "ok", "error", "denied"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  before: z.coerce.number().int().positive().optional(),
});
