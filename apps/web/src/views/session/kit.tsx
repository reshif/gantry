/**
 * Shared pieces of the agent sessions (the onboarding session per repository, the work-order session per work order): the question card with clickable suggested answers,
 * a progress line, and the streaming state of one live agent turn. The sessions differ in their rows, cards and commands; how a turn streams and how a question looks do not.
 */
import { useCallback, useRef, useState } from "react";
import { Btn } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";

export function QuestionCard({ question, options, answered, answer, last }: { question: string; options: string[]; answered?: string | undefined; answer: (t: string) => void; last: boolean }) {
  return (
    <article className={`osx-card osx-question${answered ? " is-answered" : ""}`} aria-label="Question from the agent">
      <strong>{question}</strong>
      {answered ? <p className="small muted osx-answered">{`You answered: ${answered}`}</p> : options.length && last ? <div className="osx-options">{options.map((o) => <Btn key={o} small label={o} onClick={() => answer(o)} />)}</div> : null}
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
