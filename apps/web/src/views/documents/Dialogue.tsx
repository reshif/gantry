/**
 * Questions a station agent asked and assumptions it proceeded on (agent workspace, Phase 1). A question shows whom it asks and why it matters;
 * the person asked answers in their own words, picks a suggestion, or says "I don't know" / "Not relevant". Every answer and every decision on an
 * assumption carries who gave it. The rights are the server's: a refusal comes back as the toast.
 */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { Btn, Chip, Who } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { answerQuestion, askOfText, decideAssumption, type Assumption, type StationQuestion } from "./api";

const station = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

export function StationQuestionCard({ woId, q, mine, canAnswer, why }: { woId: string; q: StationQuestion; mine: boolean; canAnswer: boolean; why?: string | undefined }) {
  const ui = useUI();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const open = q.status === "open";
  const send = async (kind: "answer" | "dont_know" | "not_relevant", answer?: string) => {
    setBusy(true);
    const r = await answerQuestion(woId, q.id, { kind, ...(answer ? { answer } : {}) });
    setBusy(false);
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (r.ok) setText("");
  };
  const fid = `sq-${q.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  return (
    <article className={`osx-card sq-card${open ? (q.blocking ? " is-blocking" : "") : " is-answered"}${mine && open ? " is-mine" : ""}`} id={fid} aria-label={`Question from ${station(q.station)}`}>
      <header className="osx-card-h">
        <strong className="sq-q">{q.question}</strong>
        <span className="osx-status">{open ? (q.blocking ? "Blocking" : "Open") : "Answered"}</span>
      </header>
      {q.why ? <p className="small sq-why"><span className="muted">Why it matters: </span>{q.why}</p> : null}
      <p className="small muted sq-meta">{`${station(q.station)} asks ${askOfText(q.askOf)}${mine && open ? " (you)" : ""}${q.blocking && open ? " · the station waits for the answer" : ""}`}</p>
      {!open ? (
        <p className="small sq-answer">
          <span className="sq-answer-text">{q.answer}</span>
          <span className="muted">{" — "}</span><Who id={q.answeredBy} />{q.answeredAt ? <span className="muted">{`, ${fmt.stamp(q.answeredAt)}`}</span> : null}
        </p>
      ) : canAnswer ? (
        <div className="osx-ask">
          {q.options.length ? <div className="osx-options">{q.options.map((o) => <Btn key={o} small label={o} disabled={busy} onClick={() => void send("answer", o)} />)}</div> : null}
          <label className="small" htmlFor={`${fid}-text`}>{mine ? "Your answer" : "Answer"}</label>
          <textarea id={`${fid}-text`} className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="osx-actions">
            <Btn kind="primary" small id={`${fid}-send`} label="Send answer" disabled={busy || !text.trim()} onClick={() => void send("answer", text.trim())} />
            <Btn small id={`${fid}-dk`} label="I don't know" disabled={busy} onClick={() => void send("dont_know", text.trim() || undefined)} />
            <Btn small id={`${fid}-nr`} label="Not relevant" disabled={busy} onClick={() => void send("not_relevant", text.trim() || undefined)} />
          </div>
        </div>
      ) : <p className="small muted">{why || "You may not answer on this work order."}</p>}
    </article>
  );
}

function AssumptionRow({ woId, a, canDecide }: { woId: string; a: Assumption; canDecide: boolean }) {
  const ui = useUI();
  const [fixing, setFixing] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (status: "confirmed" | "corrected") => {
    setBusy(true);
    const r = await decideAssumption(woId, a.id, { status, ...(status === "corrected" ? { note: note.trim() } : {}) });
    setBusy(false);
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (r.ok) setFixing(false);
  };
  const fid = `as-${a.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  return (
    <li className={`as-row is-${a.status}`} id={fid}>
      <div className="as-top">
        <span className="as-statement">{a.statement}</span>
        <Chip text={`${a.impact} impact`} cls={a.impact === "high" ? "chip-warn" : ""} />
      </div>
      {a.because ? <p className="small muted as-because">{`Because: ${a.because}`}</p> : null}
      {a.status === "open" ? (
        canDecide ? (
          fixing ? (
            <div className="osx-ask">
              <label className="small" htmlFor={`${fid}-note`}>What is true instead?</label>
              <textarea id={`${fid}-note`} className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="osx-actions">
                <Btn kind="primary" small id={`${fid}-save`} label="Save correction" disabled={busy || note.trim().length < 3} onClick={() => void run("corrected")} />
                <Btn small label="Cancel" onClick={() => setFixing(false)} />
              </div>
            </div>
          ) : (
            <div className="osx-actions">
              <Btn small id={`${fid}-ok`} label="Confirm" disabled={busy} onClick={() => void run("confirmed")} />
              <Btn small id={`${fid}-fix`} label="Correct it" disabled={busy} onClick={() => setFixing(true)} />
            </div>
          )
        ) : <p className="small muted">Not confirmed yet.</p>
      ) : (
        <p className="small as-decided">
          <span>{a.status === "confirmed" ? "Confirmed" : `Corrected: ${a.note ?? ""}`}</span>
          <span className="muted">{" — "}</span><Who id={a.decidedBy} />{a.decidedAt ? <span className="muted">{`, ${fmt.stamp(a.decidedAt)}`}</span> : null}
        </p>
      )}
    </li>
  );
}

export function AssumptionList({ woId, items, canDecide }: { woId: string; items: Assumption[]; canDecide: boolean }) {
  if (!items.length) return null;
  const open = items.filter((a) => a.status === "open").length;
  return (
    <section className="osx-card as-card" aria-label="Assumptions">
      <header className="osx-card-h">
        <strong>{`Assumptions from ${station(items[0]!.station)}`}</strong>
        <span className="osx-status">{open ? `${open} not confirmed` : "All decided"}</span>
      </header>
      <ul className="as-list">{items.map((a) => <AssumptionRow key={a.id} woId={woId} a={a} canDecide={canDecide} />)}</ul>
    </section>
  );
}
