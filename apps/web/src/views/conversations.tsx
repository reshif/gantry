/**
 * Conversations (#conversations): the LIST of work-order sessions for the current project (who is waiting on whom, the latest message, the station) and, with a work order
 * in the route (`#/p/<project>/conversations/<WO>`), that work order's agent conversation (views/conversations/Session.tsx). The list has no forms: every row opens a session.
 * Older links that ask for a conversation through the `openConversation` preference land on the session too.
 */
import { useEffect, useMemo } from "react";
import { ThreadList } from "./conversations/ThreadList";
import { groupSessions } from "./conversations/thread-model";
import { useMe, useProject } from "../api/queries";
import { pickProject } from "../lib/routes";
import { navigate, useHash } from "../lib/router";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { SearchBox, Segmented } from "../ui/primitives";
import { CrEmpty, Page } from "../ui/cr";
import { Async } from "../ui/async";
import { EmptyState, useCatalog } from "./projects/kit";
import { WoSessionPage } from "./conversations/Session";
import { useWoSessions } from "./conversations/session-api";
import { useUrlState } from "./work-orders/url-state";

export default function ConversationsView() {
  const hash = useHash();
  const me = useMe();
  const prefs = usePrefs();
  const cat = useCatalog();
  const projectId = me ? pickProject(me, prefs.project) : null;
  const projectQ = useProject(projectId);
  const project = projectQ.data ?? null;
  const q = useWoSessions(projectId ?? undefined);
  const [url, setUrl] = useUrlState(["q", "c", "f"] as const);
  // A deep link from an older screen (the work orders table, the bell, the record) asks for one conversation: land on its session.
  const pending = prefs.openConversation;
  useEffect(() => {
    if (!pending) return;
    updatePrefs({ openConversation: null });
    navigate("conversations", pending);
  }, [pending]);
  const items = useMemo(() => [...(q.data?.items ?? [])].sort((a, b) => (b.latest?.at ?? b.createdAt) - (a.latest?.at ?? a.createdAt)), [q.data]);
  if (!me || !cat) return <div className="view conv-view" />;
  if (!projectId) return <div className="view"><EmptyState title="No project" text="You do not have a project to show." /></div>;
  if (!project) return <div className="view"><Async query={projectQ} what="this project" id="conv-project">{() => null}</Async></div>;
  const needle = url.q.trim().toLowerCase();
  const bySearch = items.filter((w) => !needle || `${w.title} ${w.id} ${w.agentName ?? ""} ${w.stationName}`.toLowerCase().includes(needle));
  const counts = Object.fromEntries(groupSessions(bySearch).map((g) => [g.id, g.rows.length])) as Record<string, number | undefined>;
  const f = url.f === "needs" || url.f === "active" || url.f === "done" ? url.f : "";
  const shown = groupSessions(bySearch).filter((g) => !f || g.id === f).flatMap((g) => g.rows);
  // As in the prototype, the first conversation is open on a wide screen until one is picked.
  const wide = typeof window !== "undefined" && window.innerWidth >= 768;
  // `?c=` is the prototype's way to name a conversation (here a work order); the path form `/conversations/<WO>` still works.
  const asked = hash.param ?? (url.c && items.some((w) => w.id === url.c) ? url.c : null);
  const cur2 = asked ?? (wide ? (shown[0]?.id ?? null) : null);
  return (
    <Page eyebrow="Operate" title="Conversations" cls="conv-view" sub="Talk to the agent on a work order. Answers are recorded on the record.">
      <div className={`conv${cur2 ? " has" : ""}`}>
        <div className="card conv-list" hidden={false}>
          <div className="card-b" style={{ padding: 8 }}>
            <SearchBox id="conv-q" value={url.q} onChange={(v) => setUrl({ q: v })} placeholder="Search conversations" label="Search conversations" />
            <Segmented name="conv-f" label="Show conversations" value={f} onChange={(v) => setUrl({ f: v })} items={[{ id: "", label: "All" }, { id: "needs", label: "Needs you", count: counts.needs ?? 0 }, { id: "active", label: "Active" }, { id: "done", label: "Done" }]} />
          </div>
          <div className="card-b flush conv-list-s" data-keep-scroll="conv-list">
            <Async query={q} what="conversations" id="conv-list">{() => shown.length ? (
              <ThreadList rows={shown} projectId={project.id} current={cur2} onOpen={(id) => { if (hash.param) navigate("conversations", null); setUrl({ c: id }); }} />
            ) : (
              <CrEmpty icon="chat" title="No conversations" />
            )}</Async>
          </div>
        </div>
        {cur2 ? (
          <WoSessionPage key={cur2} woId={cur2} proto back={() => { setUrl({ c: "" }); navigate("conversations", null); }} embedded />
        ) : (
          <div className="card"><CrEmpty icon="chat" title="Pick a conversation" text="Choose one on the left to read or reply." /></div>
        )}
      </div>
    </Page>
  );
}
