/**
 * In-chat approval policy (spec 12.3, 15.3). Off by default. An administrator turns it on for a chat connection (`approve`) and names the gates that may be
 * approved there (`approveGates`). Never from chat: release (G6), the plan-and-security gate, hotfixes, anything on a security hold, and any risk-tagged change.
 * Kill and restore are not gates and have no chat path at all.
 */
export const NEVER_FROM_CHAT_GATES: ReadonlySet<string> = new Set(["G6", "G3G3s"]);

export const gatesNamed = (config: Record<string, unknown>): string[] =>
  typeof config.approveGates === "string" ? config.approveGates.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean) : [];

export type ChatApproval = { ok: true } | { ok: false; reason: string };

export function chatApprovalFor(config: Record<string, unknown>, gateId: string, wo: { cls: string; risk: string | null; position?: string; riskTags?: readonly string[] }): ChatApproval {
  if (config.approve !== true) return { ok: false, reason: "Approving from chat is switched off for this connection." };
  if (NEVER_FROM_CHAT_GATES.has(gateId)) return { ok: false, reason: "This gate is never approved from chat: open it in Gantry." };
  if (!gatesNamed(config).includes(gateId)) return { ok: false, reason: "This gate is not on the list of gates that may be approved from chat." };
  if (wo.cls === "hotfix") return { ok: false, reason: "Hotfixes are never approved from chat." };
  if (wo.position === "sechold") return { ok: false, reason: "A security hold is never released from chat." };
  if ((wo.riskTags && wo.riskTags.length) || wo.risk === "high") return { ok: false, reason: "A change with a risk tag is never approved from chat: open it in Gantry." };
  return { ok: true };
}
