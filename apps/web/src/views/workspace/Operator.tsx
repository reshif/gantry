/**
 * The operator view (Agents at work > Operator view): work that needs someone who runs the floor, in the projects where the person may park
 * work: stuck runs and work orders, what waits on people and for how long, work near or over its budget, and what chats cost per person.
 * Observed facts only; each row opens the work order's thread.
 */
import { fmt } from "@gantry/domain";
import { Async } from "../../ui/async";
import { Btn, Panel, Who } from "../../ui/primitives";
import { navigate } from "../../lib/router";
import { useOperator, type OpItem } from "./api";

const since = (t: number, now: number): string => (now - t < 60_000 ? "just now" : fmt.ago(t, now));

function Rows({ items, id, empty, onOpen, money }: { items: OpItem[]; id: string; empty: string; onOpen: (key: string) => void; money?: boolean }) {
  const now = Date.now();
  if (!items.length) return <p className="small muted" id={`${id}-empty`}>{empty}</p>;
  return (
    <ul className="ws-op-rows" id={id}>
      {items.map((r, i) => (
        <li key={`${r.key}-${i}`}>
          <button type="button" className="ws-op-row" id={`${id}-${r.wo}-${i}`} onClick={() => onOpen(r.key)}>
            <span className="mono strong">{r.wo}</span>
            <span className="ws-op-title">{r.title}</span>
            <span className="chip">{r.station}</span>
            <span className="ws-op-why small">{r.why}{r.who ? <span className="muted">{` · asks ${r.who}`}</span> : null}</span>
            <span className="mono small muted ws-op-t">{money && r.costUsd !== undefined ? `${r.costUsd.toFixed(2)} / ${(r.limitUsd ?? 0).toFixed(2)} USD` : since(r.since, now)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function OperatorPanel({ onOpen }: { onOpen: (key: string) => void }) {
  const q = useOperator(true);
  return (
    <section className="ws-results ws-op" aria-label="Operator view" id="ws-op">
      <header className="ws-chat-h">
        <h2 className="ws-chat-title">Operator view</h2>
        <span className="small muted">{q.data ? `${q.data.projects.length} project${q.data.projects.length === 1 ? "" : "s"} where you can park work` : ""}</span>
      </header>
      <Async query={q} what="the operator view" id="ws-op-q">{(v) => (
        <div className="ws-op-grid">
          <Panel title={`Stuck (${v.stuck.length})`}>
            <Rows id="ws-op-stuck" items={v.stuck} onOpen={onOpen} empty={`Nothing looks stuck: every live run has shown a step or a model call in the last ${v.quietMinutes} minutes.`} />
          </Panel>
          <Panel title={`Waiting on people (${v.waiting.length})`}>
            <Rows id="ws-op-waiting" items={v.waiting} onOpen={onOpen} empty="Nothing waits on a person." />
          </Panel>
          <Panel title={`Budget (${v.budget.length})`}>
            <Rows id="ws-op-budget" items={v.budget} onOpen={onOpen} money empty="No work order has used 80% of its budget, and no research plan is near its cap." />
          </Panel>
          <Panel title="Chat spending" tools={v.canEditCap ? <Btn small id="ws-op-cap" label="Set the cap" onClick={() => navigate("security")} /> : null}>
            <p className="small muted" id="ws-op-cap-line">{v.capUsd === null ? "No per-person cap on chats." : `Cap: ${v.capUsd.toFixed(2)} USD per person per 24 hours.`}</p>
            {v.canSeePeople ? (
              v.chats.people.length ? (
                <div className="table-scroll"><table className="table table-compact" id="ws-op-people">
                  <thead><tr><th>Person</th><th className="num">Last 24 h</th><th className="num">Answers</th></tr></thead>
                  <tbody>{v.chats.people.map((p) => <tr key={p.person} className={p.capUsd !== null && p.usd >= p.capUsd ? "is-over" : undefined}><td><Who id={p.person} /></td><td className="num mono">{`${p.usd.toFixed(2)} USD`}</td><td className="num mono">{p.answers}</td></tr>)}</tbody>
                </table></div>
              ) : <p className="small muted">No chat answers in the last 24 hours.</p>
            ) : <p className="small muted">Spending per person needs the right to see people.</p>}
            {v.chats.threads.length ? (
              <>
                <h4 className="kicker ws-op-sub">Most expensive chats this week</h4>
                <ul className="ws-op-rows">{v.chats.threads.map((t) => <li key={t.key} className="ws-op-chat small"><span>{t.title}</span><span className="muted">{t.scope}</span><Who id={t.owner} /><span className="mono">{`${t.usd.toFixed(2)} USD`}</span></li>)}</ul>
              </>
            ) : null}
          </Panel>
        </div>
      )}</Async>
    </section>
  );
}
