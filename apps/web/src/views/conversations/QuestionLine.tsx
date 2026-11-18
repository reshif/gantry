/** A station question that is answered (or dismissed): one line, so the thread keeps its place without the big card. The answer itself is the person's message right below, so it is only repeated when no such message exists. */
import { fmt } from "@gantry/domain";
import { Icon } from "../../ui/Icon";
import { useAgentLabel } from "./StationAvatar";
import { useActors } from "../../ui/actors";
import type { StationQuestion } from "../documents/api";

const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

export function QuestionLine({ q, times, replied }: { q: StationQuestion; times: number; replied?: boolean }) {
  const dismissed = q.status === "dismissed";
  const actor = useActors();
  const label = useAgentLabel();
  const by = q.answeredBy ? (actor(q.answeredBy).kind === "other" ? label(q.answeredBy) : actor(q.answeredBy).name.replace(" (agent)", "")) : "";
  const when = q.answeredAt ? fmt.stamp(q.answeredAt) : "";
  const tail = [by && `by ${by}`, when].filter(Boolean).join(", ");
  return (
    <p className="conv-ql small" id={`sq-${q.id.replace(/[^A-Za-z0-9_-]/g, "-")}`}>
      <Icon name="check" />{" "}
      <span className="conv-ql-q">{`${cap(q.station)} asked: ${q.question}`}</span>
      {times > 1 ? <span className="muted">{` (asked ${times} times)`}</span> : null}
      <span className="muted">{" — "}</span>
      <span className="conv-ql-a">{dismissed ? "Dismissed" : replied ? "Answered below" : `Answered: ${q.answer ?? ""}`}</span>
      {tail ? <span className="muted">{` · ${tail}`}</span> : null}
    </p>
  );
}
