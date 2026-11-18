/**
 * The onboarding session (spec 11.3): one conversation per repository for its whole onboarding. The agent (or, with no model, Gantry by rule) reads the repository, says what it
 * observed, asks, and proposes; a person approves, asks for changes or discards. Updates from the pipeline (checks, merge, verification) arrive in the same thread from the repo's
 * timeline. Side panel: where the repo is in the lifecycle, who acts next, what it cost, what is proposed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { fmt, type SessionCard } from "@gantry/domain";
import { useCan } from "../../api/can";
import { commands } from "../../api/commands";
import { useProjects, useRepos } from "../../api/queries";
import { hashFor, navigate } from "../../lib/router";
import { ActBtn, Kv } from "../projects/proto";
import { useTab } from "../projects/proto";
import { Avatar, Btn, Chip, Empty, Panel, Tabs, ViewHead, Who } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { decide, markSeen, sendTurn, useSession, type Session, type SessionMessage } from "./session-api";
import { busyText, useAvailableRepos, type RepoV } from "./kit";
import { PSTAGES, protoStage } from "./proto";
import { QuestionCard, useThreadEnd } from "../session/kit";

type Proposal = Extract<SessionCard, { kind: "proposal" }>;
/** Message roles drawn on the right (the person's own words). */
const ME: Record<string, true> = { user: true };
const ACTORS: Record<string, string> = { system: "Gantry", "ag-onboard": "Onboarding Agent", ci: "CI" };
const nameOf = (who: string): React.ReactNode => ACTORS[who] ?? (who.startsWith("github:") ? who : <Who id={who} />);

/* ------------------------------------------------------------------ cards ---- */

function Source({ source }: { source: "observed" | "agent" }) {
  return source === "agent" ? <span className="chip chip-accent onb-src" title="Drafted by the Onboarding Agent">Agent</span> : <span className="chip onb-src" title="Read or written by Gantry from the repository's own files">Observed</span>;
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

const STEPS = (st: number) => (
  <div className="stepper" id="osx-steps">
    {PSTAGES.map((n, i) => <div key={n} className={i < st ? "done" : i === st ? "on" : ""} aria-current={i === st ? "step" : undefined}>{`${i + 1}. ${n}`}</div>)}
  </div>
);

/** A repository the sources can see that has not been started: the same page with nothing assessed yet (the Blueprint's stage 0). */
function NotStarted({ projectId, projectName, name, lang }: { projectId: string; projectName: string; name: string; lang: string }) {
  const [tab, setTab] = useTab(["findings", "pr", "settings"], "findings");
  const none = "Start the assessment from the Onboarding list first.";
  return (
    <div className="osx" id="osx">
      <ViewHead crumbs={[{ label: "Onboarding", href: hashFor("onboarding", null, projectId) }, { label: name }]} title={name} sub="Onboarding session" />
      {STEPS(0)}
      <Tabs revealActive idPrefix="osx-tab" items={[{ id: "findings", label: "Findings" }, { id: "pr", label: "Pull request" }, { id: "settings", label: "Settings" }]} active={tab} onChange={setTab} />
      <div className="stack">
        {tab === "findings" ? (
          <>
            <Panel title="Assessment against guidelines" flush><ul className="list" /></Panel>
            <Panel title="Conversation with the Onboarding agent"><div className="chat" /></Panel>
          </>
        ) : tab === "pr" ? (
          <Panel title="Onboarding pull request">
            <Empty title="No pull request yet" text="Open one and the agent writes AGENTS.md, CODEOWNERS and the factory config." action={<>
              <Btn kind="primary" id="osx-openpr" label="Open pull request" disabled disabledReason={none} />
              <Btn id="osx-openanyway" label="Open anyway" disabled disabledReason={none} />
            </>} />
          </Panel>
        ) : (
          <Panel title="Settings"><Kv rows={[["Repository", name], ["Language", lang], ["Project", projectName], ["Default branch", "—"]]} /></Panel>
        )}
      </div>
    </div>
  );
}

export function SessionPage({ projectId, repoId, back, details }: { projectId: string; repoId: string; back: () => void; details: () => void }) {
  const reposQ = useRepos(projectId);
  const repos = (reposQ.data ?? []) as RepoV[];
  const r = repos.find((x) => x.id === repoId);
  const projectName = useProjects().data?.find((p) => p.id === projectId)?.name ?? projectId;
  const manage = useCan("onboarding.manage", { project: projectId, repo: repoId });
  const merge = useCan("onboarding.merge", { project: projectId, repo: repoId });
  const [tab, setTab] = useTab(["findings", "pr", "settings"], "findings");
  const availQ = useAvailableRepos(projectId, true);
  const q = useSession(repoId, !!r);
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

  const waiting = !r ? availQ.data?.available?.find((a) => a.repo === repoId || a.repo.replace("/", "--") === repoId) : undefined;
  if (!r && waiting) return <NotStarted projectId={projectId} projectName={projectName} name={waiting.repo} lang={waiting.lang} />;
  if (!r) return reposQ.data && (availQ.isSuccess || availQ.isError) ? <div><ViewHead title="Onboarding" /><Panel><Empty title="Nothing to show" text="That repo does not exist." action={<Btn label="Work orders" onClick={() => navigate("work-orders")} />} /></Panel></div> : <Async query={reposQ} what="this repo" id="onb-session-repo">{() => null}</Async>;
  if (!s) return <div className="osx"><Async query={q} what="this onboarding session" id="onb-session">{() => null}</Async><Btn label="Onboarding" small kind="ghost" icon="back" onClick={back} /></div>;

  const o = r.onboarding;
  const st = protoStage(r);
  const lastMsg = s.messages.at(-1)?.id;
  const ruleBased = s.agent.mode === "rule-based";
  const composerNote = !s.can.talk ? `Read-only: ${s.can.talkWhy || "you may not change onboarding for this repo."}` : ruleBased ? "Connect a model vendor to talk to the Onboarding Agent" : "Answer a question, give a fact (for example: tests run with make check), or ask for a change";
  const submit = () => { const t = draft.trim(); if (!t) return; setDraft(""); void send({ kind: "message", text: t }); };
  const list = o.findings;
  // the person answers in words only when the agent has asked something that is still open
  const asked = s.messages.some((m) => (m.data.cards ?? []).some((c) => c.kind === "question" && !c.answered)) || !!live;
  const recheck = async () => { const x = await commands.rerunAssessment(r.id); ui.toast(x.ok ? "Checking the repository again" : x.msg, x.ok ? "ok" : "error"); };
  // Gantry reads check results from GitHub: this refreshes them and says what they are
  const checks = async () => {
    const fresh = ((await reposQ.refetch()).data as RepoV[] | undefined)?.find((x) => x.id === r.id);
    const green = fresh?.onboarding.pr?.checks === "green";
    ui.toast(green ? "Checks passing" : "Checks are not passing yet", green ? "ok" : "error");
  };
  const nGaps = o.findings.filter((f) => !f.ok).length;
  const prOpen = !!o.pr && o.pr.state === "open";
  const busyNote = o.busy ? busyText(r) ?? "Working" : null;
  const requiredGap = o.findings.some((f) => !f.ok && f.required !== false);
  const openPr = () => run(() => commands.openOnboardingPR(r.id), "Pull request opened");
  const run = async (fn: () => Promise<{ ok: boolean; msg: string }>, ok?: string) => { const x = await fn(); ui.toast(x.ok && ok ? ok : x.msg, x.ok ? "ok" : "error"); };
  const mergeAsk = async () => {
    if (!o.pr) return;
    const yes = await ui.confirm({ title: `Merge #${o.pr.number}?`, body: `${r.name} becomes Ready and agents may start work.`, ok: "Merge" });
    if (yes) await run(() => commands.mergeOnboardingPR(r.id), `${r.name} is Ready`);
  };
  const mergeReason = merge.allowed ? (!prOpen ? "The PR is already merged" : busyNote ?? (o.pr?.checks !== "green" || o.stage !== "pr_checks" ? "Checks are not green yet" : null)) : null;
  const tabs = [{ id: "findings", label: "Findings", count: nGaps }, { id: "pr", label: "Pull request" }, { id: "settings", label: "Settings" }];

  return (
    <div className="osx" id="osx">
      <ViewHead crumbs={[{ label: "Onboarding", href: hashFor("onboarding", null, projectId) }, { label: r.name }]} title={r.name} sub="Onboarding session" />
      {STEPS(st)}
      <Tabs revealActive idPrefix="osx-tab" items={tabs} active={tab} onChange={setTab} />
      <div className="stack">
        {tab === "findings" ? (
          <>
            <Panel title="Assessment against guidelines" flush>
              {list.length ? (
                <ul className="list">
                  {list.map((f) => (
                    <li key={f.id}>
                      <Chip text={f.ok ? "met" : "gap"} cls={f.ok ? "ok" : f.required !== false ? "bad" : "warn"} />
                      <div className="grow">{f.check}<div className="small muted">{f.required !== false ? "Required" : "Advisory"}</div></div>
                      {!f.ok && st < 3 ? <ActBtn small id={`osx-fixed-${f.id}`} label="Mark fixed" guard={manage} disabledReason={manage.allowed ? busyNote : null} onClick={() => void recheck()} /> : null}
                    </li>
                  ))}
                </ul>
              ) : <ul className="list" />}
            </Panel>
            <Panel title="Conversation with the Onboarding agent">
              <div className="osx-main">
                <div className="chat osx-thread" role="log" aria-live="polite" ref={thread}>
                  {items.map((it) =>
                    it.kind === "t" ? (
                      <div key={`t${it.at}${it.t.text.slice(0, 12)}`} className="msg">
                        <Avatar id={it.t.who in ACTORS ? "ag-onboard" : it.t.who} />
                        <div className="bub"><div className="who">{nameOf(it.t.who)}</div>{it.t.text}</div>
                      </div>
                    ) : (
                      <div key={it.m.id} className={`msg${it.m.role in ME ? " me" : ""}${it.m.data.kind === "update" ? " is-update" : ""}`}>
                        <Avatar id={it.m.author in ACTORS ? "ag-onboard" : it.m.author} />
                        <div className="bub">
                          <div className="who">{nameOf(it.m.author)}{it.m.data.mode === "rule-based" ? " · rule-based" : ""}</div>
                          {it.m.text ? <p className="osx-text">{it.m.text}</p> : null}
                          <Cards m={it.m} s={s} send={(b) => void send(b)} last={it.m.id === lastMsg} />
                        </div>
                      </div>
                    ))}
                  {live ? (
                    <div className="msg is-live" aria-busy="true">
                      <Avatar id="ag-onboard" />
                      <div className="bub">
                        <div className="who">Onboarding Agent</div>
                        {live.tools.length ? <p className="osx-progress small muted">{`Working: ${live.tools.map((t) => t.replace(/_/g, " ")).join(", ")}`}</p> : null}
                        <p className="osx-text">{live.text || "Reading the repository..."}</p>
                        {live.cards.map((c, i) => (c.kind === "progress" ? <p key={i} className="osx-progress small"><Icon name="check" /> {c.text}</p> : null))}
                      </div>
                    </div>
                  ) : null}
                  {s.waiting ? <p className="osx-waiting small" id="osx-waiting" role="status"><Icon name="clock" /> {`${s.waiting.text}${s.waiting.since ? ` since ${fmt.ago(s.waiting.since, Date.now())}` : ""}${s.waiting.checkedAt ? ` · checked ${fmt.ago(s.waiting.checkedAt, Date.now())}` : ""} · we'll post here and notify you`}</p> : null}
                  {s.busy ? <p className="osx-event small muted">{`Gantry is working: ${s.next.text}.`}</p> : null}
                  {error ? <p className="callout callout-warn small" role="alert">{error}</p> : null}
                </div>
                {asked ? (
                  <form className="osx-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
                    <textarea id="osx-input" className="input" rows={2} aria-label="Message to the Onboarding Agent" value={draft} placeholder={composerNote} disabled={!s.can.talk || ruleBased || !!live} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
                    <Btn kind="primary" type="submit" id="osx-send" label="Send" disabled={!s.can.talk || ruleBased || !!live || !draft.trim()} />
                    {ruleBased ? <p className="small muted osx-reason" id="osx-mode-note">{`Connect a model vendor to talk to the Onboarding Agent. ${s.agent.mode === "rule-based" ? s.agent.reason : ""}`}</p> : null}
                  </form>
                ) : null}
              </div>
            </Panel>
          </>
        ) : tab === "pr" ? (
          <Panel title="Onboarding pull request">
            {o.pr ? (
              <div className="stack">
                <Kv rows={[
                  ["PR", `#${o.pr.number}`],
                  ["Status", <Chip key="s" text={o.pr.state === "merged" ? "merged" : o.pr.checks === "green" ? "checks passing" : o.pr.state} cls={st >= 3 ? "ok" : "info"} />],
                  ["Files", <div key="f" className="pre">{o.pr.files.map((f) => f.path).join("\n")}</div>],
                ]} />
                {s.prNeedsUpdate ? <p className="small muted">A later assessment found this pull request out of date. Approve the update in the conversation.</p> : null}
                {st === 2 ? <ActBtn id="osx-checks" label="Mark checks passing" guard={manage} onClick={() => void checks()} /> : null}
                {o.pr.state !== "merged" && st >= 3 ? <ActBtn kind="primary" id="osx-merge" label="Merge and go live" guard={merge} disabledReason={mergeReason} onClick={() => void mergeAsk()} /> : null}
              </div>
            ) : (
              <Empty title="No pull request yet" text="Open one and the agent writes AGENTS.md, CODEOWNERS and the factory config." action={<>
                <ActBtn kind="primary" id="osx-openpr" label="Open pull request" guard={manage} disabledReason={manage.allowed ? busyNote : null} onClick={() => { if (requiredGap) { ui.toast("Fix the required gaps first, or open the PR so the agent can fix them.", "error"); return; } void openPr(); }} />
                <ActBtn id="osx-openanyway" label="Open anyway" guard={manage} disabledReason={manage.allowed ? busyNote : null} onClick={() => void openPr()} />
              </>} />
            )}
          </Panel>
        ) : (
          <Panel title="Settings">
            <Kv rows={[["Repository", <a key="d" className="pri" id="osx-details" href={hashFor("onboarding", r.id, projectId)} onClick={(e) => { e.preventDefault(); details(); }}>{r.name}</a>], ["Language", r.lang], ["Project", projectName], ["Default branch", r.config.defaultBranch]]} />
          </Panel>
        )}
      </div>
    </div>
  );
}
