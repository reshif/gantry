/** The conversation as a chat: agent turns on the left with the station's avatar, the person's on the right, line events folded into one quiet row per run. */
import { useState, type ReactNode } from "react";
import { fmt } from "@gantry/domain";
import { Avatar } from "../../ui/primitives";
import { Markdown } from "../console/Markdown";
import { AnswerLead, Cards } from "./Cards";
import { buildTranscript, cap, questionViews, repliedTo, type Block } from "./chat";
import type { WoSession, WoSessionMessage } from "./session-api";

/** The prototype's message time: "13 Nov 15:43" (IST, as everywhere in the app). */
export const panelDate = (t: number): string => new Date(t).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata", hour12: false }).replace(",", "");

/** The person's answer: what they wrote, led by a one-line "replying to" that opens to the whole question. */
function Reply({ m, s }: { m: WoSessionMessage; s: WoSession }) {
  const [open, setOpen] = useState(false);
  const q = repliedTo(m, s);
  return (
    <div className="cv-reply">
      {q ? <AnswerLead open={open} toggle={() => setOpen(!open)} label={`${cap(q.station)}: ${q.question}`} why={q.why} /> : null}
      <p className="cv-text">{m.text}</p>
    </div>
  );
}

function EventRun({ items }: { items: WoSessionMessage[] }) {
  if (items.length === 1) return <p className="cv-event small muted"><span>{fmt.stamp(items[0]!.at)}</span>{` ${items[0]!.text}`}</p>;
  return (
    <details className="cv-events small muted">
      <summary>{`${items.length} line events`}<span>{` · ${fmt.stamp(items[0]!.at)}`}</span></summary>
      <ul>{items.map((m) => <li key={m.id}><span>{fmt.stamp(m.at)}</span>{` ${m.text}`}</li>)}</ul>
    </details>
  );
}

export function Transcript({ s, blocks, agent, nameOf, mine, send, lastId }: { s: WoSession; blocks: Block[]; agent: string; nameOf: (m: WoSessionMessage) => ReactNode; mine: string | undefined; send: (b: { kind: "message" | "continue"; text?: string }) => void; lastId: string | undefined }) {
  const view = { views: questionViews(s.dialogue.questions) };
  return (
    <>
      {blocks.map((b) => {
        if (b.t === "events") return <EventRun key={b.key} items={b.items} />;
        const first = b.msgs[0]!;
        const you = b.side === "person" && b.author === mine;
        return (
          <div key={b.key} className={`cv-turn is-${b.side}${you ? " is-you" : ""}`}>
            {b.side === "agent" ? <Avatar id={b.author} /> : null}
            <div className="cv-col">
              <div className="cv-who">{you ? "You" : nameOf(first)}<span className="muted">{` · ${panelDate(first.at)}`}</span></div>
              {b.msgs.map((m) => (
                <div key={m.id} className={`cv-msg${m.data.kind === "answer" ? " is-answer" : ""}`} title={panelDate(m.at)}>
                  {m.data.kind === "answer" ? <Reply m={m} s={s} />
                    : m.text ? (m.role === "assistant" && m.data.mode === "agent" ? <div className="cv-text"><Markdown text={m.text} /></div> : <p className="cv-text">{m.text}</p>) : null}
                  {(m.data.mentions ?? []).filter((x) => !x.access).map((x) => <p key={x.id} className="small muted wos-mention-note">{`${x.name} cannot open this project yet. Mentioning them did not give them access: a project admin was asked.`}</p>)}
                  <Cards m={m} s={s} agent={agent} send={send} last={m.id === lastId} view={view} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

export { buildTranscript };
