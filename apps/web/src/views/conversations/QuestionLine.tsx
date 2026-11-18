/** A station question that is answered (or dismissed): one line with its answer, so the thread keeps its place without the big card. */
import { fmt } from "@gantry/domain";
import { Who } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import type { StationQuestion } from "../documents/api";

const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

export function QuestionLine({ q, times }: { q: StationQuestion; times: number }) {
  const dismissed = q.status === "dismissed";
  return (
    <p className="conv-ql small" id={`sq-${q.id.replace(/[^A-Za-z0-9_-]/g, "-")}`}>
      <Icon name="check" />
      <span className="conv-ql-q">{`${cap(q.station)} asked: ${q.question}`}</span>
      {times > 1 ? <span className="muted">{` (asked ${times} times)`}</span> : null}
      <span className="muted">{" — "}</span>
      <span className="conv-ql-a">{dismissed ? "Dismissed" : `Answered: ${q.answer ?? ""}`}</span>
      {q.answeredBy ? <span className="muted">{" · "}<Who id={q.answeredBy} />{q.answeredAt ? `, ${fmt.stamp(q.answeredAt)}` : ""}</span> : null}
    </p>
  );
}
