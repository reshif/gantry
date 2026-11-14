import { z } from "zod";

/** Scopes a key may carry (legacy KEY_ACTIONS). `wo.read` and `triggers.run` exist only for keys; the others are catalogue actions. */
export const KEY_ACTIONS = ["wo.submit", "wo.read", "wo.answer", "triggers.run"] as const;
export const KEY_ACTION_LABELS: Record<(typeof KEY_ACTIONS)[number], string> = {
  "wo.submit": "Submit work orders", "wo.read": "Read work orders", "wo.answer": "Answer intake questions", "triggers.run": "Fire triggers",
};

export const IdParam = z.object({ id: z.string().min(1).max(100) });
export const CreateKeyBody = z.looseObject({
  name: z.string().trim().min(1, "Name the key.").max(100),
  project: z.string().min(1).max(100),
  actions: z.array(z.enum(KEY_ACTIONS)).min(1, "Pick at least one scope.").max(KEY_ACTIONS.length).optional(),
  /** Days until the key stops working; null for no expiry (spec 12.5: keys expire, so the default is 90). */
  expiresInDays: z.number().int().min(1).max(730).nullable().optional(),
});
export const ConfigBody = z.looseObject({
  rateLimit: z.number().int().min(1).max(6000).optional(),
  burst: z.number().int().min(0).max(1000).optional(),
  idempotencyHours: z.number().int().min(1).max(168).optional(),
  webhookSigning: z.enum(["HMAC-SHA256"]).optional(),
  triggersEnabled: z.boolean().optional(),
});
export const RequestsQuery = z.object({
  key: z.string().max(100).optional(),
  status: z.enum(["all", "2xx", "429", "4xx"]).optional(),
  cursor: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
