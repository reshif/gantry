/**
 * Conversations (#conversations): the prototype's two panels. §1 Threads lists the work orders that have a conversation (the first 30, with the last
 * speaker's avatar, "WO-id · title", the last message and an "asks" chip when an agent waits on the person); §2 is the picked one, at
 * `#/p/<project>/conversations/<WO>` (the first thread that asks, or the first, when none is named): the work order's agent conversation
 * (views/conversations/Session.tsx) with an "Open record" button in the panel's tools. The list has no forms: every row opens a session.
 * Older links that ask for a conversation through the `openConversation` preference land on the session too.
 */
import { useEffect, useMemo } from "react";
import { useMe, useProject } from "../api/queries";
import { hashFor, navigate, useHash } from "../lib/router";
import { pickProject } from "../lib/routes";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Avatar, Btn, Chip, Empty, Panel, ViewHead } from "../ui/primitives";
import { Async } from "../ui/async";
import { useOpenTraveler } from "../shell/useTraveler";
import { WoSessionPage } from "./conversations/Session";
import { useWoSessions, type WoSessionRow } from "./conversations/session-api";

const THREADS = 30;

export default function ConversationsView() {
  const hash = useHash();
  const me = useMe();
  const prefs = usePrefs();
  const projectId = me ? pickProject(me, prefs.project) : null;
  const project = useProject(projectId).data ?? null;
  const q = useWoSessions(projectId ?? undefined);
  const openTraveler = useOpenTraveler();
  // A deep link from an older screen (the work orders table, the bell, the record) asks for one conversation: land on its session.
  const pending = prefs.openConversation;
  useEffect(() => {
    if (!pending) return;
    updatePrefs({ openConversation: null });
    navigate("conversations", pending);
  }, [pending]);
  const threads = useMemo(() => {
    const at = (w: WoSessionRow) => w.latest?.at ?? w.createdAt;
    return (q.data?.items ?? []).filter((w) => !!w.latest || w.started).sort((a, b) => at(b) - at(a));
  }, [q.data]);
  if (!me) return <div className="view conv-view" />;
  const sel = threads.find((w) => w.id === hash.param) ?? (hash.param ? null : threads.find((w) => w.waitingOn === "you") ?? threads[0] ?? null);
  const picked = hash.param ?? sel?.id ?? null;
  return (
    <div className="view conv-view">
      <ViewHead kicker={project?.key ?? ""} title="Conversations" sub="The dialogue between people and the agents at each station." />
      <div className="cols w12">
        <Panel title="Threads" flush id="conv-threads">
          <Async query={q} what="conversations" id="conv-list">{() => threads.length ? (
            <ul className="list" aria-label="Work-order conversations" data-keep-scroll="conv-list">
              {threads.slice(0, THREADS).map((w) => (
                <li key={w.id} id={`conv-item-${w.id}`} style={w.id === picked ? { background: "var(--accent-soft)" } : undefined} aria-current={w.id === picked ? "true" : undefined}>
                  <Avatar id={w.latest?.by ?? w.agent} />
                  <div className="grow">
                    <a className="pri trunc" style={{ display: "block" }} href={hashFor("conversations", w.id, w.project)}>{`${w.id} · ${w.title}`}</a>
                    <div className="small muted trunc">{w.latest?.text ?? ""}</div>
                  </div>
                  {w.waitingOn === "you" ? <Chip text="asks" cls="info" /> : null}
                </li>
              ))}
            </ul>
          ) : <Empty id="conv-empty" title="No conversations" text="" />}</Async>
        </Panel>
        {picked ? (
          <Panel title={sel ? `${picked} · ${sel.title}` : picked} id="conv-detail" tools={<><Btn small label="Traveler" id="conv-traveler" onClick={() => openTraveler(picked)} /><Btn small label="Open record" icon="record" id="conv-open-record" onClick={() => navigate("record", picked, sel?.project ?? projectId)} /></>}>
            <WoSessionPage key={picked} woId={picked} panel back={() => navigate("conversations", null)} />
          </Panel>
        ) : <Panel id="conv-detail"><Empty title="No conversations" text="" /></Panel>}
      </div>
    </div>
  );
}
