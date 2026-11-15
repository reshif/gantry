/**
 * The work-order session (spec 8.4): one agent conversation per work order, for its whole life, at `#/p/<project>/conversations/<WO>`. The current station's agent (the Intake
 * Clerk at Intake) reads the request and the repository, asks in natural language, and proposes the brief; a person approves, asks for changes or discards. Updates from the
 * belt (a station finished, a gate decided) arrive in the same thread. The composer is always there; a status line always says who waits on whom. Side panel: the work
 * order, the belt, the brief as it stands, what is proposed, what it cost.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WoCard } from "@gantry/domain";
import { fmt, isBriefScaffold } from "@gantry/domain";
import { ops } from "../../api/ops";
import { Btn, Chip, Empty, Who } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { setProject } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { useOpenRecordRoute } from "../record/nav";
import { Markdown } from "../console/Markdown";
import { ApproversPanel } from "../traveler/Approvers";
import { ProgressLine, QuestionCard, useLiveTurn } from "../session/kit";
import { decideWo, markWoSeen, sendWoTurn, useWoSession, type WoSession, type WoSessionMessage } from "./session-api";

type Proposal = Extract<WoCard, { kind: "proposal" }>;

/* ------------------------------------------------------------------ cards ---- */

function BriefBlock({ b }: { b: NonNullable<Proposal["brief"]> }) {
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
          <textarea id={`wos-changes-text-${c.id}`} className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: also cover the retry path, and leave the admin API out." />
          <Btn id={`wos-changes-send-${c.id}`} kind="primary" small label="Send" disabled={busy || text.trim().length < 3} onClick={() => void run("changes")} />
        </div>
      ) : null}
    </article>
  );
}

function Cards({ m, s, agent, send, last }: { m: WoSessionMessage; s: WoSession; agent: string; send: (b: { kind: "message" | "continue"; text?: string }) => void; last: boolean }) {
  return (
    <>
      {(m.data.cards ?? []).map((c, i) =>
        c.kind === "progress" ? <ProgressLine key={i} text={c.text} detail={c.detail} />
        : c.kind === "question" ? <QuestionCard key={i} question={c.question} options={c.options} answered={c.answered} last={last} answer={(t) => send({ kind: "message", text: t })} />
        : <ProposalCard key={i} m={m} c={c} s={s} agent={agent} send={send} />)}
    </>
  );
}

/* ------------------------------------------------------------------ the page ---- */

export function WoSessionPage({ woId, back }: { woId: string; back: () => void }) {
  const q = useWoSession(woId);
  const s = q.data;
  const ui = useUI();
  const openTraveler = useOpenTraveler();
  const openRecord = useOpenRecordRoute();
  const [draft, setDraft] = useState("");
  const opened = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const turn = useRef<{ kind: "message" | "open" | "continue"; text?: string }>({ kind: "open" });
  const run = useCallback((on: Parameters<typeof sendWoTurn>[2], signal: AbortSignal) => sendWoTurn(woId, turn.current, on, signal), [woId]);
  const { live, error, start } = useLiveTurn<WoCard>(run, (m) => ui.toast(m, "error"));
  const send = (body: { kind: "message" | "open" | "continue"; text?: string }) => { turn.current = body; void start(); };

  const ruleBased = s?.agent.mode === "rule-based";
  const started = !!s && s.messages.some((m) => m.data.kind !== "update" && m.data.mode !== "legacy");
  // The dialogue starts by itself when a person who may talk opens a work order at Intake that has none yet (the agent speaks first).
  useEffect(() => {
    if (!s || opened.current || started || ruleBased || s.busy || !s.can.talk || !s.briefOpen) return;
    opened.current = true;
    send({ kind: "open" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.woId, started, ruleBased, s?.busy, s?.can.talk, s?.briefOpen]);
  const seenKey = s ? `${s.messages.length}:${s.messages.at(-1)?.id ?? ""}` : "";
  useEffect(() => { if (seenKey) void markWoSeen(woId); }, [seenKey, woId]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [s?.messages.length, live?.text]);
  useEffect(() => { if (s) setProject(s.project); }, [s?.project]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastId = s?.messages.at(-1)?.id;
  const firstSession = useMemo(() => s?.messages.findIndex((m) => m.data.mode !== "legacy") ?? -1, [s]);
  if (!s) return <div className="osx"><Async query={q} what="this conversation" id="conv-session">{() => null}</Async><Btn label="Back to conversations" small kind="ghost" icon="back" onClick={back} /></div>;

  const agentName = s.agent.name;
  const submit = () => { const t = draft.trim(); if (!t) return; setDraft(""); send({ kind: "message", text: t }); };
  const status = live ? { cls: "is-live", text: `${agentName} is thinking…` }
    : s.wo.closed ? { cls: "is-idle", text: s.next.text }
    : s.next.actor === "you" ? { cls: "is-you", text: ruleBased ? "Waiting for you: answer the question below" : `${agentName} is waiting for you` }
    : s.next.actor === "approver" ? { cls: "is-wait", text: s.next.text }
    : { cls: "is-live", text: s.waiting?.text ?? s.next.text };
  const placeholder = !s.can.talk ? `Read-only: ${s.can.talkWhy || "you may not act on this work order."}` : ruleBased ? "Reply to the scripted question (rule-based, no agent)" : `Message ${agentName}: answer, correct it, or ask anything about this work order`;
  const tag = (m: WoSessionMessage) => (m.role === "user" ? <Who id={m.author} /> : m.data.mode === "legacy" ? "Intake Clerk (scripted)" : m.author === "system" ? "Gantry" : (m.data.agent ?? agentName));

  return (
    <div className="osx wos" id="wos" data-wo={s.woId}>
      <div className="osx-top">
        <Btn small icon="back" id="wos-back" label="Conversations" onClick={back} />
        <h2 className="osx-title"><span className="mono">{s.wo.id}</span> {s.wo.title}</h2>
        <span className="chip">{s.wo.clsName}</span>
        <span className="chip">{s.wo.bay ? `Bay · ${s.wo.bay}` : s.wo.stationName}</span>
        <Chip text={ruleBased ? "Rule-based (no agent)" : `${agentName} v${s.agent.mode === "agent" ? s.agent.version : ""}`} cls={ruleBased ? "" : "chip-accent"} />
        <span className="osx-spacer" />
        <Btn small id="wos-traveler" label="Traveler" onClick={() => openTraveler(s.woId)} />
        <Btn small icon="record" id="wos-record" label="Full record" onClick={() => openRecord(s.woId, s.project)} />
      </div>
      <div className="osx-grid">
        <section className="osx-main" aria-label={`Conversation ${s.woId}`}>
          <div className={`wos-status ${status.cls}`} id="wos-status" role="status" aria-live="polite">
            <span className="wos-dot" aria-hidden="true" />
            <span>{status.text}</span>
            {(s.next.actor === "you" && !live) || s.next.text === status.text ? null : <span className="muted small">{` · ${s.next.text}`}</span>}
          </div>
          <div className="osx-thread" role="log" aria-live="polite">
            {s.messages.map((m, i) => (
              <div key={m.id}>
                {i === 0 && m.data.mode === "legacy" ? <p className="small muted wos-legacy-h">Earlier: the scripted intake questions</p> : null}
                {i === firstSession && firstSession > 0 ? <p className="small muted wos-legacy-h">The conversation with {agentName}</p> : null}
                <div className={`osx-msg is-${m.role}${m.data.kind === "update" ? " is-update" : ""}${m.data.mode === "legacy" ? " is-legacy" : ""}`}>
                  {m.data.kind === "update" ? null : <div className="osx-who small strong">{tag(m)}{m.data.mode === "rule-based" ? <span className="muted"> · rule-based</span> : null}</div>}
                  {m.data.kind === "update" ? <p className="osx-event small"><span className="muted">{fmt.stamp(m.at)}</span> {m.text}</p>
                    : m.text ? (m.role === "assistant" && m.data.mode === "agent" ? <div className="osx-text"><Markdown text={m.text} /></div> : <p className="osx-text">{m.text}</p>) : null}
                  <Cards m={m} s={s} agent={agentName} send={(b) => send(b)} last={m.id === lastId} />
                </div>
              </div>
            ))}
            {s.ruleQuestion ? (
              <article className="osx-card osx-question" aria-label="Scripted question">
                <strong>{s.ruleQuestion.text}</strong>
                {s.ruleQuestion.chips.length ? <div className="osx-options">{s.ruleQuestion.chips.map((o) => <Btn key={o} small label={o} disabled={!s.can.talk} onClick={() => send({ kind: "message", text: o })} />)}</div> : null}
              </article>
            ) : null}
            {live ? (
              <div className="osx-msg is-assistant is-live" aria-busy="true">
                <div className="osx-who small strong">{agentName}</div>
                {live.tools.length ? <p className="osx-progress small muted">{`Working: ${live.tools.map((t) => t.replace(/_/g, " ")).join(", ")}`}</p> : null}
                <div className="osx-text">{live.text ? <Markdown text={live.text} /> : "Reading the request…"}</div>
                {live.cards.map((c, i) => (c.kind === "progress" ? <ProgressLine key={i} text={c.text} /> : null))}
              </div>
            ) : null}
            {error ? <p className="callout callout-warn small" role="alert">{error}</p> : null}
            {ruleBased ? <p className="small muted osx-reason" id="wos-mode-note">{`Rule-based (no agent): ${s.agent.mode === "rule-based" ? s.agent.reason : ""}`}</p> : null}
            <div ref={end} />
          </div>
          <form className="osx-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <textarea id="wos-input" className="input" rows={2} aria-label={`Message to ${agentName}`} value={draft} placeholder={placeholder} disabled={!s.can.talk || !!live} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
            <Btn kind="primary" type="submit" id="wos-send" label="Send" disabled={!s.can.talk || !!live || !draft.trim()} />
          </form>
        </section>
        <aside className="osx-side" aria-label="Work order">
          <dl className="osx-facts small">
            <dt>Work order</dt><dd><span className="mono">{s.wo.id}</span> · {s.wo.priority}</dd>
            <dt>Class</dt><dd>{`${s.wo.clsName} · ${Math.round(s.wo.confidence * 100)}%`}</dd>
            <dt>Station</dt><dd>{s.wo.bay ? `${s.wo.stationName} (in the ${s.wo.bay} bay)` : s.wo.stationName}</dd>
            {/* a gate's name is the outcome it waits for ("Brief confirmed"): say it is waiting, so it never reads as already passed */}
            <dt>Gate</dt><dd id="wos-gate" data-tip={s.wo.gate?.purpose || undefined}>{s.wo.gate ? `${s.wo.gate.label} waiting · passes when: ${s.wo.gate.name.toLowerCase()}` : "none waiting"}</dd>
            <dt>Next</dt><dd id="wos-next"><strong>{{ agent: agentName, you: "You", approver: "An approver", nobody: "" }[s.next.actor]}</strong>{s.next.actor === "nobody" ? "" : " — "}{s.next.text}</dd>
          </dl>
          <ol className="osx-steps" id="wos-steps" aria-label="The belt">
            {s.steps.map((st) => (
              <li key={st.id} className={`is-${st.state}`} aria-current={st.state === "current" ? "step" : undefined}>
                <span className="osx-dot" aria-hidden="true">{st.state === "done" ? <Icon name="check" /> : null}</span>
                <span>{st.name}</span>
              </li>
            ))}
          </ol>
          {s.wo.gate && s.wo.gate.id !== "G0G1" ? <ApproversPanel woId={s.woId} gate={s.wo.gate.id} project={s.project} /> : null}
          <h3 className="sub-h">Brief</h3>
          {s.brief.goal ? <><p className="small muted">{s.briefConfirmed ? "Confirmed." : "Draft: not confirmed yet."}</p><BriefBlock b={{ goal: s.brief.goal, scopeIn: s.brief.scopeIn, scopeOut: s.brief.scopeOut, ac: s.brief.ac, risks: s.brief.risks, open: s.brief.open, decisions: s.brief.decisions, estimate: s.brief.estimate }} /></> : <p className="muted small">Not drafted yet.</p>}
          {s.ruleReady ? <Btn kind="primary" small id="wos-rule-confirm" label="Confirm brief" disabled={!s.can.confirm} disabledReason={!s.can.confirm ? s.can.confirmWhy : undefined} onClick={async () => { const r = await ops.confirmBrief(s.woId); ui.toast(r.msg, r.ok ? "ok" : "error"); }} /> : null}
          <h3 className="sub-h">Proposals</h3>
          {s.pending.length ? (
            <ul className="osx-pending" id="wos-pending">
              {s.pending.map((p) => (
                <li key={`${p.mid}${p.id}`}><button type="button" className="linkish" onClick={() => document.getElementById(`wos-prop-${p.id}`)?.scrollIntoView?.({ block: "center" })}>{p.title}</button></li>
              ))}
            </ul>
          ) : <p className="muted small">None waiting.</p>}
          <dl className="osx-facts small">
            <dt>Agent</dt><dd>{s.agent.mode === "agent" ? `${agentName} v${s.agent.version} · ${s.agent.model}` : "Rule-based (no agent)"}</dd>
            <dt>Cost so far</dt><dd className="mono" id="wos-cost">{`${fmt.money(s.costUsd)} of ${fmt.money(s.budget.limitUsd)} budget`}</dd>
          </dl>
        </aside>
      </div>
    </div>
  );
}
