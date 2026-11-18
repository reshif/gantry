/**
 * The work-order session (spec 8.4): one agent conversation per work order, for its whole life, at `#/p/<project>/conversations/<WO>`. The current station's agent (the Intake
 * Clerk at Intake) reads the request and the repository, asks in natural language, and proposes the brief; a person approves, asks for changes or discards. Updates from the
 * belt (a station finished, a gate decided) arrive in the same thread. The composer is always there; a status line always says who waits on whom. Side panel: the work
 * order, the belt, the brief as it stands, what is proposed, what it cost.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMe } from "../../api/queries";
import type { WoCard } from "@gantry/domain";
import { fmt, isBriefScaffold } from "@gantry/domain";
import { ops } from "../../api/ops";
import { Avatar, Btn, Chip, Who } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { useActors } from "../../ui/actors";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { setProject } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { useOpenRecordRoute } from "../record/nav";
import { Markdown } from "../console/Markdown";
import { ApproversPanel } from "../traveler/Approvers";
import { ProgressLine, QuestionCard, useLiveTurn, useThreadEnd } from "../session/kit";
import { MentionList, useMentions } from "./Mentions";
import { decideWo, markWoSeen, sendWoTurn, useWoSession, type WoSession, type WoSessionMessage } from "./session-api";
import { DocViewer } from "../documents/DocViewer";
import { AssumptionList, StationQuestionCard } from "../documents/Dialogue";
import { ResearchPlanCard } from "../documents/Research";
import { LiveRun, RunTimelineView } from "../documents/Timeline";
import { GateNotes, ObjectionCard, SwarmBoard } from "../documents/Swarm";
import { navigate } from "../../lib/router";
import { fmtDate, plainName } from "../dossier/time";
import { useActors } from "../../ui/actors";
import { createThread, useWsAgents } from "../workspace/api";
import { mentionChoices, mentionOf, queueAsk } from "../workspace/mention";

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

function Cards({ m, s, agent, send, last }: { m: WoSessionMessage; s: WoSession; agent: string; send: (b: { kind: "message" | "continue"; text?: string }) => void; last: boolean }) {
  return (
    <>
      {(m.data.cards ?? []).map((c, i) => {
        if (c.kind === "progress") return <ProgressLine key={i} text={c.text} detail={c.detail} />;
        if (c.kind === "question") return <QuestionCard key={i} question={c.question} options={c.options} answered={c.answered} last={last} answer={(t) => send({ kind: "message", text: t })} />;
        if (c.kind === "document") return <DocLine key={i} s={s} c={c} />;
        if (c.kind === "swarm") return s.swarm ? <SwarmBoard key={i} woId={s.woId} sw={s.swarm} canStop={!!s.can.park} stopWhy={s.can.parkWhy} /> : null;
        if (c.kind === "objection") {
          const o = s.dialogue.objections.find((x) => x.id === c.id);
          return !o || m.role === "user" ? null : <ObjectionCard key={i} woId={s.woId} o={o} canDecide={s.research.canDecide} />;
        }
        if (c.kind === "research_plan") return m.role === "user" ? null : <ResearchPlanCard key={i} woId={s.woId} r={s.research} />;
        if (c.kind === "station_question") {
          const q = s.dialogue.questions.find((x) => x.id === c.id);
          // A person's answer quotes the question it answers; the card itself lives on the agent's message.
          if (!q || m.role === "user") return null;
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
function AnswerText({ m, s }: { m: WoSessionMessage; s: WoSession }) {
  const qid = (m.data.cards ?? []).find((c) => c.kind === "station_question")?.id;
  const q = s.dialogue.questions.find((x) => x.id === qid);
  return (
    <div className="osx-text wos-answer">
      {q ? <p className="small muted wos-answer-q">{`Answer to ${q.station.charAt(0).toUpperCase()}${q.station.slice(1)}: “${q.question}”`}</p> : null}
      <p className="wos-answer-a">{m.text}</p>
    </div>
  );
}

/** Side panel: what the stations wait on, the assumptions nobody confirmed yet, and the documents. */
function SideDialogue({ s }: { s: WoSession }) {
  const open = useOpenDocument();
  const asks = s.dialogue.questions.filter((q) => q.status === "open");
  const assumed = s.dialogue.assumptions.filter((a) => a.status === "open");
  const latest = new Map<string, (typeof s.documents)[number]>();
  for (const d of s.documents) if ((latest.get(d.doc)?.version ?? 0) < d.version) latest.set(d.doc, d);
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView?.({ block: "center" });
  const ui = useUI();
  return (
    <>
      <LiveRun woId={s.woId} onOpen={() => ui.dialog({ title: "Run timeline", kicker: s.woId, wide: true, body: <RunTimelineView woId={s.woId} />, actions: [{ label: "Close" }] })} />
      {s.research.plan?.status === "proposed" ? (
        <section className="wos-side-sec" id="wos-plan">
          <h3 className="sub-h">Research plan</h3>
          <button type="button" className="linkish small" onClick={() => jump("rp-card")}>{`Waiting for approval · ${s.research.plan.web ? `${s.research.plan.hosts.length} web host${s.research.plan.hosts.length === 1 ? "" : "s"}` : "repository only"}`}</button>
        </section>
      ) : null}
      {asks.length ? (
        <section className="wos-side-sec" id="wos-asks">
          <h3 className="sub-h">{`Questions waiting (${asks.length})`}</h3>
          <ul className="osx-pending">
            {asks.map((q) => (
              <li key={q.id}><button type="button" className="linkish wos-clamp" title={q.question} onClick={() => jump(`sq-${q.id.replace(/[^A-Za-z0-9_-]/g, "-")}`)}>{q.question}</button>{q.mine ? <span className="small wos-mine"> · asks you</span> : null}{q.blocking ? <span className="small muted"> · blocking</span> : null}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {assumed.length ? (
        <section className="wos-side-sec" id="wos-assumed">
          <h3 className="sub-h">{`Not confirmed (${assumed.length})`}</h3>
          <ul className="osx-pending">
            {assumed.map((a) => <li key={a.id}><button type="button" className="linkish wos-clamp" title={a.statement} onClick={() => jump(`as-${a.id.replace(/[^A-Za-z0-9_-]/g, "-")}`)}>{a.statement}</button>{a.impact === "high" ? <span className="small muted"> · high impact</span> : null}</li>)}
          </ul>
        </section>
      ) : null}
      {latest.size ? (
        <section className="wos-side-sec" id="wos-docs">
          <h3 className="sub-h">Documents</h3>
          <ul className="osx-pending">
            {[...latest.values()].map((d) => <li key={d.doc}><button type="button" className="linkish mono" onClick={() => open(s.woId, d.id, s.project)}>{d.doc}</button><span className="small muted">{` · v${d.version}`}</span></li>)}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ the page ---- */

/** The prototype's message time: "13 Nov 15:43" (IST, as everywhere in the app). */
export const panelDate = (t: number): string => new Date(t).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata", hour12: false }).replace(",", "");

export function WoSessionPage({ woId, back, embedded, bare, panel }: { woId: string; back: () => void; /** In the workspace, whose inbox is the way back. */ embedded?: boolean; /** On the work order page: no title bar of its own, the page header carries it. */ bare?: boolean; /** The Conversations page: the prototype's chat bubbles and composer inside the page's own panel. */ panel?: boolean }) {
  const q = useWoSession(woId);
  const me = useMe();
  const s = q.data;
  const actor = useActors();
  const ui = useUI();
  const openTraveler = useOpenTraveler();
  const openRecord = useOpenRecordRoute();
  const actorOf = useActors();
  const [draft, setDraft] = useState("");
  const opened = useRef(false);
  const turn = useRef<{ kind: "message" | "open" | "continue"; text?: string; mentions?: string[] }>({ kind: "open" });
  const run = useCallback((on: Parameters<typeof sendWoTurn>[2], signal: AbortSignal) => sendWoTurn(woId, turn.current, on, signal), [woId]);
  const { live, error, start } = useLiveTurn<WoCard>(run, (m) => { setSent(null); ui.toast(m || "The message could not be sent. Try again.", "error"); });
  const thread = useThreadEnd<HTMLDivElement>(s?.messages.length, live?.text);
  /** The person's own words show at once; they give way to the saved copy as soon as the thread has grown. */
  const [sent, setSent] = useState<{ text: string; base: number; at: number } | null>(null);
  const send = (body: { kind: "message" | "open" | "continue"; text?: string; mentions?: string[] }) => {
    turn.current = body;
    if (body.kind === "message" && body.text) setSent({ text: body.text, base: s?.messages.length ?? 0, at: Date.now() });
    void start();
  };
  const agents = useWsAgents(woId).data?.items ?? [];
  const mentions = useMentions(woId, draft, setDraft, !!s?.can.talk && !live);

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
  useEffect(() => { if (s) setProject(s.project); }, [s?.project]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastId = s?.messages.at(-1)?.id;
  const firstSession = useMemo(() => s?.messages.findIndex((m) => m.data.mode !== "legacy") ?? -1, [s]);
  if (!s) return <div className="osx"><Async query={q} what="this conversation" id="conv-session">{() => null}</Async><Btn label="Back to conversations" small kind="ghost" icon="back" onClick={back} /></div>;

  const agentName = s.agent.name;
  // "@Researcher ..." asks that agent in a side thread about this work order (read-only, shared with the project); anything else goes to the station's agent.
  const mention = mentionOf(draft, agents);
  const choices = mentionChoices(draft, agents);
  const askAside = async (m: NonNullable<typeof mention>) => {
    if (!m.text) { ui.toast(`Write the question for ${m.agent.name} after the name.`, "warn"); return; }
    const r = await createThread({ scope: { kind: "work_order", id: s.woId }, agent: m.agent.id, visibility: "project" });
    if (!r.ok) { ui.toast(r.msg, "error"); return; }
    setDraft("");
    queueAsk(r.id, m.text);
    navigate("workspace", r.id);
  };
  const submit = () => { const t = draft.trim(); if (!t) return; if (mention) { void askAside(mention); return; } if (!s.can.talk) return; const ids = mentions.ids(); setDraft(""); mentions.reset(); send({ kind: "message", text: t, ...(ids.length ? { mentions: ids } : {}) }); };
  const status = live ? { cls: "is-live", text: `${agentName} is thinking…` }
    : s.wo.closed ? { cls: "is-idle", text: s.next.text }
    : s.next.actor === "you" ? { cls: "is-you", text: ruleBased ? "Waiting for you: answer the question below" : s.dialogue.askedMe ? s.next.text : `${agentName} is waiting for you` }
    : s.next.actor === "approver" || s.next.actor === "person" ? { cls: "is-wait", text: s.next.text }
    : { cls: "is-live", text: s.waiting?.text ?? s.next.text };
  const placeholder = !s.can.talk ? `Read-only: ${s.can.talkWhy || "you may not act on this work order."} Type @ to ask an agent in a side thread.` : ruleBased ? "Reply to the scripted question (rule-based, no agent)" : `Message ${agentName}, or type @ to ask another agent in a side thread or to mention a person`;
  // a station's message carries its agent's id: show the agent's name, as everywhere else
  const tag = (m: WoSessionMessage) => (bare && m.role === "user" ? plainName(actor(m.author).name) : m.role === "user" ? <Who id={m.author} /> : m.data.mode === "legacy" ? "Intake Clerk (scripted)" : m.author === "system" ? "Gantry" : m.data.kind === "station" ? <Who id={m.author} /> : (m.data.agent ?? agentName));

  const sideBody = (
    <>
          <dl className="osx-facts small">
            <dt>Work order</dt><dd><span className="mono">{s.wo.id}</span> · {s.wo.priority}</dd>
            <dt>Class</dt><dd>{`${s.wo.clsName} · ${Math.round(s.wo.confidence * 100)}%`}</dd>
            <dt>Station</dt><dd>{s.wo.bay ? `${s.wo.stationName} (in the ${s.wo.bay} bay)` : s.wo.stationName}</dd>
            {/* a gate's name is the outcome it waits for ("Brief confirmed"): say it is waiting, so it never reads as already passed */}
            <dt>Gate</dt><dd id="wos-gate" data-tip={s.wo.gate?.purpose || undefined}>{s.wo.gate ? `${s.wo.gate.label} waiting · passes when: ${s.wo.gate.name.toLowerCase()}` : "none waiting"}</dd>
            <dt>Next</dt><dd id="wos-next"><strong>{{ agent: agentName, you: "You", approver: "An approver", person: "Someone else", nobody: "" }[s.next.actor]}</strong>{s.next.actor === "nobody" ? "" : " — "}{s.next.text}</dd>
          </dl>
          <ol className="osx-steps" id="wos-steps" aria-label="The belt">
            {s.steps.map((st) => (
              <li key={st.id} className={`is-${st.state}`} aria-current={st.state === "current" ? "step" : undefined}>
                <span className="osx-dot" aria-hidden="true">{st.state === "done" ? <Icon name="check" /> : null}</span>
                <span>{st.name}</span>
              </li>
            ))}
          </ol>
          {s.wo.gate && s.wo.gate.id !== "G0G1" ? <GateNotes assumptions={s.dialogue.assumptions} objections={s.dialogue.objections} jump={(id) => document.getElementById(id)?.scrollIntoView?.({ block: "center" })} /> : null}
          {s.wo.gate && s.wo.gate.id !== "G0G1" ? <ApproversPanel woId={s.woId} gate={s.wo.gate.id} project={s.project} /> : null}
          <SideDialogue s={s} />
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
    </>
  );
  const quick = s.ruleQuestion;
  const writeFirst = () => { document.getElementById("wos-input")?.focus(); ui.toast("Write a message first", "error"); };
  const panelName = (m: WoSessionMessage): string => (m.role === "user" || (m.author && m.author.startsWith("ag-")) ? actorOf(m.author).name.replace(" (agent)", "") : m.author === "system" ? "Gantry" : m.data.agent ?? agentName);
  const lastFrom = s.messages.length ? panelName(s.messages[s.messages.length - 1]!) : agentName;
  if (panel) {
    return (
      <div className="wos wos-panel stack" id="wos" data-wo={s.woId} role="region" aria-label={`Conversation ${s.woId}`}>
        <div className="chat" id="wos-thread" role="log" aria-live="polite" ref={thread}>
          {!s.messages.length && !live && !quick ? <Empty title="No conversation yet" text="Agents talk here when they need you." /> : null}
          {s.messages.map((m) => (
            <div key={m.id} className="wos-turn">
              {m.data.kind === "update" ? (
                <p className="osx-event small muted"><span>{fmt.stamp(m.at)}</span> {m.text}</p>
              ) : (
                <div className={`msg${m.role === "user" ? " me" : ""}`}>
                  <Avatar id={m.author} />
                  <div className="bub">
                    <div className="who">{panelName(m)}{` · ${panelDate(m.at)}`}</div>
                    {m.data.kind === "answer" ? <AnswerText m={m} s={s} /> : m.text ? (m.role === "assistant" && m.data.mode === "agent" ? <div className="osx-text"><Markdown text={m.text} /></div> : <p className="osx-text">{m.text}</p>) : null}
                    {(m.data.mentions ?? []).filter((x) => !x.access).map((x) => <p key={x.id} className="small muted wos-mention-note">{`${x.name} cannot open this project yet. Mentioning them did not give them access: a project admin was asked.`}</p>)}
                    <Cards m={m} s={s} agent={agentName} send={(b) => send(b)} last={m.id === lastId} />
                  </div>
                </div>
              )}
            </div>
          ))}
          {sent && s.messages.length <= sent.base ? (
            <div className="msg me" id="wos-sent">
              <Avatar id={me?.person.id} />
              <div className="bub"><div className="who">{`${actorOf(me?.person.id).name} · ${panelDate(sent.at)}`}</div><p className="osx-text">{sent.text}</p></div>
            </div>
          ) : null}
          {quick && !s.wo.closed && !(sent && s.messages.length <= sent.base) ? (
            <div className="callout" id="wos-asks-callout">
              <b>{`${lastFrom} asks`}</b>{quick.text}
              {quick.chips.length ? <div className="chips" style={{ marginTop: 8 }}>{quick.chips.map((o) => <button key={o} type="button" className="chipbtn" disabled={!s.can.talk} onClick={() => send({ kind: "message", text: o })}>{o}</button>)}</div> : null}
            </div>
          ) : null}
          {live ? (
            <div className="msg" aria-busy="true">
              <Avatar id={s.agent.id} />
              <div className="bub">
                <div className="who">{agentName}</div>
                {live.tools.length ? <p className="osx-progress small muted">{`Working: ${live.tools.map((t) => t.replace(/_/g, " ")).join(", ")}`}</p> : null}
                <div className="osx-text">{live.text ? <Markdown text={live.text} /> : "Reading the request…"}</div>
                {live.cards.map((c, i) => (c.kind === "progress" ? <ProgressLine key={i} text={c.text} /> : null))}
              </div>
            </div>
          ) : null}
          {error ? <p className="callout warn small" role="alert">{error}</p> : null}
        </div>
        <form className="wos-reply" onSubmit={(e) => { e.preventDefault(); if (!draft.trim()) { writeFirst(); return; } submit(); }}>
          {choices.length ? (
            <ul className="slash-menu wos-mention-menu" id="wos-mentions" role="listbox" aria-label="Ask an agent in a side thread">
              {choices.map((a) => <li key={a.id} role="option" aria-selected="false" id={`wos-mention-${a.id}`} onMouseDown={(e) => { e.preventDefault(); setDraft(`@${a.name} `); }}><span className="strong">{`@${a.name}`}</span><span className="muted">{`${a.stationName} · answers in a side thread`}</span></li>)}
            </ul>
          ) : null}
          <div className="wos-compose">
            <MentionList id={mentions.listId} list={mentions.list} active={mentions.active} pick={mentions.pick} />
            <textarea id="wos-input" className="input" rows={2} placeholder="Reply to the agent…" aria-label="Reply" value={draft} disabled={!!live} {...(mentions.open ? { role: "combobox", "aria-expanded": true, "aria-controls": mentions.listId, "aria-autocomplete": "list" as const } : {})} onChange={(e) => { setDraft(e.target.value); mentions.setCaret(e.target.selectionStart); }} onKeyUp={(e) => mentions.setCaret(e.currentTarget.selectionStart)} onClick={(e) => mentions.setCaret(e.currentTarget.selectionStart)} onKeyDown={(e) => { if (mentions.onKeyDown(e)) return; if (e.key === "Tab" && choices.length) { e.preventDefault(); setDraft(`@${choices[0]!.name} `); return; } if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!draft.trim()) writeFirst(); else submit(); } }} />
          </div>
          {mention ? <span className="small muted wos-mention-note" id="wos-mention-note">{`Asks ${mention.agent.name} in a side thread`}</span> : null}
          <div className="row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
            <Btn kind="primary" type="submit" id="wos-send" label={mention ? `Ask ${mention.agent.name}` : "Send"} disabled={!!live || (!mention && !s.can.talk)} />
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className={`osx wos${bare ? " is-bare" : ""}`} id="wos" data-wo={s.woId}>
      {bare ? null : <div className="osx-top">
        {embedded ? null : <Btn small icon="back" id="wos-back" label="Conversations" onClick={back} />}
        <h2 className="osx-title"><span className="mono">{s.wo.id}</span> {s.wo.title}</h2>
        <span className="chip">{s.wo.clsName}</span>
        <span className="chip">{s.wo.bay ? `Bay · ${s.wo.bay}` : s.wo.stationName}</span>
        <Chip text={ruleBased ? "Rule-based (no agent)" : `${agentName} v${s.agent.mode === "agent" ? s.agent.version : ""}`} cls={ruleBased ? "" : "chip-accent"} />
        <span className="osx-spacer" />
        <Btn small id="wos-traveler" label="Traveler" onClick={() => openTraveler(s.woId)} />
        <Btn small icon="record" id="wos-record" label="Full record" onClick={() => openRecord(s.woId, s.project)} />
      </div>}
      <div className="osx-grid">
        <section className="osx-main" aria-label={`Conversation ${s.woId}`}>
          {bare && !live ? null : <div className={`wos-status ${status.cls}`} id="wos-status" role="status" aria-live="polite">
            <span className="wos-dot" aria-hidden="true" />
            <span>{status.text}</span>
            {(s.next.actor === "you" && !live) || s.next.text === status.text ? null : <span className="muted small">{` · ${s.next.text}`}</span>}
          </div>}
          <div className={`osx-thread${bare ? " chat" : ""}`} role="log" aria-live="polite" ref={thread}>
            {(bare ? s.messages.slice(-8) : s.messages).map((m, i) => (
              <div key={m.id} className={bare ? `msg${m.role === "user" ? " me" : ""}` : undefined}>
                {bare && m.data.kind !== "update" ? <Avatar id={m.author} /> : null}
                {i === 0 && m.data.mode === "legacy" ? <p className="small muted wos-legacy-h">Earlier: the scripted intake questions</p> : null}
                {i === firstSession && firstSession > 0 ? <p className="small muted wos-legacy-h">The conversation with {agentName}</p> : null}
                <div className={`${bare ? "bub " : ""}osx-msg is-${m.role}${m.data.kind === "update" ? " is-update" : ""}${m.data.mode === "legacy" ? " is-legacy" : ""}`}>
                  {m.data.kind === "update" ? null : <div className={bare ? "who" : "osx-who small strong"}>{tag(m)}{bare ? ` · ${fmtDate(m.at)}` : ""}{m.data.mode === "rule-based" ? <span className="muted"> · rule-based</span> : null}</div>}
                  {m.data.kind === "update" ? <p className="osx-event small"><span className="muted">{fmt.stamp(m.at)}</span> {m.text}</p>
                    : m.data.kind === "answer" ? <AnswerText m={m} s={s} />
                    : m.text ? (m.role === "assistant" && m.data.mode === "agent" ? <div className="osx-text"><Markdown text={m.text} /></div> : <p className="osx-text">{m.text}</p>) : null}
                  {(m.data.mentions ?? []).filter((x) => !x.access).map((x) => <p key={x.id} className="small muted wos-mention-note">{`${x.name} cannot open this project yet. Mentioning them did not give them access: a project admin was asked.`}</p>)}
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
          </div>
          <form className="osx-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            {choices.length ? (
              <ul className="slash-menu wos-mention-menu" id="wos-mentions" role="listbox" aria-label="Ask an agent in a side thread">
                {choices.map((a) => <li key={a.id} role="option" aria-selected="false" id={`wos-mention-${a.id}`} onMouseDown={(e) => { e.preventDefault(); setDraft(`@${a.name} `); }}><span className="strong">{`@${a.name}`}</span><span className="muted">{`${a.stationName} · answers in a side thread`}</span></li>)}
              </ul>
            ) : null}
            <div className="wos-compose">
              <MentionList id={mentions.listId} list={mentions.list} active={mentions.active} pick={mentions.pick} />
            <textarea id="wos-input" className="input" rows={2} aria-label={`Message to ${agentName}`} value={draft} placeholder={placeholder} disabled={!!live} {...(mentions.open ? { role: "combobox", "aria-expanded": true, "aria-controls": mentions.listId, "aria-autocomplete": "list" as const } : {})} onChange={(e) => { setDraft(e.target.value); mentions.setCaret(e.target.selectionStart); }} onKeyUp={(e) => mentions.setCaret(e.currentTarget.selectionStart)} onClick={(e) => mentions.setCaret(e.currentTarget.selectionStart)} onKeyDown={(e) => { if (mentions.onKeyDown(e)) return; if (e.key === "Tab" && choices.length) { e.preventDefault(); setDraft(`@${choices[0]!.name} `); return; } if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
            </div>
            {mention ? <span className="small muted wos-mention-note" id="wos-mention-note">{`Asks ${mention.agent.name} in a side thread`}</span> : null}
            <Btn kind="primary" type="submit" id="wos-send" label={mention ? `Ask ${mention.agent.name}` : "Send"} disabled={!!live || !draft.trim() || (!mention && !s.can.talk)} />
          </form>
        </section>
        <aside className="osx-side" aria-label="Work order">
          {sideBody}
        </aside>
      </div>
    </div>
  );
}
