import { z } from "zod";

export const MessageBody = z.object({
  threadId: z.string().min(1).max(60).nullish(),
  text: z.string().trim().min(1, "Write a question.").max(8000),
  /** The project the person is looking at (context only; the tools still filter to what they may see). */
  project: z.string().min(1).max(100).nullish(),
  via: z.literal("console").optional(),
  /** The model chosen in the console header for this message; checked on every message. Absent: the person's saved choice, else the routing default. */
  model: z.string().min(1).max(200).nullish(),
});
export const ModelBody = z.object({ model: z.string().min(1).max(200).nullable() });
export const StatusQuery = z.object({ project: z.string().min(1).max(100).optional() });
export const ThreadId = z.object({ id: z.string().min(1).max(60) });
export const PinnedBody = z.object({ pinned: z.array(z.string().regex(/^WO-\d{3,6}$/)).max(50) });
export const ProposalParams = z.object({ id: z.string().min(1).max(60), pid: z.string().min(1).max(40) });
export const ProposalBody = z.object({ status: z.enum(["done", "failed", "dismissed"]), result: z.string().max(500).default("") });
/** The only outcome the browser may write itself is "dismissed" (it changes nothing). A card is done or failed only by the server running it (POST .../confirm). */
export const ProposalConfirmBody = z.object({ reason: z.string().max(2000).optional(), confirmText: z.string().max(200).optional(), inFlight: z.string().max(40).optional() });
export const SettingsBody = z.object({ actionsEnabled: z.boolean(), reason: z.string().trim().max(2000).optional() });
export const ToolParams = z.object({ name: z.string().min(1).max(60) });
export const ToolBody = z.object({ input: z.record(z.string(), z.unknown()).default({}) });
export const ExplainBody = z.object({
  person: z.string().min(1).max(100).nullish(),
  action: z.string().min(1).max(100),
  project: z.string().min(1).max(100).nullish(),
  repo: z.string().max(100).nullish(),
  time: z.number().finite().optional(),
});
