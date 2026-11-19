/**
 * Shared pieces of the agent sessions (the onboarding session per repository, the work-order session per work order): the question card with clickable suggested answers,
 * a progress line, and the streaming state of one live agent turn. The sessions differ in their rows, cards and commands; how a turn streams and how a question looks do not.
 */
import { fmt } from "@gantry/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { Btn } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";

/** Keeps a conversation thread scrolled to its newest message. Only the thread scrolls (never the page or an ancestor), so the banner and composer around it stay put. */
export function useThreadEnd<T extends HTMLElement>(...deps: unknown[]) {
  const thread = useRef<T>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const t = thread.current; if (t) t.scrollTop = t.scrollHeight; }, deps);
  return thread;
}

export interface QuestionState { answered?: string | undefined; answeredBy?: string | undefined; via?: string | undefined; answeredAt?: string | undefined; answerQuote?: string | undefined; superseded?: boolean | undefined; supersededBy?: string | undefined }

/** What closed a question, in words: "Answered by your message at 14:05: '...'", "You answered: ...", or "Replaced by a newer question". */
function closedLine(q: QuestionState): string {
  if (q.superseded && q.answered === undefined) return "Replaced by a newer question.";
  if (q.via === "message") {
    const t = q.answeredAt ? Date.parse(q.answeredAt) : NaN;
    return `Answered by your message${Number.isNaN(t) ? "" : ` at ${fmt.ist(t)}`}: “${q.answerQuote ?? q.answered ?? ""}”`;
  }
  return `You answered: ${q.answered ?? ""}`;
}

/**
 * The agent's question as its own panel ("Intake Clerk asks"): the wording in normal weight and the suggested answers as chips (shown whole, wrapped),
 * only while it is open and the latest. An answered or replaced question is one quiet line ("Answered: All three together") that opens to the full wording and what closed it.
 */
export function QuestionCard({ question, options, asker, answered, answeredBy, via, answeredAt, answerQuote, superseded, supersededBy, answer, last }: { question: string; options: string[]; asker?: string | undefined; answer: (t: string) => void; last: boolean } & QuestionState) {
  const closed = answered !== undefined || superseded === true;
  if (closed) {
    const replaced = superseded === true && answered === undefined;
    return (
      <details className={`cv-ask osx-question is-closed${replaced ? " is-superseded" : " is-answered"}`} aria-label="Question from the agent, closed">
        <summary className="cv-ask-sum"><Icon name={replaced ? "undo" : "check"} /><span className="cv-ask-state">{replaced ? "Replaced:" : "Answered:"}</span><span className="cv-ask-a">{replaced ? question : (answerQuote ?? answered)}</span></summary>
        <div className="cv-ask-body small">
          <p className="cv-ask-q">{question}</p>
          <p className="muted osx-answered">{closedLine({ answered, answeredBy, via, answeredAt, answerQuote, superseded, supersededBy })}</p>
        </div>
      </details>
    );
  }
  return (
    <article className="cv-ask osx-question" aria-label="Question from the agent">
      <h4 className="cv-ask-h">{asker ? `${asker} asks` : "Asks"}</h4>
      <p className="cv-ask-q">{question}</p>
      {options.length && last ? <div className="cv-ask-opts osx-options" role="group" aria-label="Suggested answers">{options.map((o) => <Btn key={o} small cls="osx-opt cv-chip" label={o} onClick={() => answer(o)} />)}</div> : null}
    </article>
  );
}

export const ProgressLine = ({ text, detail }: { text: string; detail?: string | undefined }) => (
  <p className="osx-progress small"><Icon name="check" /> {text}{detail ? <span className="muted">{` · ${detail}`}</span> : null}</p>
);

export interface Live<C> { text: string; tools: string[]; cards: C[] }
export type TurnEvent<C> =
  | { event: "text"; data: { delta: string } }
  | { event: "tool"; data: { name: string; ok: boolean } }
  | { event: "card"; data: { card: C } }
  | { event: "done"; data: { messageId: string } }
  | { event: "error"; data: { code: string; msg: string } };

/** The live state of one streamed agent turn: text as it arrives, the tools it calls, the cards it puts up; and the error that ended it. */
export function useLiveTurn<C>(run: (on: (e: TurnEvent<C>) => void, signal: AbortSignal) => Promise<{ ok: boolean; msg: string }>, onError?: (msg: string) => void) {
  const [live, setLive] = useState<Live<C> | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const start = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setError("");
    setLive({ text: "", tools: [], cards: [] });
    const ac = new AbortController();
    const res = await run((e) => {
      if (e.event === "text") setLive((l) => l && { ...l, text: l.text + e.data.delta });
      else if (e.event === "tool") setLive((l) => l && { ...l, tools: [...l.tools, e.data.name] });
      else if (e.event === "card") setLive((l) => l && { ...l, cards: [...l.cards, e.data.card] });
      else if (e.event === "error") setError(e.data.msg);
    }, ac.signal);
    setLive(null);
    busy.current = false;
    if (!res.ok) { setError(res.msg); onError?.(res.msg); }
  }, [run, onError]);
  return { live, error, start, setError };
}
