/**
 * The right pane of the Conversations page: the work order's header (id, title, station, state, Open record, the station that waits for you with a jump link),
 * a Conversation / Side threads (N) switch, and the chosen one in the body with its own scroll and the composer pinned under it. A side thread opens in this
 * same pane. Which tab, which side thread and whether line events show are in the URL.
 */
import { useMemo } from "react";
import { useWoSession, type WoSessionRow } from "./session-api";
import { Btn, Chip, Empty, Tabs } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useInbox, type InboxItem } from "../workspace/api";
import { ChatPane } from "../workspace/ChatPane";
import { WoSessionPage } from "./Session";
import { cap, waitingQuestion } from "./chat";

export type PaneState = { tab: "chat" | "side"; thread: string | null; events: boolean };

/** The chats and side threads that are about this work order. */
export function useSideThreads(woId: string): InboxItem[] {
  const all = useInbox(true).data?.items;
  return useMemo(() => (all ?? []).filter((i) => (i.kind === "side" || i.kind === "chat") && i.scope.kind === "work_order" && i.scope.id === woId), [all, woId]);
}

export function ConvPane({ woId, row, state, setState, back, openRecord }: { woId: string; row: WoSessionRow | null; state: PaneState; setState: (p: Partial<{ tab: string | null; thread: string | null; events: string | null }>) => void; back: () => void; openRecord: () => void }) {
  const s = useWoSession(woId).data;
  const side = useSideThreads(woId);
  const wait = s ? waitingQuestion(s) : null;
  const title = s?.wo.title ?? row?.title ?? "";
  const stationName = s ? (s.wo.bay ? `Bay · ${s.wo.bay}` : s.wo.stationName) : row?.stationName;
  const jump = () => {
    if (!wait) return;
    setState({ tab: null });
    setTimeout(() => document.getElementById(`sq-${wait.id.replace(/[^A-Za-z0-9_-]/g, "-")}`)?.scrollIntoView?.({ block: "center", behavior: "smooth" }), 0);
  };
  const picked = side.find((i) => i.key === state.thread) ?? side[0] ?? null;
  return (
    <section className="panel cv-pane" id="conv-detail" aria-label={`${woId} · ${title}`}>
      <header className="cv-head">
        <div className="cv-head-top">
          <Btn small kind="ghost" icon="back" cls="cv-back" id="conv-back" label="Conversations" onClick={back} />
          <span className="mono cv-id">{woId}</span>
          <h2 className="cv-title">{title}</h2>
        </div>
        <div className="cv-head-meta">
          {stationName ? <Chip text={stationName} /> : null}
          {s || row ? <Chip text={cap(s?.wo.state ?? row!.state)} cls="info" /> : null}
          {s?.wo.gate ? <Chip text={`Gate ${s.wo.gate.label}`} /> : null}
          <span className="grow" />
          <Btn small kind="ghost" icon="list" id="conv-events" cls={state.events ? "" : "is-off"} aria-pressed={state.events} label={state.events ? "Hide line events" : "Show line events"} onClick={() => setState({ events: state.events ? "hide" : null })} />
          <Btn small label="Open record" icon="record" id="conv-open-record" onClick={openRecord} />
        </div>
        {wait ? (
          <div className="cv-wait" id="conv-waiting" role="status">
            <Icon name="human" />
            <span className="cv-wait-t"><strong>{`${cap(wait.station)} is waiting for you`}</strong><span className="muted">{` · ${wait.question}`}</span></span>
            <Btn small kind="primary" label="Go to the question" id="conv-jump-q" onClick={jump} />
          </div>
        ) : null}
        <Tabs idPrefix="conv-tab" active={state.tab} onChange={(t) => setState({ tab: t === "chat" ? null : t })} items={[{ id: "chat", label: "Conversation" }, { id: "side", label: `Side threads (${side.length})` }]} />
      </header>
      {state.tab === "side" ? (
        <div className="cv-side" id="conv-side">
          {side.length ? (
            <>
              <ul className="cv-side-list" aria-label="Side threads on this work order">
                {side.map((i) => (
                  <li key={i.key}><Btn small kind="ghost" cls={i.key === picked?.key ? "is-on" : ""} aria-pressed={i.key === picked?.key} id={`conv-side-${i.key}`} label={<><span>{i.title}</span>{i.agentName ? <span className="muted">{` · ${i.agentName}`}</span> : null}{i.waitingOn === "you" ? <span className="chip info">asks you</span> : null}</>} onClick={() => setState({ thread: i.key })} /></li>
                ))}
              </ul>
              <div className="cv-side-body">{picked ? <ChatPane key={picked.key} id={picked.key} item={picked} onThread={(id) => setState({ thread: id })} /> : null}</div>
            </>
          ) : <Empty id="conv-side-empty" title="No side threads" text="Type @ and an agent's name in the conversation to ask it about this work order in a side thread." />}
        </div>
      ) : <WoSessionPage key={woId} woId={woId} panel events={state.events} back={back} />}
    </section>
  );
}
