/**
 * Conversations (#conversations): two panes that fit the window. Left, the work orders that have a conversation, grouped Needs you / Active / Done with their own
 * scroll; right, the picked one at `#/p/<project>/conversations/<WO>` (the first that needs you, or the first, when none is named): a header, the chat with its
 * own scroll and the composer pinned under it, and the work order's side threads as a second tab. Search, filter, tab, side thread and whether line events show
 * are in the URL (`?q=&f=&tab=side&thread=&events=hide`). Under 768 px the list and the conversation are separate views with a back button.
 * Older links that ask for a conversation through the `openConversation` preference land on the session too.
 */
import { useEffect, useMemo } from "react";
import { useMe, useProject } from "../api/queries";
import { hashFor, hashPath, navigate, replaceHash, useHash } from "../lib/router";
import { pickProject } from "../lib/routes";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Btn, Empty, ViewHead } from "../ui/primitives";
import { Async } from "../ui/async";
import { ConvPane } from "./conversations/ConvPane";
import { ThreadList } from "./conversations/ThreadList";
import type { ThreadFilter } from "./conversations/chat";
import { useWoSessions } from "./conversations/session-api";

const KEEP = ["q", "f", "events"] as const;
const withQuery = (path: string, q: Record<string, string>): string => {
  const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  return s ? `${path}?${s}` : path;
};

export default function ConversationsView() {
  const hash = useHash();
  const me = useMe();
  const prefs = usePrefs();
  const projectId = me ? pickProject(me, prefs.project) : null;
  const project = useProject(projectId).data ?? null;
  const q = useWoSessions(projectId ?? undefined);
  // A deep link from an older screen (the work orders table, the bell, the record) asks for one conversation: land on its session.
  const pending = prefs.openConversation;
  useEffect(() => {
    if (!pending) return;
    updatePrefs({ openConversation: null });
    navigate("conversations", pending);
  }, [pending]);
  const threads = useMemo(() => (q.data?.items ?? []).filter((w) => !!w.latest || w.started), [q.data]);
  if (!me) return <div className="view conv-view" />;
  const query = hash.q;
  const search = query.q ?? "";
  const filter = (["needs", "active", "done"].includes(query.f ?? "") ? query.f : "all") as ThreadFilter;
  // the URL is the state: change a piece and keep the rest (replace, so filtering does not fill the back button)
  const here = (patch: Record<string, string | null>): string => {
    const next: Record<string, string> = { ...query };
    for (const [k, v] of Object.entries(patch)) { if (v) next[k] = v; else delete next[k]; }
    return withQuery(hashPath(window.location.hash), next);
  };
  const keep = (): Record<string, string> => Object.fromEntries(KEEP.filter((k) => query[k]).map((k) => [k, query[k]!]));
  const open = (id: string, pid?: string | null) => withQuery(hashFor("conversations", id, pid ?? projectId), keep());
  const needs = threads.find((w) => w.waitingOn === "you");
  const sel = threads.find((w) => w.id === hash.param) ?? (hash.param ? null : needs ?? threads[0] ?? null);
  const picked = hash.param ?? sel?.id ?? null;
  const pane = { tab: query.tab === "side" ? ("side" as const) : ("chat" as const), thread: query.thread ?? null, events: query.events !== "hide" };
  return (
    <div className="view conv-view" data-open={hash.param ? "chat" : "list"}>
      <ViewHead kicker={project?.key ?? ""} title="Conversations" sub="The dialogue between people and the agents at each station." actions={<Btn icon="chat" label="Side threads and chats" id="conv-all" onClick={() => navigate("workspace", "inbox")} />} />
      <div className="cv-grid">
        <section className="panel cv-listpane" id="conv-threads" aria-label="Threads">
          <Async query={q} what="conversations" id="conv-list">{() => (
            <ThreadList rows={threads} picked={picked} q={search} filter={filter} setQ={(v) => replaceHash(here({ q: v || null }))} setFilter={(f) => replaceHash(here({ f: f === "all" ? null : f }))} href={open} />
          )}</Async>
        </section>
        {picked ? (
          <ConvPane woId={picked} row={sel} state={pane}
            setState={(p) => replaceHash(here(p))}
            back={() => { window.location.hash = withQuery(hashFor("conversations", null), keep()); }}
            openRecord={() => navigate("record", picked, sel?.project ?? projectId)} />
        ) : <section className="panel cv-pane" id="conv-detail"><Empty title="No conversations" text="" /></section>}
      </div>
    </div>
  );
}
