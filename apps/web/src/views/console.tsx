/**
 * Console (spec 8.9, 12.6). Port of legacy/js/views/console.js and ask.js against POST /api/v1/console/messages.
 * Free-form questions go to the API, which calls a model through the edge with a fixed tool set; the answer streams in. Slash commands run the same
 * tools directly against live data, so they work without a model. Anything that changes state is a confirm card that calls the ordinary endpoint
 * under the person's own permissions; the cards exist only while console actions are switched on (off in a new install).
 * Without a configured model the console says so: there are no canned answers.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fmt } from "@gantry/domain";
import { useCanMany } from "../api/can";
import { useAudit, useMe, useProjects, useWorkOrders } from "../api/queries";
import { setProject, usePrefs } from "../lib/prefs";
import { navigate } from "../lib/router";
import { Icon } from "../ui/Icon";
import { Avatar, Btn, Field, Panel, Select, StateChip, ViewHead } from "../ui/primitives";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { useOpenTraveler } from "../shell/useTraveler";
import { callTool, ck, clearThread, renameThread, savePinned, sendMessage, useConsoleStatus, useThread, useThreads, type StreamEvent } from "./console/api";
import { ChatList } from "./console/ChatList";
import { ResultCard, unmark, type CardCtx } from "./console/Cards";
import { EntityChip } from "./console/Chips";
import { ProposalCard } from "./console/Confirm";
import { Markdown } from "./console/Markdown";
import { ModelPicker } from "./console/ModelPicker";
import { plan as planSlash, SLASH } from "./console/slash";
import type { Card, Cited, Msg, Proposal, ThreadMessage } from "./console/types";

let seq = 1;
const localIds = (l: Msg[]): Set<string> => new Set(l.map((m) => m.id));
const nextId = (p: string): string => `${p}${Date.now().toString(36)}${seq++}`;
/** The client-side answers to slash commands, per person: they are not part of the saved thread (the model's conversation is). */
const localCache = new Map<string, Msg[]>();
/** Forgets the slash answers kept for this session (sign-out, tests). */
export const resetConsoleLocal = (): void => localCache.clear();

const fromServer = (m: ThreadMessage, me: string): Msg => {
  if (m.role === "user") return { id: m.id, role: "user", at: m.at, text: m.text, mode: "pending", by: m.author ?? me };
  if (m.role === "system") return { id: m.id, role: "factory", at: m.at, text: m.text, mode: m.data.kind === "no_model" ? "none" : "error" };
  return {
    id: m.id, role: "factory", at: m.at, text: m.text, mode: "model", serverId: m.id, cited: m.data.cited ?? [], stopped: !!m.data.stopped,
    ...(m.data.proposals?.length ? { cards: m.data.proposals.map((p): Card => ({ type: "proposal", proposal: p })) } : {}),
    ...(m.data.truncated ? { note: "The answer was cut short." } : {}),
  };
};

/** Suggested questions by role and current project (legacy `suggestions()`). */
function suggestionsFor(roles: string[], pn: string, projectId: string | null, stuck: string | null, done: string | null): string[] {
  const summ = done ?? stuck;
  if (roles.includes("factory_admin")) return ["Which gates are slowing us down?", `What changed in ${pn} this week?`, summ ? `Summarise ${summ} for a manager` : "/projects", `Who can release ${pn} tonight and why?`, "/bottlenecks"];
  if (roles.includes("auditor")) return [`What changed in ${pn} this week?`, "Show kills and halts in the last 7 days", `Who can kill ${pn} and why?`, `/trust ${projectId ?? ""}`.trim(), summ ? `Summarise ${summ} for a manager` : "/projects"];
  if (roles.includes("project_admin") || roles.includes("line_lead")) return ["Which gates are slowing us down?", "Who is the only approver on waiting gates?", stuck ? `Why is ${stuck} stuck?` : "/status", `What changed in ${pn} this week?`, `/trust ${projectId ?? ""}`.trim()];
  return ["What is waiting on me?", stuck ? `Why is ${stuck} stuck?` : "/status", summ ? `Summarise ${summ} for a manager` : "/projects", `What changed in ${pn} this week?`, "/status"];
}

const CAPS: Array<[string, string]> = [["wo.submit", "Submit work orders"], ["gate.approve", "Approve gates"], ["line.halt", "Halt (andon)"], ["line.resume", "Resume"], ["repo.onboard", "Connect repos"], ["triggers.edit", "Edit triggers"], ["kill.workorder", "Kill a work order"], ["kill.project", "Kill this project"], ["restore.project", "Restore this project"], ["kill.factory", "Kill the factory"]];

/**
 * The Console inside the Agent Workspace: the workspace owns which chat is open (its inbox replaces the chat list), may put its own header above
 * the conversation, and replaces the context panel for a side thread. `readOnly` says why the person cannot post (an archived chat, or a shared
 * one they were not invited to). `agent` names who answers in a side thread.
 */
export interface ConsoleEmbed {
  threadId: string | null;
  onThread: (id: string) => void;
  header?: ReactNode;
  /** The Console page: the conversation is drawn as a titled panel beside its context. */
  page?: boolean;
  aside?: ReactNode;
  readOnly?: string | null;
  agent?: { name: string; about: string } | null;
  /** A question to ask as soon as the chat is open (an @mention from a work order's thread). */
  initial?: string | null;
}

export default function ConsoleView({ embed }: { embed?: ConsoleEmbed } = {}) {
  const me = useMe();
  const ui = useUI();
  const qc = useQueryClient();
  const prefs = usePrefs();
  const status = useConsoleStatus(prefs.project);
  const threads = useThreads();
  const projects = useProjects().data ?? [];
  const openTraveler = useOpenTraveler();
  const actorOf = useActors();

  const meId = me?.person.id ?? "";
  const [threadId, setThreadIdState] = useState<string | null>(embed?.threadId ?? null);
  const setThreadId = useCallback((id: string | null) => {
    setThreadIdState(id);
    if (id && embed && id !== embed.threadId) embed.onThread(id);
  }, [embed]);
  const [fresh, setFresh] = useState(false);
  const thread = useThread(threadId);
  const [local, setLocalState] = useState<Msg[]>(() => localCache.get(meId) ?? []);
  const [tail, setTail] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState(false);
  /** Questions asked again with Retry: their earlier saved copy and error are hidden so the question shows once. */
  const [redo, setRedo] = useState<Array<{ text: string; cut: number }>>([]);
  const [draft, setDraft] = useState("");
  const [slashIdx, setSlashIdx] = useState(0);
  const ac = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);

  const setLocal = useCallback((f: (x: Msg[]) => Msg[]) => setLocalState((x) => { const n = f(x); localCache.set(meId, n); return n; }), [meId]);

  // Continue the latest saved conversation, unless the person cleared it. In the workspace the inbox decides.
  useEffect(() => {
    if (embed || threadId || fresh || !threads.data) return;
    const latest = threads.data.items[0];
    if (latest) setThreadId(latest.id);
  }, [embed, threads.data, threadId, fresh, setThreadId]);

  const visible = projects.filter((p) => p.status !== "archived");
  const cur = visible.find((p) => p.id === prefs.project) ?? visible[0] ?? null;
  const st = status.data;
  const actionsOn = !!st?.actionsEnabled;
  const proposalFor = (tool: string) => st?.proposals?.find((x) => x.tool === tool);
  const roles = useMemo(() => (me?.person.roles ?? []).filter((g) => g.scope === "factory" || g.scope === cur?.id).map((g) => g.role), [me, cur?.id]);
  const woQ = useMemo(() => ({ limit: 40 }), []);
  const wos = useWorkOrdersLite(cur?.id ?? null, woQ);
  const stuck = wos.find((w) => w.state === "waiting" || w.state === "blocked" || w.bay)?.id ?? wos.find((w) => !["done", "killed"].includes(w.state))?.id ?? null;
  const doneWo = wos.filter((w) => w.state === "done").slice(-1)[0]?.id ?? null;
  const suggestions = [...new Set(suggestionsFor(roles, cur?.name ?? "my projects", cur?.id ?? null, stuck, doneWo))];

  const serverMsgs = useMemo(() => {
    const all = thread.data?.messages ?? [];
    const hidden = new Set<string>();
    for (const r of redo) {
      const i = all.map((m) => m.role === "user" && m.text === r.text && m.at < r.cut).lastIndexOf(true);
      if (i < 0) continue;
      hidden.add(all[i]!.id);
      for (let j = i + 1; j < all.length && all[j]!.role === "system"; j++) hidden.add(all[j]!.id);
    }
    return all.filter((m) => !hidden.has(m.id)).map((m) => fromServer(m, meId));
  }, [thread.data, meId, redo]);
  const pinned = thread.data?.pinned ?? [];

  const msgs = useMemo(() => {
    // The optimistic rows (question + live answer) give way to the saved ones as soon as the server has them: a refetch mid-stream
    // (the SSE `change` the save publishes) must not show the question twice, and the saved answer replaces the streamed one.
    let rows = tail;
    const tu = tail.find((m) => m.role === "user");
    if (tu) {
      const su = serverMsgs.find((m) => m.role === "user" && (tu.serverId ? m.id === tu.serverId : m.text === tu.text && m.at >= tu.at - 10_000));
      if (su) {
        const answered = serverMsgs.some((m) => m.role === "factory" && m.at >= su.at && m.id !== su.id);
        rows = answered ? [] : tail.filter((m) => m.role !== "user").map((m) => ({ ...m, at: Math.max(m.at, su.at + 1) }));
      }
    }
    const all = [...serverMsgs, ...local, ...rows].sort((a, b) => a.at - b.at);
    if (all.length) return all;
    if (embed?.agent) return [{ id: "m0", role: "factory", at: 0, mode: "pending", text: `Ask ${embed.agent.name} about ${embed.agent.about}. ${embed.agent.name} answers from what the work has produced so far (documents, questions, sources) and reads live data with your permissions. Nothing changes from here: answers, corrections and send-backs belong in the primary thread.` } satisfies Msg];
    return [{ id: "m0", role: "factory", at: 0, mode: "pending", cards: [{ type: "suggest" }], text: `Ask about your projects in plain language, or use a slash command. ${st?.configured ? `Questions are answered by ${st.model} using tools over the live factory.` : "No model is configured, so questions cannot be answered yet; slash commands read live data directly."} Anything that changes state shows a confirm card and runs only when you click it. Questions without a project use your current project, ${cur?.name ?? "none"}.` } satisfies Msg];
  }, [serverMsgs, local, tail, st, cur, embed?.agent]);

  const lastMsg = msgs[msgs.length - 1];
  const prevMsg = msgs[msgs.length - 2];
  const retryable = !streaming && lastMsg?.role === "factory" && lastMsg.mode === "error" && prevMsg?.role === "user" && !prevMsg.text.startsWith("/") && !localIds(local).has(prevMsg.id) ? { text: prevMsg.text, errId: lastMsg.id } : null;

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, tail]);

  const focusComposer = (): void => { setTimeout(() => { const c = input.current; if (c) { c.focus(); c.setSelectionRange(c.value.length, c.value.length); } }, 30); };
  const toDraft = (t: string): void => { setDraft(t); setSlashIdx(0); focusComposer(); };

  const pin = (woId: string): void => {
    if (!threadId || pinned.includes(woId)) return;
    void savePinned(threadId, [...pinned, woId]).then(() => qc.invalidateQueries({ queryKey: ck.thread(threadId) }));
  };

  const addLocal = (m: Omit<Msg, "id" | "at">): Msg => {
    const msg = { ...m, id: nextId("l"), at: Date.now() } as Msg;
    setLocal((x) => [...x, msg]);
    return msg;
  };
  const cardCtx = (mid: string): CardCtx => ({ send: (t) => void send(t), draft: toDraft, mid, pinned, pin, suggestions, actionsEnabled: st?.proposals ? !!proposalFor("propose_approve_gate")?.allowed : actionsOn });

  /* ---------- slash commands: tools, directly ---------- */
  const runSlash = async (text: string): Promise<void> => {
    addLocal({ role: "user", text, mode: "pending", by: meId });
    const p = planSlash(text, visible, cur ? { id: cur.id, name: cur.name, key: cur.key } : null, Date.now());
    if (p.kind === "help") { addLocal({ role: "factory", mode: "slash", text: "Slash commands and plain sentences both work. Anything that changes state shows a confirm card first.", cards: [{ type: "help" }] }); return; }
    if (p.kind === "reply") { addLocal({ role: "factory", mode: "slash", text: p.text }); return; }
    const right = p.action ? proposalFor(p.tool) : undefined;
    if (p.action && st && st.proposals && (!right || !right.allowed)) {
      addLocal({ role: "factory", mode: "slash", text: `The console may not propose that for you: it needs '${right?.name ?? "a console right"}'. Ask a Factory Admin to give it to you (Govern > Access, Console group), or use the screen.` });
      return;
    }
    const r = await callTool(p.tool, p.input);
    if (!r.ok) { addLocal({ role: "factory", mode: "slash", text: r.msg }); return; }
    const res = r.result as { error?: string } | unknown;
    if (res && typeof res === "object" && !Array.isArray(res) && typeof (res as { error?: unknown }).error === "string") { addLocal({ role: "factory", mode: "slash", text: (res as { error: string }).error }); return; }
    if (p.card === "proposal") {
      const props = (r as { proposals?: Proposal[] }).proposals ?? [];
      if (!props.length) { addLocal({ role: "factory", mode: "slash", text: "Nothing to propose." }); return; }
      addLocal({ role: "factory", mode: "slash", text: p.intro, cards: props.map((x): Card => ({ type: "proposal", proposal: x })) });
      return;
    }
    addLocal({ role: "factory", mode: "slash", text: p.intro, cards: [{ type: p.card, data: res }], cited: (r as { cited?: Cited[] }).cited ?? [] });
  };

  /* ---------- the model: POST /console/messages, streamed ---------- */
  const askModel = async (text: string): Promise<void> => {
    const at = Date.now();
    const uid = nextId("u"), lid = nextId("a");
    const live: Msg = { id: lid, role: "factory", at: at + 1, text: "", mode: "pending", streaming: true };
    setTail([{ id: uid, role: "user", at, text, mode: "pending", by: meId }, live]);
    setStreaming(true);
    const ctl = new AbortController();
    ac.current = ctl;
    let tid = threadId;
    const patchLive = (f: (m: Msg) => Msg): void => setTail((t) => t.map((m) => (m.id === lid ? f(m) : m)));
    const onEvent = (e: StreamEvent): void => {
      if (e.event === "thread") { tid = e.data.threadId; setFresh(false); setThreadId(tid); if (e.data.messageId) setTail((t) => t.map((m) => (m.id === uid ? { ...m, serverId: e.data.messageId } : m))); }
      else if (e.event === "text") patchLive((m) => ({ ...m, text: m.text + e.data.delta }));
      else if (e.event === "proposal") patchLive((m) => ({ ...m, cards: [...(m.cards ?? []), { type: "proposal", proposal: e.data.proposal }], serverId: e.data.messageId }));
      else if (e.event === "unavailable" || e.event === "error") patchLive((m) => ({ ...m, text: e.data.msg, mode: e.event === "error" ? "error" : "none", streaming: false }));
      else if (e.event === "done") patchLive((m) => ({ ...m, text: e.data.text || m.text, mode: e.data.mode === "none" ? "none" : "model", streaming: false, cited: e.data.cited, stopped: !!e.data.stopped, serverId: e.data.messageId }));
    };
    const r = await sendMessage({ text, ...(threadId ? { threadId } : {}), ...(cur ? { project: cur.id } : {}) }, onEvent, ctl.signal);
    ac.current = null;
    try {
      if (!r.ok && !ctl.signal.aborted) {
        if (r.status === 404) { setThreadId(null); setFresh(true); }
        // Interrupted mid-answer: the server may still finish and save it, so look before showing an error.
        if (tid && r.status !== 404) await Promise.all([qc.refetchQueries({ queryKey: ck.thread(tid) }), qc.invalidateQueries({ queryKey: ck.threads() })]);
        patchLive((m) => ({ ...m, text: r.msg, mode: "error", streaming: false }));
        return;
      }
      if (tid) await Promise.all([qc.refetchQueries({ queryKey: ck.thread(tid) }), qc.invalidateQueries({ queryKey: ck.threads() })]);
      // The saved answer (the merge above) replaces the streamed one. If the stream ended without one, never leave a partial row marked streaming.
      patchLive((m) => (m.streaming ? { ...m, streaming: false, mode: m.text ? "model" : "error", text: m.text || "The answer ended without a reply. Try again.", note: m.text ? "The answer was cut short." : undefined } as Msg : m));
      // The tail is kept: the merge hides it once the saved question and answer are in the thread, and shows it (with Retry) if they never arrive.
    } finally {
      // Only now (after the saved thread is loaded) can Retry be offered: it needs to know which saved rows it replaces.
      setStreaming(false);
    }
  };

  const retry = (): void => {
    if (!retryable) return;
    setRedo((x) => [...x, { text: retryable.text, cut: Date.now() }]);
    setTail([]);
    void askModel(retryable.text);
  };

  const send = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text) return;
    if (streaming) { ui.toast("Wait for the current answer or stop it.", "warn"); return; }
    setDraft("");
    setSlashIdx(0);
    if (text.startsWith("/")) await runSlash(text);
    else await askModel(text);
  };

  // The question an @mention carried here is asked once, when the chat has loaded.
  const askedInitial = useRef<string | null>(null);
  useEffect(() => {
    const init = embed?.initial;
    if (!init || !threadId || askedInitial.current === threadId || streaming || !thread.data) return;
    askedInitial.current = threadId;
    void send(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embed?.initial, threadId, thread.data, streaming]);

  const clear = async (): Promise<void> => {
    if (threadId) await clearThread(threadId);
    setLocal(() => []);
    setTail([]);
    setThreadId(null);
    setFresh(true);
    await qc.invalidateQueries({ queryKey: ck.threads() });
  };

  /* ---------- chats ---------- */
  // Leave what is on screen behind: the saved chat is reloaded from the server; slash answers belong to the chat they were asked in.
  const leave = (): void => {
    ac.current?.abort();
    setLocal(() => []);
    setTail([]);
    setRedo([]);
  };
  const pickChat = (id: string): void => {
    if (id === threadId) return;
    leave();
    setFresh(false);
    setThreadId(id);
    focusComposer();
  };
  const newChat = (): void => {
    leave();
    setThreadId(null);
    setFresh(true);
    focusComposer();
  };
  // In the workspace the inbox picks the chat: follow it (a chat this view just created is already current).
  const ext = embed ? embed.threadId : undefined;
  const extSeen = useRef(ext);
  useEffect(() => {
    if (ext === undefined || ext === extSeen.current) return;
    extSeen.current = ext;
    if (ext === threadId) return;
    leave();
    setFresh(ext === null);
    setThreadIdState(ext);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ext]);
  const renameChat = async (id: string, title: string): Promise<string | null> => {
    const r = await renameThread(id, title);
    if (!r.ok) return r.msg;
    await qc.invalidateQueries({ queryKey: ck.threads() });
    return null;
  };
  const deleteChat = async (id: string): Promise<void> => {
    if (id === threadId) return clear();
    await clearThread(id);
    await qc.invalidateQueries({ queryKey: ck.threads() });
  };

  /* ---------- composer ---------- */
  const slash = draft.startsWith("/") && !draft.includes(" ") ? SLASH.filter((x) => x.cmd.startsWith(draft.toLowerCase())) : [];
  const idx = slashIdx >= slash.length ? 0 : slashIdx;
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slash.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setSlashIdx((idx + (e.key === "ArrowDown" ? 1 : slash.length - 1)) % slash.length); return; }
    if (slash.length && e.key === "Tab") { e.preventDefault(); toDraft(slash[idx]!.cmd); return; }
    if (slash.length && e.key === "Escape") { e.preventDefault(); setDraft(`${draft} `); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (slash.length && draft.trim() !== slash[idx]!.cmd.trim()) { toDraft(slash[idx]!.cmd); return; }
      void send(draft);
      focusComposer();
    }
  };

  /* ---------- context panel ---------- */
  const caps = useCanMany(CAPS.map(([action]) => ({ action, project: cur?.id ?? null })));
  const mine = useAudit({ channel: "console", actor: meId, limit: 30 });
  // The ledger also records that questions were asked and answered (console.*); this list is the changes confirmed from here.
  const recent = (Array.isArray(mine.data) ? mine.data : mine.data?.items ?? []).filter((a) => !a.action.startsWith("console.")).slice(0, 6);
  if (!me) return null;

  const hasModels = (st?.models?.length ?? 0) > 0;
  const noModels = !!st && st.models !== undefined && !hasModels;
  const modeLine = status.isLoading ? "Checking whether a model is configured." : st?.configured ? `Answers come from ${st.model} (${st.vendor}) using tools over the live factory. ${actionsOn ? "It may propose the actions your console rights allow; each waits for your click." : "It is read-only for you: you hold no console rights to propose changes."}` : noModels ? (st?.canManageModels ? "No model can be called yet." : "No model can be called yet. Ask a Factory Admin to connect a model vendor in Models.") : (st?.reason ?? "The console could not check its model.");
  const label = st?.configured ? "Model" : status.isLoading ? "Checking" : "No model";
  const cls = st?.configured ? "ready" : status.isLoading ? "checking" : "absent";

  const modeChip = <span className={`ask-badge ask-${cls}${streaming ? " is-busy" : ""}`} id={hasModels && st ? "con-status" : "con-mode"} role="status" title={modeLine} aria-label={`Answer mode: ${label}. ${modeLine}`}>{label}</span>;
  const modePicker = hasModels && st ? <ModelPicker st={st} busy={streaming} /> : null;
  const chatTitle = threadId ? threads.data?.items.find((t) => t.id === threadId)?.title ?? "Conversation" : "New conversation";
  const nameOf = (m: Msg) => (m.role === "user" ? (m.by && m.by !== meId ? actorOf(m.by).name : me.person.name) : embed?.agent?.name ?? "Gantry");
  return (
    <div className={embed ? "view-console ws-chat" : "view view-console"}>
      {embed ? embed.header : <ViewHead title="Console" status={modeChip} sub="Talk to the factory in plain language or with slash commands. Anything that changes state shows a confirm card and waits for you." actions={modePicker} />}
      <div className={`console-grid${embed ? " is-embedded" : ""}`}>
        {embed ? null : <ChatList items={threads.data?.items ?? []} current={threadId} busy={streaming} onPick={pickChat} onNew={newChat} onRename={renameChat} onDelete={deleteChat} />}
        <section className={`console-main${embed?.page ? " panel" : ""}`} aria-label="Conversation">
          {embed?.page ? <header><h2><span className="sec" aria-hidden="true" />Conversation</h2></header> : null}
          {embed ? null : (
            <div className="con-bar" id="con-bar">
              <div className="con-bar-title"><b>{chatTitle}</b><span className="small muted">{`${threads.data?.items.length ?? 0} saved`}</span></div>
              <Btn label="Conversations" small icon="list" id="con-threads" onClick={() => { const el = document.getElementById("con-chats"); el?.scrollIntoView({ block: "nearest" }); el?.querySelector<HTMLElement>("input, button")?.focus(); }} />
              <Btn label="New" small icon="plus" id="con-new" disabledReason={streaming ? "Wait for the answer or stop it." : null} onClick={newChat} />
              <Btn label="Clear conversation" small kind="ghost" icon="x" id="con-clear" disabledReason={threadId || local.length ? null : "There is nothing to clear."} onClick={() => void clear()} />
            </div>
          )}
          {embed?.agent ? null : <p className="con-mode-line small" id="con-mode-reason">{embed ? modeChip : <Icon name={st?.configured ? "check" : "dots"} />}<span>{modeLine}</span>{embed ? <span className="con-mode-pick">{modePicker}</span> : null}{noModels && st?.canManageModels ? <a href="#models" id="con-connect-vendor" onClick={(e) => { e.preventDefault(); navigate("models"); }}>Connect a model vendor</a> : null}</p>}
          <div className="thread" id="con-thread" ref={log} role="log" aria-live="polite" aria-label="Console conversation" data-keep-scroll="con-thread">
            {msgs.map((m) => (
              <div className={`msg msg-${m.role}`} key={m.id}>
                <div className="msg-who">
                  {m.role === "user" ? <Avatar id={m.by} size="sm" /> : <span className="av av-factory av-sm" aria-hidden="true">{embed?.agent ? embed.agent.name.slice(0, 1) : "G"}</span>}
                  <span className="msg-name">{nameOf(m)}</span>
                  {m.at ? <span className="mono muted small">{fmt.ist(m.at)}</span> : null}
                </div>
                {m.streaming ? <div className={`msg-text${m.text ? "" : " is-thinking"}`} id={`con-msg-text-${m.id}`}>{m.text ? <Markdown text={m.text} /> : "Thinking…"}</div> : m.text ? <div className={`msg-text${m.role === "factory" && (m.mode === "model" || m.mode === "pending") ? " is-md" : ""}`} id={`con-msg-text-${m.id}`}>{m.role === "factory" && (m.mode === "model" || m.mode === "pending") ? <Markdown text={m.text} /> : m.text}</div> : null}
                {m.role === "factory" && m.mode !== "pending" ? (
                  <div className="msg-meta">
                    <span className={`msg-mode is-${m.mode}`}>{m.mode === "model" ? `${st?.model ?? "Model"}${m.stopped ? " · stopped" : ""}` : m.mode === "slash" ? "Slash command · live data" : m.mode === "none" ? "No model configured" : "Model did not answer"}</span>
                    {m.note ? <span className="msg-note">{m.note}</span> : null}
                    {retryable && retryable.errId === m.id ? <Btn label="Retry" small kind="ghost" icon="send" id="con-retry" onClick={retry} /> : null}
                  </div>
                ) : m.streaming ? <div className="msg-meta"><span className="msg-mode is-pending">Model · streaming</span></div> : null}
                {m.cited?.length ? <div className="chips msg-chips" aria-label="Used in this answer"><span className="kicker">Used</span>{m.cited.map((e) => <EntityChip key={`${e.type}:${e.id}`} e={e} />)}</div> : null}
                {m.cards?.map((c, i) => c.type === "proposal" && c.proposal
                  ? <ProposalCard key={`${m.id}-${c.proposal.id}`} p={c.proposal} mid={m.id} serverId={m.serverId} />
                  : <ResultCard key={`${m.id}-${i}`} type={c.type} data={c.data} c={cardCtx(m.id)} />)}
              </div>
            ))}
          </div>
          {embed?.readOnly ? <p className="composer composer-ro small" id="con-readonly-thread" role="note"><Icon name="lock" /><span>{embed.readOnly}</span></p> : (
          <form className="composer" id="con-form" onSubmit={(e) => { e.preventDefault(); void send(draft); focusComposer(); }}>
            {slash.length ? (
              <ul className="slash-menu" id="con-slash" role="listbox" aria-label="Commands">
                {slash.map((x, i) => <li key={x.cmd} role="option" id={`con-slash-${i}`} className={i === idx ? "is-active" : ""} aria-selected={i === idx} onMouseDown={(e) => { e.preventDefault(); toDraft(x.cmd); }}><span className="mono">{x.cmd.trim()}</span><span className="muted">{x.hint}</span></li>)}
              </ul>
            ) : null}
            <textarea id="con-input" ref={input} className="input composer-input" rows={2} placeholder={embed?.agent ? `Ask ${embed.agent.name}` : "Ask or instruct. Type / for commands."} aria-label="Message the factory" aria-autocomplete="list" aria-controls="con-slash" value={draft} onChange={(e) => { setDraft(e.target.value); setSlashIdx(0); }} onKeyDown={onKey} />
            <div className="composer-foot">
              <div className="chips">{embed?.agent ? null : <span className="try-lbl muted small">Try</span>}{embed?.agent ? null : suggestions.slice(0, 3).map((sg, i) => <button type="button" key={sg} className="sugg" id={`con-foot-sug-${i}`} onClick={() => void send(sg)}>{sg}</button>)}</div>
              {streaming ? (
                <div className="row gap-sm"><Btn label="Stop" kind="danger" small icon="x" id="con-stop" onClick={() => ac.current?.abort()} /><Btn label="Send" kind="primary" icon="send" type="submit" id="con-send" disabledReason="Wait for the answer or stop it." /></div>
              ) : <Btn label="Send" kind="primary" icon="send" type="submit" id="con-send" />}
            </div>
          </form>
          )}
        </section>
        {embed?.aside ?? (
        <aside className="ctx" aria-label="Console context">
          <Panel title="Pinned work orders">
            {pinned.length ? <ul className="pins">{pinned.map((id) => <li key={id}><button type="button" className="linkish" id={`con-pin-${id}`} onClick={() => openTraveler(id)}><span className="mono">{id}</span></button>
              <button type="button" className="icon-btn icon-btn-sm" id={`con-unpin-${id}`} aria-label={`Unpin ${id}`} onClick={() => threadId && void savePinned(threadId, pinned.filter((x) => x !== id)).then(() => qc.invalidateQueries({ queryKey: ck.thread(threadId) }))}><Icon name="x" /></button></li>)}</ul> : <p className="muted small">Pin a work order from a why card.</p>}
          </Panel>
          <Panel title={`What ${me.person.name.split(" ")[0]} can do${cur ? ` in ${cur.name}` : ""}`}>
            <div className="con-ctx">
              <Field label="Current project" htmlFor="con-ctx-project"><Select id="con-ctx-project" aria-label="Current project" value={cur?.id ?? ""} onChange={setProject} options={visible.map((x) => ({ value: x.id, label: x.name }))} /></Field>
              {cur ? <div><StateChip state={cur.killed ? "killed" : cur.halted ? "blocked" : "running"} /></div> : null}
            </div>
            <ul className="caps">{CAPS.map(([action, text], i) => { const d = caps[i]!; return <li key={action} className={d.allowed ? "ok" : "no"} tabIndex={0} data-tip={d.reason}><Icon name={d.allowed ? "check" : "lock"} /><span>{text}</span><code className="cap-code mono" title="The permission that governs this action. Admins find it under Govern, Access.">{action}</code></li>; })}</ul>
          </Panel>
          <Panel title="Your console actions">
            {recent.length ? <ul className="mini-log con-log">{recent.map((a) => <li key={a.id}><span className="mono muted">{fmt.ist(a.at)}</span><span>{`${a.action} · ${unmark(a.target)}`}</span><span className={`outcome o-${a.outcome}`}>{a.outcome}</span></li>)}</ul> : <p className="muted small">Actions you confirm here are written to the audit ledger with via console.</p>}
            <div className="con-audit-link"><Btn label="Open in the audit log" small icon="shield" id="con-open-audit" onClick={() => navigate("audit", "console")} /></div>
          </Panel>
          <Panel title="What the console can do for you">
            <ul className="caps" id="con-rights">
              {(st?.proposals ?? []).map((p) => <li key={p.kind} id={`con-right-${p.kind}`} className={p.allowed ? "ok" : "no"} tabIndex={0} data-tip={p.reason}><Icon name={p.allowed ? "check" : "lock"} /><span>{`Propose: ${p.does}`}</span><span className="small muted">{p.allowed ? "allowed" : p.needs || p.reason}</span></li>)}
            </ul>
            {st && st.proposals && !st.proposals.some((p) => p.allowed) ? <p className="muted small" id="con-readonly">Your console is read-only: it can answer questions but not propose changes. Ask a Factory Admin for a console right.</p> : null}
            <p className="muted small">Confirming a card also needs the underlying right (for example submit work orders on that project).</p>
            {st?.isFactoryAdmin ? <a href="#access" id="con-manage-perms" onClick={(e) => { e.preventDefault(); navigate("access"); }}>Manage console permissions: Govern, Access (Console group)</a> : null}
          </Panel>
          <p className="footnote">{`Questions go to ${st?.configured ? st.model : "the configured model"} through the Gantry edge, with tools that read only what you may see. Work order, issue and repository text is passed as untrusted data. Slash commands read the same tools directly and never need a model. Conversations are kept for ${st?.retentionDays ?? 90} days. Proposed actions run only after you confirm them here, under your own permissions, and are audited with via console.`}</p>
        </aside>
        )}
      </div>
    </div>
  );
}

/** Recent work orders of a project, for the suggested questions only (a stuck one, a finished one). */
function useWorkOrdersLite(projectId: string | null, q: { limit: number }): Array<{ id: string; state: string; bay: string | null }> {
  const r = useWorkOrders(projectId, q);
  const d = r.data;
  const items = Array.isArray(d) ? d : d?.items ?? [];
  return items as Array<{ id: string; state: string; bay: string | null }>;
}
