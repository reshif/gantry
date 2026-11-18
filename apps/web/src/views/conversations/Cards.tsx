/** The cards of a work-order message (proposal, document, station question, assumptions, objection, research plan, scouts) and the person's answer text. */
import { fromPerson } from "../../lib/wo-message";
import { useState, type ReactNode } from "react";
import type { WoCard } from "@gantry/domain";
import { isBriefScaffold } from "@gantry/domain";
import { Btn, Chip, TextArea, Who } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { ProgressLine, QuestionCard } from "../session/kit";
import { decideWo, type WoSession, type WoSessionMessage } from "./session-api";
import { DocViewer } from "../documents/DocViewer";
import { AssumptionList, StationQuestionCard } from "../documents/Dialogue";
import type { StationQuestion } from "../documents/api";
import { ResearchPlanCard } from "../documents/Research";
import { ObjectionCard, SwarmBoard } from "../documents/Swarm";
import { cap, type QuestionView } from "./chat";
import { fmt } from "@gantry/domain";

type Proposal = Extract<WoCard, { kind: "proposal" }>;

/* ------------------------------------------------------------------ cards ---- */

export function BriefBlock({ b }: { b: NonNullable<Proposal["brief"]> }) {
  const sec = (label: string, xs: string[]) => (xs.length ? <div><strong className="small">{label}</strong><ul className="small wos-list">{xs.map((x) => <li key={x}>{x}</li>)}</ul></div> : null);
  return (
    <div className="wos-brief">
      <p className="wos-goal">{b.goal}</p>
      {sec("In scope", b.scopeIn)}{sec("Out of scope", b.scopeOut)}{sec("Acceptance criteria", b.ac)}{sec("Risks", b.risks)}{sec("Open questions", b.open)}{sec("Decisions", b.decisions)}
      {b.estimate ? <p className="small muted">{`Estimate: ${b.estimate}`}</p> : null}
    </div>
  );
}

function ProposalCard({ m, c, s, agent, send }: { m: WoSessionMessage; c: Proposal; s: WoSession; agent: string; send: (b: { kind: "continue" }) => void }) {
  const ui = useUI();
  const [asking, setAsking] = useState(false);
  const [full, setFull] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = c.status === "pending";
  const mayApprove = c.what === "brief" ? s.can.confirm : s.can.talk;
  const why = c.what === "brief" ? s.can.confirmWhy || "Only someone who may confirm briefs can approve this." : s.can.talkWhy;
  const run = async (d: "approve" | "changes" | "discard") => {
    setBusy(true);
    const r = await decideWo(s.woId, m.id, c.id, d, d === "changes" ? text : undefined);
    setBusy(false);
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (r.ok && d === "changes") { setAsking(false); setText(""); send({ kind: "continue" }); }
  };
  const label: Record<Proposal["status"], string> = { pending: "Waiting for you", approved: "Approved", changes: "Changes requested", discarded: "Discarded", superseded: "Replaced by a newer proposal", failed: "Failed" };
  const approveLabel = c.what === "brief" ? "Approve and confirm the brief" : c.what === "reclassify" ? `Approve: reclassify as ${c.cls?.name ?? ""}` : "Approve the decline";
  return (
    <article className={`osx-card osx-proposal is-${c.status}`} id={`wos-prop-${c.id}`} aria-label={c.title}>
      <header className="osx-card-h">
        <strong>{c.title}</strong>
        <Chip text={c.mode === "agent" ? `Drafted by ${agent}` : "Rule-based (no agent)"} cls={c.mode === "agent" ? "chip-accent" : ""} />
        <span className={`osx-status st-${c.status}`}>{label[c.status]}{c.decidedBy && c.status !== "superseded" ? <> · <Who id={c.decidedBy} /></> : null}</span>
      </header>
      <p className="small">{c.summary}</p>
      {c.what === "brief" && c.cls ? <p className="small muted">{`Class: ${c.cls.name}${c.cls.confidence !== undefined ? ` · ${Math.round(c.cls.confidence * 100)}%` : ""}${c.cls.rationale ? ` · ${c.cls.rationale}` : ""}`}</p> : null}
      {c.what === "brief" && c.changes ? (
        c.changes.length ? (
          <ul className="wos-diff" aria-label="What changes against the current brief">
            {c.changes.map((ch) => {
              // read from before/after so proposals stored before the rule changed show the same way: seeded placeholders are not
              // a person's words, and an open question that goes away was answered
              const gone = ch.before.filter((x) => !ch.after.includes(x));
              const removed = ch.field === "open" ? [] : gone.filter((x) => !isBriefScaffold(x));
              const resolved = ch.field === "open" ? gone : [];
              if (!removed.length && !ch.added.length && !resolved.length) return null;
              return (
                <li key={ch.field}>
                  <strong className="small">{ch.label}</strong>
                  {removed.map((x) => <div key={`r${x}`} className="small wos-minus">{`- ${x}`}</div>)}
                  {ch.added.map((x) => <div key={`a${x}`} className="small wos-plus">{`+ ${x}`}</div>)}
                  {resolved.map((x) => <div key={`q${x}`} className="small wos-resolved">{`Answered: ${x}`}</div>)}
                </li>
              );
            })}
          </ul>
        ) : <p className="small muted">No change against the brief as it stands.</p>
      ) : null}
      {c.what === "brief" && c.brief ? <><button type="button" className="linkish small" aria-expanded={full} onClick={() => setFull(!full)}>{full ? "Hide the full brief" : "Show the full brief"}</button>{full ? <BriefBlock b={c.brief} /> : null}</> : null}
      {c.route?.length ? <p className="small muted">{`Route: ${c.route.join(" → ")}`}</p> : null}
      {c.what !== "brief" && c.reason ? <p className="small">{`Reason (audited): ${c.reason}`}</p> : null}
      {c.what === "brief" ? <p className="muted small">Nothing is confirmed until a person approves. Approving confirms the brief at G0+G1 and starts the route.</p> : null}
      {pending ? (
        <div className="osx-actions">
          <Btn kind="primary" id={`wos-approve-${c.id}`} label={approveLabel} disabled={busy || !mayApprove} disabledReason={!mayApprove ? why : undefined} onClick={() => void run("approve")} />
          {c.what === "brief" ? <Btn id={`wos-changes-${c.id}`} label="Ask for changes" disabled={busy || !s.can.talk} onClick={() => setAsking(!asking)} /> : null}
          <Btn id={`wos-discard-${c.id}`} label="Discard" disabled={busy || !s.can.talk} onClick={() => void run("discard")} />
        </div>
      ) : null}
      {pending && asking ? (
        <div className="osx-ask">
          <label className="small" htmlFor={`wos-changes-text-${c.id}`}>What should change?</label>
          <TextArea id={`wos-changes-text-${c.id}`} rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: also cover the retry path, and leave the admin API out." />
          <Btn id={`wos-changes-send-${c.id}`} kind="primary" small label="Send" disabled={busy || text.trim().length < 3} onClick={() => void run("changes")} />
        </div>
      ) : null}
    </article>
  );
}

/** Opens a station document in the viewer, in a wide dialog over the conversation. */
export function useOpenDocument() {
  const ui = useUI();
  return (woId: string, id?: string, project?: string) => ui.dialog({ title: "Station documents", kicker: woId, wide: true, body: <DocViewer woId={woId} initial={id} project={project} />, actions: [{ label: "Close" }] });
}

function DocLine({ s, c }: { s: WoSession; c: Extract<WoCard, { kind: "document" }> }) {
  const open = useOpenDocument();
  return (
    <button type="button" className="osx-file wos-doc" id={`wos-doc-${c.id}`} onClick={() => open(s.woId, c.id, s.project)}>
      <Icon name="page" />
      <span className="mono">{c.name}</span>
      <span className="muted small">{`version ${c.version}`}</span>
      <span className="wos-doc-open small">Read</span>
    </button>
  );
}

/** A document as a compact attachment chip: name and version, opens the viewer. */
function DocChip({ s, c }: { s: WoSession; c: Extract<WoCard, { kind: "document" }> }) {
  const open = useOpenDocument();
  return <Btn small kind="ghost" icon="page" cls="cv-doc" id={`wos-doc-${c.id}`} label={<><span className="mono">{c.name}</span>{" "}<span className="muted">{`v${c.version}`}</span></>} onClick={() => open(s.woId, c.id, s.project)} />;
}

/** A question that has its answer (or was dropped): one line, the answer after it, the full card one click away. */
function QuestionLine({ q }: { q: StationQuestion & { mine: boolean } }) {
  const done = q.status === "answered";
  const who = q.answeredBy ? <Who id={q.answeredBy} /> : null;
  return (
    <details className="cv-qline" id={`sq-${q.id.replace(/[^A-Za-z0-9_-]/g, "-")}`}>
      <summary>
        <Icon name={done ? "check" : "x"} />
        <span className="cv-qline-q">{`${cap(q.station)} asked: ${q.question}`}</span>
        <span className="cv-qline-a muted">{done ? `Answered: ${q.answer ?? ""}` : "Not needed"}</span>
      </summary>
      <div className="cv-qline-body small">
        {q.why ? <p><span className="muted">Why it matters: </span>{q.why}</p> : null}
        {who ? <p>{who}{q.answeredAt ? <span className="muted">{` ${fmt.stamp(q.answeredAt)}`}</span> : null}</p> : null}
      </div>
    </details>
  );
}

/** What a message's cards look like in the chat view: attachments as chips, the open question once (with how often it was asked), answered ones in a line, notes folded. */
export interface CardsView { views: Map<string, QuestionView> }

function Folded({ title, children }: { title: string; children: ReactNode }) {
  return <details className="cv-fold"><summary>{title}</summary>{children}</details>;
}

export function Cards({ m, s, agent, send, last, view }: { m: WoSessionMessage; s: WoSession; agent: string; send: (b: { kind: "message" | "continue"; text?: string }) => void; last: boolean; view?: CardsView }) {
  return (
    <>
      {(m.data.cards ?? []).map((c, i) => {
        if (view) {
          if (c.kind === "document") return <DocChip key={i} s={s} c={c} />;
          if (c.kind === "station_question") {
            const q = s.dialogue.questions.find((x) => x.id === c.id);
            const v = view.views.get(c.id);
            if (!q || fromPerson(m) || v?.shown === false) return null;
            if (q.status !== "open") return <QuestionLine key={i} q={q} />;
            return (
              <div key={i} className="cv-q">
                {v && v.times > 1 ? <span className="chip cv-asked">{`asked ${v.times} times`}</span> : null}
                <StationQuestionCard woId={s.woId} q={q} mine={q.mine} canAnswer={s.can.talk} why={s.can.talkWhy} />
              </div>
            );
          }
          if (c.kind === "assumptions") {
            const items = s.dialogue.assumptions.filter((a) => a.station === c.station && (!c.attempt || a.attemptId === c.attempt));
            const open = items.filter((a) => a.status === "open").length;
            return items.length ? <Folded key={i} title={`Assumptions from ${cap(c.station)} (${items.length})${open ? `, ${open} not confirmed` : ""}`}><AssumptionList woId={s.woId} items={items} canDecide={s.can.talk} /></Folded> : null;
          }
          if (c.kind === "objection") {
            const o = s.dialogue.objections.find((x) => x.id === c.id);
            return !o || fromPerson(m) ? null : <Folded key={i} title={`Objection from ${cap(o.station)}`}><ObjectionCard woId={s.woId} o={o} canDecide={s.research.canDecide} /></Folded>;
          }
        }
        if (c.kind === "progress") return <ProgressLine key={i} text={c.text} detail={c.detail} />;
        if (c.kind === "question") return <QuestionCard key={i} question={c.question} options={c.options} answered={c.answered} last={last} answer={(t) => send({ kind: "message", text: t })} />;
        if (c.kind === "document") return <DocLine key={i} s={s} c={c} />;
        if (c.kind === "swarm") return s.swarm ? <SwarmBoard key={i} woId={s.woId} sw={s.swarm} canStop={!!s.can.park} stopWhy={s.can.parkWhy} /> : null;
        if (c.kind === "objection") {
          const o = s.dialogue.objections.find((x) => x.id === c.id);
          return !o || fromPerson(m) ? null : <ObjectionCard key={i} woId={s.woId} o={o} canDecide={s.research.canDecide} />;
        }
        if (c.kind === "research_plan") return fromPerson(m) ? null : <ResearchPlanCard key={i} woId={s.woId} r={s.research} />;
        if (c.kind === "station_question") {
          const q = s.dialogue.questions.find((x) => x.id === c.id);
          // A person's answer quotes the question it answers; the card itself lives on the agent's message.
          if (!q || fromPerson(m)) return null;
          return <StationQuestionCard key={i} woId={s.woId} q={q} mine={q.mine} canAnswer={s.can.talk} why={s.can.talkWhy} />;
        }
        if (c.kind === "assumptions") {
          const items = s.dialogue.assumptions.filter((a) => a.station === c.station && (!c.attempt || a.attemptId === c.attempt));
          return <AssumptionList key={i} woId={s.woId} items={items} canDecide={s.can.talk} />;
        }
        return <ProposalCard key={i} m={m} c={c} s={s} agent={agent} send={send} />;
      })}
    </>
  );
}

/** A person's answer to a station question, quoting the question so the thread reads on its own. */
export function AnswerText({ m, s }: { m: WoSessionMessage; s: WoSession }) {
  const qid = (m.data.cards ?? []).find((c) => c.kind === "station_question")?.id;
  const q = s.dialogue.questions.find((x) => x.id === qid);
  return (
    <div className="osx-text wos-answer">
      {q ? <p className="small muted wos-answer-q">{`Answer to ${q.station.charAt(0).toUpperCase()}${q.station.slice(1)}: “${q.question}”`}</p> : null}
      <p className="wos-answer-a">{m.text}</p>
    </div>
  );
}

/** The one line a person's answer opens with: "replying to: <station>: <question>", the whole question and why it mattered one click away. */
export function AnswerLead({ open, toggle, label, why }: { open: boolean; toggle: () => void; label: string; why?: string }) {
  return (
    <div className="cv-lead">
      <Btn small kind="quiet" cls="cv-lead-btn" label={<><Icon name="undo" /><span className="muted">replying to:</span>{" "}<span className={open ? "" : "trunc"}>{label}</span></>} aria-expanded={open} onClick={toggle} />
      {open && why ? <p className="small muted">{`Why it matters: ${why}`}</p> : null}
    </div>
  );
}
