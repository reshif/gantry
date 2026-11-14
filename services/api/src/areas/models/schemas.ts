import { z } from "zod";

const id = z.string().trim().min(1).max(100);
const via = z.string().max(20).optional();
const usd = z.coerce.number().finite().min(0).max(1_000_000);
export const RETENTION = ["zero", "30d", "standard"] as const;

export const IdParam = z.object({ id });
export const ProjectParam = z.object({ project: id });

export const VendorPatch = z
  .object({
    connected: z.boolean(),
    /** The API key or token. Sealed with the data key; never returned. */
    key: z.string().max(4096),
    region: z.string().trim().max(120),
    endpoint: z.string().trim().max(500),
    product: z.string().trim().max(120),
    budget: usd,
    residency: z.string().trim().max(500),
    retention: z.enum(RETENTION),
  })
  .partial()
  .strict();
export const SetVendorBody = z.object({ patch: VendorPatch, action: z.enum(["vendor.connect", "vendor.update", "vendor.disconnect"]).optional(), via }).strict();

export const AddVendorBody = z
  .object({
    name: z.string().trim().min(1, "Name the vendor.").max(80),
    endpoint: z.string().trim().max(500).optional(),
    key: z.string().max(4096).optional(),
    region: z.string().trim().max(120).optional(),
    retention: z.enum(RETENTION).optional(),
    residency: z.string().trim().max(500).optional(),
    via,
  })
  .strict();

export const AddModelBody = z
  .object({
    vendor: id,
    def: z
      .object({
        id: z.string().trim().max(120).optional(),
        name: z.string().trim().min(1, "Name the model.").max(120),
        inPrice: usd,
        outPrice: usd,
        context: z.coerce.number().int().min(1000).max(100_000_000).optional(),
        tier: z.enum(["fast", "standard", "frontier"]).optional(),
        canonical: z.string().trim().max(120).optional(),
        cacheRead: usd.optional(),
        cacheWrite: usd.optional(),
      })
      .strict(),
    via,
  })
  .strict();

export const ModelPatchBody = z
  .object({ enabled: z.boolean().optional(), context: z.coerce.number().int().min(1000).max(100_000_000).optional(), via })
  .strict()
  .refine((b) => b.enabled !== undefined || b.context !== undefined, "Nothing to change.");

export const AddVendorFromTemplateBody = z
  .object({
    template: id,
    name: z.string().trim().max(80).optional(),
    /** The template's fields by key. Secrets are sealed and never returned. */
    fields: z.record(z.string().max(100), z.string().max(8192)),
    retention: z.enum(RETENTION).optional(),
    via,
  })
  .strict();
export const DiscoverBody = z.object({ via }).strict();

const rec = z.record(id, id);
const ProjectRoutingSchema = z
  .object({
    defaultModel: id.optional(),
    overrides: rec.optional(),
    classOverrides: rec.optional(),
    allowedVendors: z.array(id).max(50).optional(),
    allowedRegions: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    allowedRetention: z.array(z.enum(RETENTION)).max(3).optional(),
    crossModelFallback: z.boolean().optional(),
  })
  .strict();
const RuleSchema = z.object({ id: z.string().trim().min(1).max(40), tag: z.string().trim().min(1).max(60), use: id, region: z.string().trim().max(60).default(""), alt: z.string().trim().max(100).default(""), note: z.string().trim().max(300).default("") }).strict();
export const RoutingSchema = z
  .object({
    defaultModel: id,
    overrides: rec.default({}),
    fallback: z.array(id).max(50),
    rules: z.array(RuleSchema).max(100).default([]),
    classOverrides: rec.optional(),
    projects: z.record(id, ProjectRoutingSchema).optional(),
    crossModelFallback: z.boolean().optional(),
    version: z.number().optional(),
  })
  .strict();
export const SetRoutingBody = z.object({ routing: RoutingSchema, label: z.string().trim().max(200).optional(), via }).strict();

const PriceSchema = z.object({ in: usd, out: usd, cacheRead: usd.optional(), cacheWrite: usd.optional() }).strict();
export const PricesBody = z
  .object({ prices: z.record(id, PriceSchema).refine((p) => Object.keys(p).length > 0, "Give at least one price."), effectiveFrom: z.string().datetime({ offset: true }).optional(), note: z.string().trim().max(300).optional(), via })
  .strict();

export const QualifyBody = z.object({ station: id, via }).strict();
export const BudgetBody = z.object({ perWorkOrder: usd, via }).strict();
export const ResolveQuery = z.object({ station: id, repo: id.optional(), project: id.optional(), class: id.optional(), model: id.optional() });
export const QuoteQuery = z.object({
  model: id,
  at: z.string().datetime({ offset: true }).optional(),
  input: z.coerce.number().int().min(0).default(0),
  output: z.coerce.number().int().min(0).default(0),
  cacheRead: z.coerce.number().int().min(0).default(0),
  cacheWrite: z.coerce.number().int().min(0).default(0),
});
