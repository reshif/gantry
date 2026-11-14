/** Wire shapes of the console API (services/api/src/routes/console.ts). */
export interface Cited { type: "wo" | "project" | "repo" | "agent" | "person" | "gate"; id: string; label?: string; project?: string }

export interface ProposalCheck { allowed: boolean; reason: string; needs: string; rule?: string }
export interface Proposal {
  id: string;
  kind: "submit" | "approve" | "halt" | "resume" | "kill" | "restore" | "park" | "trust" | "onboard";
  title: string;
  summary: string;
  steps: string[];
  call: { method: "POST" | "DELETE"; path: string; body: Record<string, unknown>; idempotent: boolean };
  perm: { action: string; project?: string | null };
  check: ProposalCheck;
  needsReason: number | null;
  phrase: string | null;
  danger: boolean;
  entities: Cited[];
  status: "pending" | "done" | "failed" | "dismissed";
  result?: string;
}

export interface ConsoleStatus {
  configured: boolean;
  vendor?: string;
  model?: string;
  code?: string;
  reason?: string;
  actionsEnabled: boolean;
  version: number;
  retentionDays: number;
  tools: Array<{ name: string; kind: "read" | "propose"; description: string }>;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: number;
  data: { mode?: string; model?: string | null; cited?: Cited[]; proposals?: Proposal[]; tools?: string[]; stopped?: boolean; truncated?: boolean; kind?: string; code?: string; project?: string };
}
export interface Thread {
  id: string;
  title: string;
  pinned: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  retentionDays: number;
  messages: ThreadMessage[];
}
export interface ThreadSummary { id: string; title: string; pinned: string[]; updatedAt: number; expiresAt: number; retentionDays: number; count?: number }

export interface ToolResult { ok: boolean; tool: string; result: unknown; proposals: Proposal[]; cited: Cited[] }

export interface ExplainResult {
  mode: "model" | "trace";
  explanation: string | null;
  note: string;
  person: string;
  action: string;
  decision: { allowed: boolean; reason: string; rule: { id: string; name?: string }; needs: string };
  trace: string[];
}

/** What the transcript shows: server messages plus the client-side answers to slash commands. */
export interface Card { type: string; data?: unknown; proposal?: Proposal }
export interface Msg {
  id: string;
  role: "user" | "factory";
  at: number;
  text: string;
  /** model: answered by the model; slash: read directly from live data; none: no model, a notice; error: the answer failed. */
  mode: "model" | "slash" | "none" | "error" | "pending";
  by?: string;
  cited?: Cited[];
  cards?: Card[];
  stopped?: boolean;
  note?: string;
  streaming?: boolean;
  /** The persisted assistant message that carried these proposals. */
  serverId?: string;
}
