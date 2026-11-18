/** The Agent Workspace (services/api routes/workspace.ts). Keys start with `workspace`, which work-order, console and repo changes refresh. */
import { qk } from "../../api/keys";
import { useQuery } from "@tanstack/react-query";
import { api, del, get, patch, post } from "../../api/client";
import { invalidateSlices } from "../../api/keys";

export type ScopeKind = "factory" | "project" | "work_order" | "repo";
export type ThreadKind = "primary" | "onboarding" | "chat" | "side";
export interface InboxItem {
  key: string;
  kind: ThreadKind;
  scope: { kind: ScopeKind; id: string | null; label: string };
  project: string | null;
  title: string;
  agent: string | null;
  agentName: string | null;
  waitingOn: "you" | "approver" | "agent" | "person" | "nobody";
  unread: boolean;
  latest: { text: string; at: number; by: string; role: string } | null;
  updatedAt: number;
  archived: "auto" | "thread" | "me" | null;
  pinned: boolean;
  mine: boolean;
  shared: boolean;
  owner: string | null;
  visibility: "private" | "project" | null;
  spendUsd: number | null;
  wo?: { cls: string; station: string; stationName: string; state: string; bay: string | null; gate: string | null; closed: boolean };
}
export interface Hit { kind: "message" | "document" | "source" | "question"; key: string; ref: string; title: string; snippet: string; at: number; rank: number; project: string | null; by: string | null }
export interface OpItem { wo: string; project: string; title: string; station: string; since: number; why: string; who?: string; key: string; costUsd?: number; limitUsd?: number | null }
export interface OperatorView {
  stuck: OpItem[]; waiting: OpItem[]; budget: OpItem[];
  chats: { people: Array<{ person: string; usd: number; answers: number; capUsd: number | null }>; threads: Array<{ key: string; title: string; owner: string; usd: number; agent: string | null; scope: string }> };
  projects: string[]; capUsd: number | null; canEditCap: boolean; canSeePeople: boolean; quietMinutes: number;
}
export interface WsAgent { id: string; name: string; station: string; stationName: string }
/** A chat as the console's thread read returns it, with the workspace's fields. */
export interface ChatMeta {
  id: string; title: string; owner: string; scope: { kind: ScopeKind; id: string | null }; projectId: string | null; agentId: string | null;
  visibility: "private" | "project"; status: "active" | "archived"; archivedAt: number | null; archivedBy: string | null; members: string[]; can?: { post: boolean; manage: boolean };
}

const enc = encodeURIComponent;
export const wk = { inbox: (all: boolean) => ["workspace", "inbox", all] as const, search: (q: string, kinds: string) => ["workspace", "search", q, kinds] as const, operator: () => ["workspace", "operator"] as const };

export const useInbox = (all = false) => useQuery({ queryKey: wk.inbox(all), queryFn: () => get<{ items: InboxItem[] }>(api(`workspace/inbox${all ? "?all=1" : ""}`)), refetchInterval: 30_000 });
export const useWsAgents = (wo: string | null) => useQuery({ queryKey: qk.wsAgents(wo ?? ""), queryFn: () => get<{ items: WsAgent[] }>(api(`workspace/agents${wo ? `?wo=${enc(wo)}` : ""}`)), staleTime: 60_000 });
export const useSearch = (q: string, kinds: string) =>
  useQuery({ queryKey: wk.search(q, kinds), queryFn: () => get<{ items: Hit[] }>(api(`workspace/search?q=${enc(q)}${kinds ? `&kinds=${enc(kinds)}` : ""}`)), enabled: q.trim().length >= 2, staleTime: 10_000 });
export const useOperator = (on: boolean) => useQuery({ queryKey: wk.operator(), queryFn: async () => {
      const v = await get<OperatorView>(api("workspace/operator"));
      // A read that is not the operator view (an empty or unrelated body) is a failed read, never a half-drawn panel.
      if (!v || !Array.isArray(v.stuck) || !Array.isArray(v.waiting) || !Array.isArray(v.budget) || !v.chats || !Array.isArray(v.chats.people) || !Array.isArray(v.projects)) throw new Error("The operator view came back in a shape this app does not know.");
      return v;
    }, enabled: on, refetchInterval: 30_000 });

const done = <T extends { ok: boolean }>(r: T): T => {
  if (r.ok) invalidateSlices(["workspace", "console"]);
  return r;
};
export const createThread = async (b: { scope: { kind: ScopeKind; id: string | null }; agent?: string | null; title?: string; visibility?: "private" | "project" }) =>
  done(await post<{ id: string; key: string; title: string; visibility: string }>(api("workspace/threads"), b));
export const patchThread = async (key: string, b: { pinned?: boolean; archived?: boolean; title?: string; visibility?: "private" | "project" }) => done(await patch(api(`workspace/threads/${enc(key)}`), b));
export const invite = async (id: string, person: string) => done(await post(api(`workspace/threads/${enc(id)}/members`), { person }));
export const removeMember = async (id: string, person: string) => done(await del(api(`workspace/threads/${enc(id)}/members/${enc(person)}`)));
export const exportUrl = (key: string, format: "md" | "json") => api(`workspace/threads/${enc(key)}/export?format=${format}`);

/** Splits a snippet on the server's ⟦ ⟧ marks: odd parts are matches. Shown as plain text, never as HTML. */
export const snippetParts = (s: string): Array<{ text: string; hit: boolean }> => s.split(/⟦|⟧/).map((text, i) => ({ text, hit: i % 2 === 1 })).filter((p) => p.text);

/** Inbox filters. "Needs me": waits on the person (a question, a proposal, a gate they may decide). "Active": not archived. */
export type InboxFilter = "needs" | "active" | "mine" | "shared" | "archived";
export function filterInbox(items: InboxItem[], f: InboxFilter): InboxItem[] {
  if (f === "archived") return items.filter((i) => i.archived);
  const live = items.filter((i) => !i.archived);
  if (f === "needs") return live.filter((i) => i.waitingOn === "you");
  if (f === "mine") return live.filter((i) => i.mine || (i.kind === "chat" && !i.shared));
  if (f === "shared") return live.filter((i) => (i.kind === "chat" || i.kind === "side") && !i.mine);
  return live;
}
/** Groups for the inbox list, in a fixed order. */
export const GROUPS: Array<{ id: string; label: string; kinds: ThreadKind[] }> = [
  { id: "wo", label: "Work orders", kinds: ["primary"] },
  { id: "side", label: "Side threads", kinds: ["side"] },
  { id: "repo", label: "Repositories", kinds: ["onboarding"] },
  { id: "chat", label: "Factory chats", kinds: ["chat"] },
];
