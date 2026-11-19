/**
 * The work-order session (spec 8.4): one agent conversation per work order, for its whole life, at `#/p/<project>/conversations/<WO>`. The current station's agent (the Intake
 * Clerk at Intake) reads the request and the repository, asks in natural language, and proposes the brief; a person approves, asks for changes or discards. Updates from the
 * belt (a station finished, a gate decided) arrive in the same thread. The composer is always there; a status line always says who waits on whom. Side panel: the work
 * order, the belt, the brief as it stands, what is proposed, what it cost.
 */
import { fromAgentModel, fromPerson } from "../../lib/wo-message";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMe } from "../../api/queries";
import type { WoCard } from "@gantry/domain";
import { fmt } from "@gantry/domain";
import { ops } from "../../api/ops";
import { Avatar, Btn, Chip, Empty, TextArea, Who } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { useActors } from "../../ui/actors";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { setProject } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { useOpenRecordRoute } from "../record/nav";
import { Markdown } from "../console/Markdown";
import { ApproversPanel } from "../traveler/Approvers";
import { ProgressLine, useLiveTurn, useThreadEnd } from "../session/kit";
import { MentionList, useMentions } from "./Mentions";
import { markWoSeen, sendWoTurn, useWoSession, type WoSession, type WoSessionMessage } from "./session-api";
import { LiveRun, RunTimelineView } from "../documents/Timeline";
import { GateNotes } from "../documents/Swarm";
import { navigate } from "../../lib/router";
import { fmtDate, plainName } from "../dossier/time";
import { createThread, useWsAgents } from "../workspace/api";
import { mentionChoices, mentionOf, queueAsk } from "../workspace/mention";

import { AnswerText, BriefBlock, Cards, useOpenDocument } from "./Cards";
import { Transcript, panelDate } from "./Transcript";
import { buildTranscript } from "./chat";
import { useStickyScroll } from "./scroll";
export { useOpenDocument, panelDate };


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


export function WoSessionPage({ woId, back, embedded, bare, panel, events }: { woId: string; /** The Conversations page: false leaves the line events out of the chat. */ events?: boolean; back: () => void; /** In the workspace, whose inbox is the way back. */ embedded?: boolean; /** On the work order page: no title bar of its own, the page header carries it. */ bare?: boolean; /** The Conversations page: the prototype's chat bubbles and composer inside the page's own panel. */ panel?: boolean }) {
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
  const scroll = useStickyScroll(woId, s?.messages.length, live?.text, events, sent?.at);
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
  const tag = (m: WoSessionMessage) => (bare && fromPerson(m) ? plainName(actor(m.author).name) : fromPerson(m) ? <Who id={m.author} /> : m.data.mode === "legacy" ? "Intake Clerk (scripted)" : m.author === "system" ? "Gantry" : m.data.kind === "station" ? <Who id={m.author} /> : (m.data.agent ?? agentName));

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
  // a person the people list does not resolve (it needs a permission some viewers lack) is "A teammate", never a raw id
  const panelName = (m: WoSessionMessage): string => {
    if (m.author === "system") return "Gantry";
    if (fromPerson(m) || (m.author && m.author.startsWith("ag-"))) {
      const a = actorOf(m.author);
      return a.kind === "other" ? (fromPerson(m) ? "A teammate" : agentName) : a.name.replace(" (agent)", "");
    }
    return m.data.agent ?? agentName;
  };
  const lastFrom = s.messages.length ? panelName(s.messages[s.messages.length - 1]!) : agentName;
  if (panel) {
    const blocks = buildTranscript(s, events !== false);
    const pending = sent && s.messages.length <= sent.base;
    return (
      <div className="wos wos-panel cv-body" id="wos" data-wo={s.woId} role="region" aria-label={`Conversation ${s.woId}`}>
        {/* a scrolling region must be reachable by keyboard (axe: scrollable-region-focusable) */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div className="cv-scroll" id="wos-thread" role="log" aria-live="polite" tabIndex={0} aria-label="Messages" ref={scroll.ref} onScroll={scroll.onScroll}>
          <div className="chat cv-inner" ref={scroll.inner}>
            {!s.messages.length && !live && !quick ? <Empty title="No conversation yet" text="Agents talk here when they need you." /> : null}
            <Transcript s={s} blocks={blocks} agent={agentName} nameOf={panelName} mine={me?.person.id} send={(b) => send(b)} lastId={lastId} />
            {pending ? (
              <div className="cv-turn is-person is-you" id="wos-sent">
                <div className="cv-col"><div className="cv-who">You<span className="muted">{` · ${panelDate(sent.at)}`}</span></div><div className="cv-msg"><p className="cv-text">{sent.text}</p></div></div>
              </div>
            ) : null}
            {quick && !s.wo.closed && !pending ? (
              <div className="callout" id="wos-asks-callout">
                <b>{`${lastFrom} asks`}</b>{quick.text}
                {quick.chips.length ? <div className="chips" style={{ marginTop: 8 }}>{quick.chips.map((o) => <button key={o} type="button" className="chipbtn" disabled={!s.can.talk} onClick={() => send({ kind: "message", text: o })}>{o}</button>)}</div> : null}
              </div>
            ) : null}
            {live ? (
              <div className="cv-turn is-agent" aria-busy="true">
                <Avatar id={s.agent.id} />
                <div className="cv-col">
                  <div className="cv-who">{agentName}</div>
                  <div className="cv-msg">
                    {live.tools.length ? <p className="osx-progress small muted">{`Working: ${live.tools.map((t) => t.replace(/_/g, " ")).join(", ")}`}</p> : null}
                    <div className="cv-text">{live.text ? <Markdown text={live.text} /> : "Reading the request…"}</div>
                    {live.cards.map((c, i) => (c.kind === "progress" ? <ProgressLine key={i} text={c.text} /> : null))}
                  </div>
                </div>
              </div>
            ) : null}
            {error ? <p className="callout warn small" role="alert">{error}</p> : null}
          </div>
        </div>
        {scroll.away ? <div className="cv-jump-row"><Btn small kind="primary" icon="down" id="wos-jump" label="New messages" onClick={scroll.toEnd} /></div> : null}
        <form className="wos-reply cv-composer" onSubmit={(e) => { e.preventDefault(); if (!draft.trim()) { writeFirst(); return; } scroll.stick(); submit(); }}>
          {choices.length ? (
            <ul className="slash-menu wos-mention-menu" id="wos-mentions" role="listbox" aria-label="Ask an agent in a side thread">
              {choices.map((a) => <li key={a.id} role="option" aria-selected="false" id={`wos-mention-${a.id}`} onMouseDown={(e) => { e.preventDefault(); setDraft(`@${a.name} `); }}><span className="strong">{`@${a.name}`}</span><span className="muted">{`${a.stationName} · answers in a side thread`}</span></li>)}
            </ul>
          ) : null}
          <div className="wos-compose">
            <MentionList id={mentions.listId} list={mentions.list} active={mentions.active} pick={mentions.pick} />
            <TextArea id="wos-input" rows={2} placeholder="Reply to the agent…" aria-label="Reply" value={draft} disabled={!!live} {...(mentions.open ? { role: "combobox", "aria-expanded": true, "aria-controls": mentions.listId, "aria-autocomplete": "list" as const } : {})} onChange={(e) => { setDraft(e.target.value); mentions.setCaret(e.target.selectionStart); }} onKeyUp={(e) => mentions.setCaret(e.currentTarget.selectionStart)} onClick={(e) => mentions.setCaret(e.currentTarget.selectionStart)} onKeyDown={(e) => { if (mentions.onKeyDown(e)) return; if (e.key === "Tab" && choices.length) { e.preventDefault(); setDraft(`@${choices[0]!.name} `); return; } if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!draft.trim()) writeFirst(); else { scroll.stick(); submit(); } } }} />
            <Btn kind="primary" type="submit" id="wos-send" icon="send" label={mention ? `Ask ${mention.agent.name}` : "Send"} disabled={!!live || (!mention && !s.can.talk)} />
          </div>
          {mention ? <span className="small muted wos-mention-note" id="wos-mention-note">{`Asks ${mention.agent.name} in a side thread`}</span> : null}
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
              <div key={m.id} className={bare ? `msg${fromPerson(m) ? " me" : ""}` : undefined}>
                {bare && m.data.kind !== "update" ? <Avatar id={m.author} /> : null}
                {i === 0 && m.data.mode === "legacy" ? <p className="small muted wos-legacy-h">Earlier: the scripted intake questions</p> : null}
                {i === firstSession && firstSession > 0 ? <p className="small muted wos-legacy-h">The conversation with {agentName}</p> : null}
                <div className={`${bare ? "bub " : ""}osx-msg is-${m.role}${m.data.kind === "update" ? " is-update" : ""}${m.data.mode === "legacy" ? " is-legacy" : ""}`}>
                  {m.data.kind === "update" ? null : <div className={bare ? "who" : "osx-who small strong"}>{tag(m)}{bare ? ` · ${fmtDate(m.at)}` : ""}{m.data.mode === "rule-based" ? <span className="muted"> · rule-based</span> : null}</div>}
                  {m.data.kind === "update" ? <p className="osx-event small"><span className="muted">{fmt.stamp(m.at)}</span> {m.text}</p>
                    : m.data.kind === "answer" ? <AnswerText m={m} s={s} />
                    : m.text ? (fromAgentModel(m) && m.data.mode === "agent" ? <div className="osx-text"><Markdown text={m.text} /></div> : <p className="osx-text">{m.text}</p>) : null}
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
            <TextArea id="wos-input" rows={2} aria-label={`Message to ${agentName}`} value={draft} placeholder={placeholder} disabled={!!live} {...(mentions.open ? { role: "combobox", "aria-expanded": true, "aria-controls": mentions.listId, "aria-autocomplete": "list" as const } : {})} onChange={(e) => { setDraft(e.target.value); mentions.setCaret(e.target.selectionStart); }} onKeyUp={(e) => mentions.setCaret(e.currentTarget.selectionStart)} onClick={(e) => mentions.setCaret(e.currentTarget.selectionStart)} onKeyDown={(e) => { if (mentions.onKeyDown(e)) return; if (e.key === "Tab" && choices.length) { e.preventDefault(); setDraft(`@${choices[0]!.name} `); return; } if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
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
