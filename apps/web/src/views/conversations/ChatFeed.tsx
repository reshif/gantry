/**
 * The thread of the Conversations screen as a chat: station agents on the left with their avatar and name, people on the right in compact bubbles,
 * a person's answer pointing at its question in one line, runs of line events folded into one quiet row. Shaping is in thread-model.ts.
 */
import { useState, type ReactNode } from "react";
import { fmt } from "@gantry/domain";
import { StationAvatar } from "./StationAvatar";
import { Btn } from "../../ui/primitives";
import { Markdown } from "../console/Markdown";
import { agoShort } from "./ago";
import type { WoSession, WoSessionMessage } from "./session-api";
import { fromPerson, type FeedItem } from "./thread-model";

const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** The question a person's answer replies to: one line, and the whole question on request. */
function ReplyRef({ m, s }: { m: WoSessionMessage; s: WoSession }) {
  const [open, setOpen] = useState(false);
  const qid = (m.data.cards ?? []).find((c) => c.kind === "station_question")?.id;
  const q = s.dialogue.questions.find((x) => x.id === qid);
  if (!q) return null;
  return (
    <Btn kind="quiet" small cls={`cmsg-ref${open ? " is-open" : ""}`} icon="back" label={`replying to ${cap(q.station)}: ${q.question}`} aria={`Replying to ${cap(q.station)}: ${q.question}`} aria-expanded={open} onClick={() => setOpen(!open)} />
  );
}

function EventRun({ items, show }: { items: WoSessionMessage[]; show: boolean }) {
  const [open, setOpen] = useState(false);
  const expanded = show || open;
  return (
    <div className="cev">
      <Btn kind="quiet" small cls="cev-t" icon="dots" label={`${items.length} line event${items.length === 1 ? "" : "s"}`} aria-expanded={expanded} onClick={() => setOpen(!open)} />
      {expanded ? <ul className="cev-l">{items.map((m) => <li key={m.id} className="small"><span className="muted">{fmt.stamp(m.at)}</span>{` ${m.text}`}</li>)}</ul> : null}
    </div>
  );
}

export function ChatFeed({ s, feed, showEvents, nameOf, cards, markers }: { s: WoSession; feed: FeedItem[]; showEvents: boolean; nameOf: (m: WoSessionMessage) => string; cards: (m: WoSessionMessage) => ReactNode; markers: (m: WoSessionMessage) => ReactNode }) {
  return (
    <>
      {feed.map((it) => {
        if (it.kind === "events") return <EventRun key={it.key} items={it.items} show={showEvents} />;
        const m = it.m;
        const me = fromPerson(m);
        const body = m.data.kind === "answer" ? <p className="bub">{m.text}</p>
          : m.text ? (!me && m.author !== "system" && m.data.mode === "agent" ? <div className="bub" style={{ whiteSpace: "normal" }}><Markdown text={m.text} /></div> : <p className="bub">{m.text}</p>) : null;
        return (
          <div key={it.key} className={`cmsg ${me ? "is-me me" : "is-agent"}${it.head ? " has-head" : ""}`} data-author={m.author}>
            {markers(m)}
            {me ? null : <span className="cmsg-av">{it.head ? <StationAvatar id={m.author} fallback={nameOf(m)} /> : null}</span>}
            <div className="msg cmsg-b">
              {it.head ? <div className="who">{nameOf(m)}{m.data.mode === "rule-based" ? <span className="muted"> · rule-based</span> : null}<span className="mono dim">{` ${agoShort(m.at)}`}</span></div> : null}
              {m.data.kind === "answer" ? <ReplyRef m={m} s={s} /> : null}
              {body}
              {(m.data.mentions ?? []).filter((x) => !x.access).map((x) => <p key={x.id} className="small muted wos-mention-note">{`${x.name} cannot open this project yet. Mentioning them did not give them access: a project admin was asked.`}</p>)}
              {cards(m)}
            </div>
          </div>
        );
      })}
    </>
  );
}
