/**
 * The onboarding session (spec 11.3): one conversation per repository for its whole onboarding. The agent (or, with no model, Gantry by rule) reads the repository, says what it
 * observed, asks, and proposes; a person approves, asks for changes or discards. Updates from the pipeline (checks, merge, verification) arrive in the same thread from the repo's
 * timeline. Side panel: where the repo is in the lifecycle, who acts next, what it cost, what is proposed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { assessorLabel, fmt, type OnboardFinding, type SessionCard } from "@gantry/domain";
import { useRepos } from "../../api/queries";
import { Btn, Chip, Empty, Who } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { decide, markSeen, sendTurn, useSession, type Session, type SessionMessage } from "./session-api";
import { StatusChip, type RepoV } from "./kit";
import { QuestionCard, useThreadEnd } from "../session/kit";

type Proposal = Extract<SessionCard, { kind: "proposal" }>;
const ACTORS: Record<string, string> = { system: "Gantry", "ag-onboard": "Onboarding Agent", ci: "CI" };
const nameOf = (who: string): React.ReactNode => ACTORS[who] ?? (who.startsWith("github:") ? who : <Who id={who} />);

/* ------------------------------------------------------------------ cards ---- */

function Source({ source }: { source: "observed" | "agent" }) {
  return source === "agent" ? <span className="chip chip-accent onb-src" title="Drafted by the Onboarding Agent">Agent</span> : <span className="chip onb-src" title="Read or written by Gantry from the repository's own files">Observed</span>;
}

function FindingsCard({ r }: { r: RepoV }) {
  const o = r.onboarding;
  if (!o.findings.length) return null;
  const list: OnboardFinding[] = o.findings.slice().sort((a, b) => Number(a.ok) - Number(b.ok));
  const gaps = list.filter((f) => !f.ok).length;
  return (
    <article className="osx-card" id="osx-findings" aria-label="Assessment findings">
      <header className="osx-card-h">
        <strong>{`Assessment · ${gaps} gap${gaps === 1 ? "" : "s"} of ${list.length}`}</strong>
        <span className="muted small">{assessorLabel(o.assessor)}</span>
      </header>
      {o.assessor?.mode === "rule-based" ? <p className="small muted">{o.assessor.reason ? `Rule-based (no agent): ${o.assessor.reason}` : "Rule-based (no agent): every finding was read from the repository by fixed rules."}</p> : null}
      {o.assessor?.risk ? <p className="small">{`Agent's risk judgement: ${o.assessor.risk.level}. ${o.assessor.risk.reason}`}</p> : null}
      <ul className="osx-findings">
        {list.map((f) => (
          <li key={f.id} className={f.ok ? "is-ok" : "is-gap"}>
            <span className="osx-f-ic"><Icon name={f.ok ? "check" : f.manual ? "human" : "alert"} /></span>
            <div>
              <strong>{f.check}</strong>
              {f.ok ? <span className="muted small"> passes</span> : <span className="small"> · {f.sev}{f.required === false ? " · advisory" : ""}</span>}
              <div className="small"><Source source="observed" />{` ${f.detail ?? (f.ok ? "Met." : f.fix)}`}</div>
              {f.note ? <div className="small"><Source source="agent" />{` ${f.note}`}</div> : null}
            </div>
          </li>
        ))}
      </ul>
    </article>
  );
}

function ProposalCard({ m, c, s, send }: { m: SessionMessage; c: Proposal; s: Session; send: (b: { kind: "continue" }) => void }) {
  const ui = useUI();
  const [open, setOpen] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const pending = c.status === "pending";
  const sensitive = (c.sensitive ?? []).filter((x) => x.id !== "guideline");
  const guideline = (c.sensitive ?? []).find((x) => x.id === "guideline");
  const mayApprove = c.what === "merge" ? s.can.merge : s.can.talk;
  const why = c.what === "merge" ? "You do not have the right to merge onboarding pull requests. Ask someone who does, or merge it on GitHub." : s.can.talkWhy;
  const run = async (d: "approve" | "changes" | "discard") => {
    setBusy(true);
    const r = await decide(s.repoId, m.id, c.id, d, d === "changes" ? text : undefined, d === "approve" && sensitive.length > 0 ? confirmed : undefined);
    setBusy(false);
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (r.ok && d === "changes") { setAsking(false); setText(""); send({ kind: "continue" }); }
  };
  const total = c.files.reduce((a, f) => ({ plus: a.plus + f.plus, minus: a.minus + f.minus }), { plus: 0, minus: 0 });
  const label: Record<Proposal["status"], string> = { pending: "Waiting for you", approved: "Approved", changes: "Changes requested", discarded: "Discarded", superseded: "Replaced by a newer proposal", failed: "Failed" };
  return (
    <article className={`osx-card osx-proposal is-${c.status}`} id={`osx-prop-${c.id}`} aria-label={c.title}>
      <header className="osx-card-h">
        <strong>{c.title}</strong>
        <Chip text={c.mode === "agent" ? "Drafted by the Onboarding Agent" : "Rule-based (no agent)"} cls={c.mode === "agent" ? "chip-accent" : ""} />
        <span className={`osx-status st-${c.status}`}>{label[c.status]}{c.decidedBy && c.status !== "superseded" ? <> · <Who id={c.decidedBy} /></> : null}</span>
      </header>
      <p className="small">{c.summary}</p>
      {sensitive.length ? (
        <div className="osx-sensitive" role="group" aria-label="Parts to confirm">
          <strong className="small">Needs your explicit confirmation</strong>
          <ul className="small">{sensitive.map((x) => <li key={x.id}><strong>{x.label}</strong>{x.paths.length ? <> <span className="mono">{x.paths.join(", ")}</span></> : null}: {x.reason}</li>)}</ul>
          {guideline ? <p className="muted small">{guideline.reason}</p> : null}
          {pending ? <label className="small"><input type="checkbox" id={`osx-confirm-${c.id}`} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> {`I have read these and confirm: ${sensitive.map((x) => x.label.toLowerCase()).join(", ")}.`}</label> : null}
        </div>
      ) : null}
      {(c.blockers ?? []).map((b) => <div key={b.id} className="osx-blocker small" role="alert"><strong>{b.message}</strong><p>{b.fix}</p></div>)}
      {c.files.length ? (
        <ul className="osx-files">
          {c.files.map((f) => (
            <li key={f.path}>
              <button type="button" className="osx-file" aria-expanded={open === f.path} onClick={() => setOpen(open === f.path ? null : f.path)} disabled={!f.added.length}>
                <span className="mono">{f.path}</span>
                <span className="muted small">{f.mode === "create" ? "new" : "changed"}</span>
                <span className="mono small osx-plus">{`+${f.plus}`}</span>
                <span className="mono small osx-minus">{`-${f.minus}`}</span>
                <Source source={f.source} />
              </button>
              {f.purpose ? <span className="muted small osx-purpose">{f.purpose}</span> : null}
              {open === f.path ? <pre className="osx-diff" aria-label={`Added lines of ${f.path}`}>{f.added.map((l) => `+ ${l}`).join("\n")}</pre> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {c.files.length ? <p className="muted small">{`${c.files.length} file${c.files.length === 1 ? "" : "s"}, +${total.plus} -${total.minus}${c.diffCap ? ` (cap ${c.diffCap} lines)` : ""}. Nothing is written to GitHub until a person approves.`}</p> : null}
      {pending ? (
        <div className="osx-actions">
          <Btn kind="primary" id={`osx-approve-${c.id}`} label={c.what === "merge" ? "Approve and merge" : c.what === "exception" ? "Approve the exception" : c.what === "update_pr" ? "Approve and update the PR" : "Approve and open the PR"} disabled={busy || !mayApprove || (sensitive.length > 0 && !confirmed)} disabledReason={!mayApprove ? why : sensitive.length > 0 && !confirmed ? "Confirm the parts listed above first." : undefined} onClick={() => void run("approve")} />
          {c.what !== "merge" && c.what !== "exception" ? <Btn id={`osx-changes-${c.id}`} label="Ask for changes" disabled={busy || !s.can.talk} onClick={() => setAsking(!asking)} /> : null}
          <Btn id={`osx-discard-${c.id}`} label="Discard" disabled={busy || !s.can.talk} onClick={() => void run("discard")} />
        </div>
      ) : null}
      {pending && asking ? (
        <div className="osx-ask">
          <label className="small" htmlFor={`osx-changes-text-${c.id}`}>What should change?</label>
          <textarea id={`osx-changes-text-${c.id}`} className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: tests run with make check, not npm test." />
          <Btn id={`osx-changes-send-${c.id}`} kind="primary" small label="Send" disabled={busy || text.trim().length < 3} onClick={() => void run("changes")} />
        </div>
      ) : null}
    </article>
  );
}

function Cards({ m, s, send, last }: { m: SessionMessage; s: Session; send: (b: { kind: "message" | "continue"; text?: string }) => void; last: boolean }) {
  return (
    <>
      {(m.data.cards ?? []).map((c, i) =>
        c.kind === "progress" ? <p key={i} className="osx-progress small"><Icon name="check" /> {c.text}{c.detail ? <span className="muted">{` · ${c.detail}`}</span> : null}</p>
        : c.kind === "question" ? <QuestionCard key={i} question={c.question} options={c.options} answered={c.answered} last={last} answer={(t) => send({ kind: "message", text: t })} />
        : <ProposalCard key={i} m={m} c={c} s={s} send={send} />)}
    </>
  );
}

/* ------------------------------------------------------------------ the page ---- */

export function SessionPage({ projectId, repoId, back, details }: { projectId: string; repoId: string; back: () => void; details: () => void }) {
  const repos = (useRepos(projectId).data ?? []) as RepoV[];
  const r = repos.find((x) => x.id === repoId);
  const q = useSession(repoId);
  const s = q.data;
  const ui = useUI();
  const [live, setLive] = useState<{ text: string; tools: string[]; cards: SessionCard[] } | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const opened = useRef(false);
  const thread = useThreadEnd<HTMLDivElement>(s?.messages.length, live?.text);

  const send = async (body: { kind: "message" | "open" | "continue"; text?: string }) => {
    if (live) return;
    setError("");
    setLive({ text: "", tools: [], cards: [] });
    const ac = new AbortController();
    const res = await sendTurn(repoId, body, (e) => {
      if (e.event === "text") setLive((l) => l && { ...l, text: l.text + e.data.delta });
      else if (e.event === "tool") setLive((l) => l && { ...l, tools: [...l.tools, e.data.name] });
      else if (e.event === "card") setLive((l) => l && { ...l, cards: [...l.cards, e.data.card] });
      else if (e.event === "error") setError(e.data.msg);
    }, ac.signal);
    setLive(null);
    if (!res.ok) { setError(res.msg); ui.toast(res.msg, "error"); }
  };

  // The conversation starts by itself when a person who may talk opens an assessed repo that has none yet.
  useEffect(() => {
    if (!s || !r || opened.current || s.messages.some((m) => m.data.kind !== "update") || !s.can.talk || s.busy === "assessing" || r.onboarding.stage === "connected") return;
    opened.current = true;
    void send({ kind: "open" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.messages.length, s?.can.talk, s?.busy, r?.onboarding.stage]);
  // Opening the session (or a new update arriving while it is open) clears it from the bell.
  const seenKey = s ? `${s.messages.length}:${s.messages.at(-1)?.id ?? ""}` : "";
  useEffect(() => { if (seenKey) void markSeen(repoId); }, [seenKey, repoId]);

  const items = useMemo(() => {
    if (!s || !r) return [];
    const msgs = s.messages.map((m) => ({ at: m.at, kind: "m" as const, m }));
    const tl = r.onboarding.timeline.map((t) => ({ at: t.at, kind: "t" as const, t }));
    return [...msgs, ...tl].sort((a, b) => a.at - b.at);
  }, [s, r]);

  if (!r) return <Empty title="No such repo" text="This repo is not in the project." action={<Btn label="Back to the pipeline" onClick={back} />} />;
  if (!s) return <div className="osx"><Async query={q} what="this onboarding session" id="onb-session">{() => null}</Async><Btn label="Back to the pipeline" small kind="ghost" icon="back" onClick={back} /></div>;

  const o = r.onboarding;
  const lastMsg = s.messages.at(-1)?.id;
  const pending = s.messages.flatMap((m) => (m.data.cards ?? []).filter((c): c is Proposal => c.kind === "proposal" && c.status === "pending").map((c) => ({ m, c })));
  const ruleBased = s.agent.mode === "rule-based";
  const composerNote = !s.can.talk ? `Read-only: ${s.can.talkWhy || "you may not change onboarding for this repo."}` : ruleBased ? "Connect a model vendor to talk to the Onboarding Agent" : "Answer a question, give a fact (for example: tests run with make check), or ask why.";
  const submit = () => { const t = draft.trim(); if (!t) return; setDraft(""); void send({ kind: "message", text: t }); };

  return (
    <div className="osx" id="osx">
      <header className="osx-top">
        <div className="osx-top-main">
          <Btn small kind="ghost" icon="back" id="osx-back" label="Pipeline" onClick={back} />
          <div className="small muted">Repo onboarding</div>
          <h1 className="vtitle osx-title mono">{r.name}</h1>
          <div className="osx-top-tags">
            <StatusChip r={r} />
            <Chip text={ruleBased ? "Rule-based (no agent)" : `Onboarding Agent v${s.agent.mode === "agent" ? s.agent.version : ""}`} cls={ruleBased ? "" : "chip-accent"} />
          </div>
        </div>
        <div className="vhead-actions"><Btn small id="osx-details" label="Details and settings" onClick={details} /></div>
      </header>
      <div className="osx-grid">
        <section className="osx-main" aria-label="Conversation">
          <div className="osx-thread" role="log" aria-live="polite" ref={thread}>
            <FindingsCard r={r} />
            {items.map((it) =>
              it.kind === "t" ? (
                <p key={`t${it.at}${it.t.text.slice(0, 12)}`} className="osx-event small"><span className="muted">{fmt.stamp(it.t.at)}</span> {nameOf(it.t.who)}: {it.t.text}</p>
              ) : (
                <div key={it.m.id} className={`osx-msg is-${it.m.role}${it.m.data.kind === "update" ? " is-update" : ""}`}>
                  {it.m.role === "user" ? <div className="osx-who small"><Who id={it.m.author} /></div> : <div className="osx-who small strong">{it.m.author === "ag-onboard" ? "Onboarding Agent" : "Gantry"}{it.m.data.mode === "rule-based" || it.m.author === "system" ? <span className="muted"> · rule-based</span> : null}</div>}
                  {it.m.text ? <p className="osx-text">{it.m.text}</p> : null}
                  <Cards m={it.m} s={s} send={(b) => void send(b)} last={it.m.id === lastMsg} />
                </div>
              ))}
            {live ? (
              <div className="osx-msg is-assistant is-live" aria-busy="true">
                <div className="osx-who small strong">Onboarding Agent</div>
                {live.tools.length ? <p className="osx-progress small muted">{`Working: ${live.tools.map((t) => t.replace(/_/g, " ")).join(", ")}`}</p> : null}
                <p className="osx-text">{live.text || "Reading the repository..."}</p>
                {live.cards.map((c, i) => (c.kind === "progress" ? <p key={i} className="osx-progress small"><Icon name="check" /> {c.text}</p> : null))}
              </div>
            ) : null}
            {s.waiting ? <p className="osx-waiting small" id="osx-waiting" role="status"><Icon name="clock" /> {`${s.waiting.text}${s.waiting.since ? ` since ${fmt.ago(s.waiting.since, Date.now())}` : ""}${s.waiting.checkedAt ? ` · checked ${fmt.ago(s.waiting.checkedAt, Date.now())}` : ""} · we'll post here and notify you`}</p> : null}
            {s.busy ? <p className="osx-event small muted">{`Gantry is working: ${s.next.text}.`}</p> : null}
            {error ? <p className="callout callout-warn small" role="alert">{error}</p> : null}
          </div>
          <form className="osx-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <textarea id="osx-input" className="input" rows={2} aria-label="Message to the Onboarding Agent" value={draft} placeholder={composerNote} disabled={!s.can.talk || ruleBased || !!live} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
            <Btn kind="primary" type="submit" id="osx-send" label="Send" disabled={!s.can.talk || ruleBased || !!live || !draft.trim()} />
            {ruleBased ? <p className="small muted osx-reason" id="osx-mode-note">{`Connect a model vendor to talk to the Onboarding Agent. ${s.agent.mode === "rule-based" ? s.agent.reason : ""}`}</p> : null}
          </form>
        </section>
        <aside className="osx-side" aria-label="Lifecycle"><h2 className="osx-side-h">Lifecycle</h2>
          <ol className="osx-steps" id="osx-steps">
            {s.steps.map((st) => (
              <li key={st.name} className={`is-${st.state}`} aria-current={st.state === "current" ? "step" : undefined}>
                <span className="osx-dot" aria-hidden="true">{st.state === "done" ? <Icon name="check" /> : null}</span>
                <span>{st.name}</span>
              </li>
            ))}
          </ol>
          <div className="osx-next" id="osx-next">
            <span className="small muted">Next</span>
            <p><strong>{{ agent: "Onboarding Agent", you: "You", gantry: "Gantry", github: "GitHub", reviewer: "A reviewer", nobody: "" }[s.next.actor]}</strong>{s.next.actor === "nobody" ? "" : " — "}{s.next.text}</p>
          </div>
          <dl className="osx-facts small">
            <dt>Mode</dt><dd>{s.agent.mode === "agent" ? `Onboarding Agent v${s.agent.version} · ${s.agent.model}` : "Rule-based (no agent)"}</dd>
            <dt>Cost so far</dt><dd className="mono" id="osx-cost">{`${fmt.money(s.costUsd)}${s.agent.mode === "agent" || s.budget.spentUsd ? ` of ${fmt.money(s.budget.limitUsd)} budget` : ""}`}</dd>
            {o.pr ? <><dt>Pull request</dt><dd>{o.pr.url ? <a href={o.pr.url} target="_blank" rel="noreferrer">{`#${o.pr.number}`}</a> : `#${o.pr.number}`}{` · ${o.pr.state === "merged" ? "merged" : `checks ${o.pr.checks}`}`}{s.prNeedsUpdate ? " · needs an update" : ""}</dd></> : null}
          </dl>
          <h2 className="osx-side-h">Proposed changes</h2>
          {pending.length ? (
            <ul className="osx-pending" id="osx-pending">
              {pending.map(({ m, c }) => (
                <li key={`${m.id}${c.id}`}>
                  <button type="button" className="linkish" onClick={() => document.getElementById(`osx-prop-${c.id}`)?.scrollIntoView?.({ block: "center" })}>{c.title}</button>
                  <span className="muted small">{` · ${c.files.length} file${c.files.length === 1 ? "" : "s"}`}</span>
                </li>
              ))}
            </ul>
          ) : <p className="muted small">None waiting.</p>}
        </aside>
      </div>
    </div>
  );
}
