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
import { useAudit, useHome, useMe, useProjects, useWorkOrders } from "../api/queries";
import { setProject, usePrefs } from "../lib/prefs";
import { formatHash, navigate, replaceHash, useHash } from "../lib/router";
import { Icon } from "../ui/Icon";
import { Avatar, Btn, Empty, Field, Panel, Select, StateChip, ViewHead } from "../ui/primitives";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { callTool, ck, clearThread, renameThread, savePinned, sendMessage, useConsoleStatus, useThread, useThreads, type StreamEvent } from "./console/api";
import { ConsoleChats, type ChatRow } from "./console/ConsoleChats";
import { useInbox, wk } from "./workspace/api";
import { useNewWorkOrder } from "./work-orders/New";
import { ResultCard, unmark, type CardCtx } from "./console/Cards";
import { EntityChip } from "./console/Chips";
import { ProposalCard } from "./console/Confirm";
import { Markdown } from "./console/Markdown";
import { ModelPicker } from "./console/ModelPicker";
import { plan as planSlash, SLASH } from "./console/slash";
import { helpText, liveAnswer, type LiveCtx, type LiveWo } from "./console/live";
import { useCatalog } from "./projects/kit";
import type { Card, Cited, Msg, Proposal, ThreadMessage } from "./console/types";
import "../styles/views/console.css";
import "../styles/views/console-page.css";

let seq = 1;
/** Whether a message was written by a person (not the console). */
const byPerson = (m: Msg): boolean => m.role === "user";
const localIds = (l: Msg[]): Set<string> => new Set(l.map((m) => m.id));
const nextId = (p: string): string => `${p}${Date.now().toString(36)}${seq++}`;
/** A model id for the header chip: no vendor prefix, no date suffix ("claude-sonnet-5-5-20260101" becomes "sonnet-5-5"). The full name stays in the chip's title and the picker. */
export const shortModel = (id: string): string => (id.replace(/^(claude|gpt|gemini)-/i, "").replace(/-\d{8}$/, "") || id);

/** T-52: the model's display name for the chip ("Sonnet 5.5"): the catalogue name without the vendor word and any "(Bedrock)" tail, else the id made readable ("claude-sonnet-5-5" becomes "Sonnet 5.5"). */
export function modelName(id: string, models?: Array<{ id: string; name: string }>): string {
  const named = models?.find((m) => m.id === id)?.name;
  if (named) return named.replace(/^(claude|gpt|gemini)\s+/i, "").replace(/\s*\([^)]*\)\s*$/, "").trim() || named;
  const parts = shortModel(id).split("-");
  const words = parts.filter((p) => !/^\d+$/.test(p));
  const nums = parts.filter((p) => /^\d+$/.test(p));
  const w = words.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(" ");
  return (nums.length ? `${w} ${nums.join(".")}` : w).trim() || id;
}

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
  const hash = useHash();
  const newWo = useNewWorkOrder();
  const inbox = useInbox(false);
  // The Console page (not the workspace's embedded chat) keeps its chat in the URL: #console/<chatId>, #console/new for a new chat.
  const page = !embed;
  const hp = page && hash.id === "console" ? hash.param : null;
  const actorOf = useActors();

  const meId = me?.person.id ?? "";
  const [threadId, setThreadIdState] = useState<string | null>(embed?.threadId ?? (hp && hp !== "new" ? hp : null));
  const setThreadId = useCallback((id: string | null) => {
    setThreadIdState(id);
    if (id && embed && id !== embed.threadId) embed.onThread(id);
    if (id && !embed) replaceHash(formatHash("console", id));
  }, [embed]);
  const [fresh, setFresh] = useState(hp === "new");
  /** The project this chat is about (page): "" is All projects. A saved chat shows its own. */
  const [scope, setScope] = useState("");
  const [chatsOpen, setChatsOpen] = useState(false);
  const thread = useThread(threadId);
  const [local, setLocalState] = useState<Msg[]>(() => localCache.get(meId) ?? []);
  const [tail, setTail] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState(false);
  /** Questions asked again with Retry: their earlier saved copy and error are hidden so the question shows once. */
  const [redo, setRedo] = useState<Array<{ text: string; cut: number }>>([]);
  /** A panel the person asked for with /chats or /settings (the prototype page has neither). */
  const [aux, setAux] = useState<"settings" | null>(null);
  const [draft, setDraft] = useState("");
  const [slashIdx, setSlashIdx] = useState(0);
  const ac = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);

  const setLocal = useCallback((f: (x: Msg[]) => Msg[]) => setLocalState((x) => { const n = f(x); localCache.set(meId, n); return n; }), [meId]);

  // Continue the latest saved conversation, unless the person cleared it. In the workspace the inbox decides.
  useEffect(() => {
    if (embed || threadId || fresh || hp === "new" || !threads.data) return;
    const latest = threads.data.items[0];
    if (latest) setThreadId(latest.id);
  }, [embed, threads.data, threadId, fresh, hp, setThreadId]);

  const visible = projects.filter((p) => p.status !== "archived");
  const scoped = page && scope ? visible.find((p) => p.id === scope) ?? null : null;
  const cur = scoped ?? visible.find((p) => p.id === prefs.project) ?? visible[0] ?? null;
  const st = status.data;
  const actionsOn = !!st?.actionsEnabled;
  const proposalFor = (tool: string) => st?.proposals?.find((x) => x.tool === tool);
  const woQ = useMemo(() => ({ limit: 40 }), []);
  const wos = useWorkOrdersLite(cur?.id ?? null, woQ);
  const cat = useCatalog();
  const home = useHome().data;
  const liveCtx: LiveCtx = {
    wos: wos.map((w): LiveWo => ({ ...w, ...(typeof w.station === "number" && cat?.stations[w.station] ? { stationName: cat.stations[w.station]!.name } : {}) })),
    waiting: (home?.approvals ?? []).filter((a) => a.wo).map((a) => ({ wo: a.wo!, ...(a.gate ? { gate: a.gate } : {}) })),
    spend: projects.length ? { mtd: projects.reduce((n, p) => n + (p.budget?.mtd ?? 0), 0), monthly: projects.reduce((n, p) => n + (p.budget?.monthly ?? 0), 0) } : null,
    project: cur?.name ?? null,
  };

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
    return [{ id: "m0", role: "factory", at: 0, mode: "pending", text: `Ask about your projects in plain language, or use a slash command. ${st?.configured ? `Questions are answered by ${st.model} using tools over the live factory.` : "No model is configured, so questions cannot be answered yet; slash commands read live data directly."} Anything that changes state shows a confirm card and runs only when you click it. Questions without a project use your current project, ${cur?.name ?? "none"}.` } satisfies Msg];
  }, [serverMsgs, local, tail, st, cur, embed?.agent]);

  const lastMsg = msgs[msgs.length - 1];
  const prevMsg = msgs[msgs.length - 2];
  const retryable = !streaming && lastMsg?.role === "factory" && lastMsg.mode === "error" && prevMsg?.role === "user" && !prevMsg.text.startsWith("/") && !localIds(local).has(prevMsg.id) ? { text: prevMsg.text, errId: lastMsg.id } : null;

  // The conversation opens at the newest message and follows new ones.
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, tail, threadId, thread.data?.id]);

  const focusComposer = (): void => { setTimeout(() => { const c = input.current; if (c) { c.focus({ preventScroll: true }); c.setSelectionRange(c.value.length, c.value.length); } }, 30); };
  // Opening the Console puts the cursor in the composer without scrolling the page (autoFocus scrolled the title off a phone screen).
  const focused = useRef(false);
  useEffect(() => { if (page && !focused.current && input.current) { focused.current = true; input.current.focus({ preventScroll: true }); } });
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
  const cardCtx = (mid: string): CardCtx => ({ send: (t) => void send(t), draft: toDraft, mid, pinned, pin, actionsEnabled: st?.proposals ? !!proposalFor("propose_approve_gate")?.allowed : actionsOn });

  /* ---------- slash commands: tools, directly ---------- */
  const runSlash = async (text: string): Promise<void> => {
    // The chat list and the model and rights panel are not on the page (the prototype has neither): /chats and /settings open them.
    if (page && /^\/(chats|settings)\s*$/i.test(text)) { if (/chats/i.test(text)) setChatsOpen(true); else setAux("settings"); return; }
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
      else if (e.event === "unavailable" || e.event === "error") patchLive((m) => (page ? { ...m, text: helpText(liveCtx), mode: "live", streaming: false } : { ...m, text: e.data.msg, mode: e.event === "error" ? "error" : "none", streaming: false }));
      else if (e.event === "done") patchLive((m) => ({ ...m, text: e.data.text || m.text, mode: e.data.mode === "none" ? "none" : "model", streaming: false, cited: e.data.cited, stopped: !!e.data.stopped, serverId: e.data.messageId }));
    };
    const r = await sendMessage({ text, ...(threadId ? { threadId } : {}), ...(page ? (scoped ? { project: scoped.id } : {}) : cur ? { project: cur.id } : {}) }, onEvent, ctl.signal);
    ac.current = null;
    try {
      if (!r.ok && !ctl.signal.aborted) {
        if (r.status === 404) { setThreadId(null); setFresh(true); }
        // Interrupted mid-answer: the server may still finish and save it, so look before showing an error.
        if (tid && r.status !== 404) await Promise.all([qc.refetchQueries({ queryKey: ck.thread(tid) }), qc.invalidateQueries({ queryKey: ck.threads() })]);
        // On the Console page a question the model cannot answer gets the prototype's help line (what can be asked), not a bare error.
        patchLive((m) => (page ? { ...m, text: helpText(liveCtx), mode: "live", streaming: false } : { ...m, text: r.msg, mode: "error", streaming: false }));
        return;
      }
      if (tid) await Promise.all([qc.refetchQueries({ queryKey: ck.thread(tid) }), qc.invalidateQueries({ queryKey: ck.threads() })]);
      // The saved answer (the merge above) replaces the streamed one. If the stream ended without one, never leave a partial row marked streaming.
      patchLive((m) => (m.streaming ? { ...m, streaming: false, mode: m.text ? "model" : page ? "live" : "error", text: m.text || (page ? helpText(liveCtx) : "The answer ended without a reply. Try again."), note: m.text ? "The answer was cut short." : undefined } as Msg : m));
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
    if (text.startsWith("/")) { await runSlash(text); return; }
    // On the Console page the four suggested questions (and, with no model configured, any question about a work order, what waits, what is blocked
    // or spend) are answered at once from live state. Other questions go to the model; with no model the page says what can be asked.
    if (page) {
      const isChip = /^status of wo-?\d+\??$/i.test(text);
      const modelOff = !!st && !st.configured;
      const answer = isChip || modelOff ? liveAnswer(text, liveCtx) ?? (modelOff ? helpText(liveCtx) : null) : null;
      if (answer !== null) {
        addLocal({ role: "user", text, mode: "pending", by: meId });
        addLocal({ role: "factory", mode: "live", text: answer });
        return;
      }
    }
    await askModel(text);
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
    if (page) replaceHash(formatHash("console", "new"));
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
    setChatsOpen(false);
    if (id === threadId) return;
    if (page) { navigate("console", id); focusComposer(); return; }
    leave();
    setFresh(false);
    setThreadId(id);
    focusComposer();
  };
  const newChat = (): void => {
    setChatsOpen(false);
    if (page) { navigate("console", "new"); focusComposer(); return; }
    leave();
    setThreadId(null);
    setFresh(true);
    focusComposer();
  };
  // The page follows its URL: a chat link opens that chat, #console/new an empty one (a chat this view just created is already current).
  useEffect(() => {
    if (!page || hash.id !== "console") return;
    if (hp === "new") {
      if (threadId !== null || !fresh) { leave(); setThreadIdState(null); setFresh(true); setScope(""); }
      return;
    }
    if (hp && hp !== threadId) { leave(); setFresh(false); setThreadIdState(hp); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hp]);
  // A saved chat shows the project it is about.
  const savedScope = thread.data?.projectId;
  useEffect(() => {
    if (page && threadId && thread.data?.id === threadId) setScope(savedScope ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, threadId, thread.data?.id, savedScope]);
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
  const onKey = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
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
  // Why the console proposes nothing: name the real reason (the factory's console actions are off, or no console right is granted to this person) and who can change it.
  const whoSwitches = st?.isFactoryAdmin ? "You can switch them on under Govern, Access (Console group)." : "A Factory Admin can switch them on under Govern, Access (Console group).";
  const offReason = st?.canUse === false ? `You may not use the console${st.use?.reason ? `: ${st.use.reason}` : "."}` : st?.proposals?.length ? `Console actions are switched off for you: no console right to propose changes is granted. ${whoSwitches} It still answers questions.` : `Console actions are switched off for this factory, so it only answers questions. ${whoSwitches}`;
  const modeLine = status.isLoading ? "Checking whether a model is configured." : st?.configured ? `Answers come from ${st.model} (${st.vendor}) using tools over the live factory. ${actionsOn ? "It may propose the actions your console rights allow; each waits for your click." : offReason}` : noModels ? (st?.canManageModels ? "No model can be called yet." : "No model can be called yet. Ask a Factory Admin to connect a model vendor in Models.") : (st?.reason ?? "The console could not check its model.");
  // In Settings the model is named once (the select, or the header chip when there is no select), so this line only says what is not working.
  const settingsLine = st?.configured ? (actionsOn ? null : offReason) : modeLine;
  const label = st?.configured ? modelName(st.effectiveModel ?? st.model ?? "Model", st.models) : status.isLoading ? "Checking" : "No model";
  const cls = st?.configured ? "ready" : status.isLoading ? "checking" : "absent";

  const modeChip = <span className={`ask-badge ask-${cls}${streaming ? " is-busy" : ""}`} id={hasModels && st ? "con-status" : "con-mode"} role="status" title={modeLine} aria-label={`Answer mode: ${label}. ${modeLine}`}>{label}</span>;
  const modePicker = hasModels && st ? <ModelPicker st={st} busy={streaming} /> : null;
  const chatTitle = threadId ? threads.data?.items.find((t) => t.id === threadId)?.title ?? "Conversation" : "New conversation";
  const nameOf = (m: Msg) => (m.role === "user" ? (m.by && m.by !== meId ? actorOf(m.by).name : me.person.name) : embed?.agent?.name ?? "Gantry");
  const ctxPanels = (
    <>
          <Panel title={`What ${me.person.name.split(" ")[0]} can do${cur ? ` in ${cur.name}` : ""}`}>
            <div className="con-ctx">
              {page ? null : <Field label="Current project" htmlFor="con-ctx-project"><Select id="con-ctx-project" aria-label="Current project" value={cur?.id ?? ""} onChange={setProject} options={visible.map((x) => ({ value: x.id, label: x.name }))} /></Field>}
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
            {st && st.proposals && !st.proposals.some((p) => p.allowed) ? <p className="muted small" id="con-readonly">{offReason}</p> : null}
            <p className="muted small">Confirming a card also needs the underlying right (for example submit work orders on that project).</p>
            {st?.isFactoryAdmin ? <a href="#access" id="con-manage-perms" onClick={(e) => { e.preventDefault(); navigate("access"); }}>Manage console permissions: Govern, Access (Console group)</a> : null}
          </Panel>
    </>
  );
  /* ---------- the Console page: a general chat with Gantry. Left: the chat list. Right: the chat (header, messages that scroll, composer pinned) ---------- */
  if (page) {
    const empty = msgs.length === 1 && msgs[0]!.id === "m0" && !streaming;
    const modeOf = (m: Msg): string => (m.mode === "model" ? `${st?.model ?? "Model"}${m.stopped ? " · stopped" : ""}` : m.mode === "live" ? "Live work-order state" : m.mode === "slash" ? "Slash command · live data" : m.mode === "none" ? "No model configured" : "Model did not answer");
    const inboxBy = new Map((inbox.data?.items ?? []).map((i) => [i.key, i]));
    const projName = (id: string | null | undefined): string | undefined => (id ? projects.find((x) => x.id === id)?.name ?? id : undefined);
    const rows: ChatRow[] = (threads.data?.items ?? []).map((t) => {
      const it = inboxBy.get(t.id);
      return { id: t.id, title: t.title, updatedAt: t.updatedAt, count: t.count, mine: true, scope: it ? (projName(it.project) ?? "All projects") : undefined, visibility: it?.visibility ?? null, canShare: !!it && !!it.project };
    });
    for (const it of inbox.data?.items ?? []) {
      if (it.kind !== "chat" || it.mine || !it.shared || rows.some((r) => r.id === it.key)) continue;
      rows.push({ id: it.key, title: it.title, updatedAt: it.updatedAt, mine: false, scope: projName(it.project) ?? "All projects", visibility: it.visibility, canShare: false });
    }
    rows.sort((x, y) => y.updatedAt - x.updatedAt);
    const refreshChats = (): void => { void qc.invalidateQueries({ queryKey: ck.threads() }); void qc.invalidateQueries({ queryKey: wk.all() }); };
    const readOnly = !!thread.data && !!thread.data.can && !thread.data.can.post;
    return (
      <div className="view view-console view-console-page">
        <ViewHead kicker="ALL LINES" title="Console" sub="Ask Gantry anything about your factory. Answers come from live data, and nothing changes without your approval."
          actions={<Btn label="Submit work order" small icon="plus" id="con-new-wo" onClick={() => newWo({})} />} />
        <div className={`con2${chatsOpen ? " list-open" : ""}`} id="con2">
          <ConsoleChats rows={rows} current={threadId} busy={streaming} onPick={pickChat} onNew={newChat} onRename={renameChat} onDelete={deleteChat} onChanged={refreshChats} />
          <section className="con2-main" aria-label="Chat" id="con2-main">
            <header className="con2-head" id="con-head">
              <Btn label="Chats" small icon="list" id="con-open-chats" cls="con2-chats-btn" aria-expanded={chatsOpen} onClick={() => setChatsOpen((o) => !o)} />
              <h2 className="con2-title" id="con-title">{chatTitle}</h2>
              <span className="con2-spacer" />
              <Btn label="New chat" small icon="plus" id="con-head-new" cls="con2-new-mobile" disabledReason={streaming ? "Wait for the answer or stop it." : null} onClick={newChat} />
              <label className="con2-scope small muted" htmlFor="con-scope">Project</label>
              <Select id="con-scope" aria-label="Project this chat is about" value={scope} onChange={setScope} options={[{ value: "", label: "All projects" }, ...visible.map((x) => ({ value: x.id, label: x.name }))]} />
              {modeChip}
              <Btn label="Settings" small icon="gear" id="con-open-settings" aria-expanded={aux === "settings"} aria-controls="con-settings" onClick={() => setAux(aux === "settings" ? null : "settings")} />
            </header>
            {pinned.length ? <div className="chips con2-pins" id="con-pins" aria-label="Work orders in this chat"><span className="kicker">In this chat</span>{pinned.map((id) => <EntityChip key={id} e={{ type: "wo", id }} />)}</div> : null}
            {aux === "settings" ? (
              <div className="con2-settings" id="con-settings" role="region" aria-label="Console settings">
                <div className="con2-settings-h"><b>Console settings</b><Btn label="Close" small kind="ghost" id="con-aux-close" onClick={() => setAux(null)} /></div>
                {modePicker}
                {settingsLine ? <p className="con-mode-line small muted" id="con-mode-reason"><span>{settingsLine}</span>{noModels && st?.canManageModels ? <> <a href="#models" id="con-connect-vendor" onClick={(e) => { e.preventDefault(); navigate("models"); }}>Connect a model vendor</a></> : null}</p> : null}
                <p className="small muted" id="con-access-line">The console proposes only actions your role allows; each waits for your click. Permissions are managed in <a href="#access" id="con-access-link" onClick={(e) => { e.preventDefault(); navigate("access"); }}>Access</a>.</p>
                <p className="footnote small muted">{`Questions go to the model through the Gantry edge, with tools that read only what you may see. Conversations are kept for ${st?.retentionDays ?? 90} days. Proposed actions run only after you confirm them here, under your own permissions, and are audited as made via the console.`}</p>
              </div>
            ) : null}
            <div className="chat con2-log" id="con-thread" ref={log} role="log" aria-live="polite" aria-label="Console conversation" data-keep-scroll="con-thread">
              {empty ? <Empty id="con-empty" title="Start a conversation" text="Ask about any project, work order, gate or spend. This chat reads all projects, or just one if you choose a scope above." /> : msgs.map((m) => (
                  <div className={`msg msg-${m.role}${byPerson(m) ? " me" : ""}`} key={m.id}>
                    {byPerson(m) ? <Avatar id={m.by} /> : <span className="avatar bot av-agent" title="Gantry" aria-hidden="true">G</span>}
                    <div className="bub">
                      <div className="who">{nameOf(m)}{m.at ? <time className="msg-at" dateTime={new Date(m.at).toISOString()}>{` · ${fmt.ist(m.at)}`}</time> : null}</div>
                      {m.streaming ? <div id={`con-msg-text-${m.id}`}>{m.text ? <Markdown text={m.text} /> : "Thinking…"}</div> : m.text ? <div id={`con-msg-text-${m.id}`}>{!byPerson(m) && (m.mode === "model" || m.mode === "pending") ? <Markdown text={m.text} /> : m.text}</div> : null}
                      {!byPerson(m) && m.mode !== "pending" && m.mode !== "live" && (m.mode !== "model" || m.stopped || m.note || (retryable && retryable.errId === m.id)) ? (
                        <div className="small muted msg-meta"><span className={`msg-mode is-${m.mode}`}>{modeOf(m)}</span>{m.note ? <span className="msg-note">{` · ${m.note}`}</span> : null}{retryable && retryable.errId === m.id ? <> <Btn label="Retry" small kind="ghost" icon="send" id="con-retry" onClick={retry} /></> : null}</div>
                      ) : m.streaming ? <div className="small muted msg-meta"><span className="msg-mode is-pending">Model · streaming</span></div> : null}
                      {m.cited?.length ? <div className="chips msg-chips" aria-label="Used in this answer"><span className="kicker">Based on</span>{m.cited.map((e) => <EntityChip key={`${e.type}:${e.id}`} e={e} />)}</div> : null}
                      {m.cards?.map((c, i) => c.type === "proposal" && c.proposal
                        ? <ProposalCard key={`${m.id}-${c.proposal.id}`} p={c.proposal} mid={m.id} serverId={m.serverId} />
                        : <ResultCard key={`${m.id}-${i}`} type={c.type} data={c.data} c={cardCtx(m.id)} />)}
                    </div>
                  </div>
                ))}
            </div>
            {readOnly ? <p className="con2-composer small muted" id="con-readonly-thread" role="note"><Icon name="lock" /> You can read this chat but not post in it.</p> : (
              <form className="con2-composer" id="con-form" onSubmit={(e) => { e.preventDefault(); if (!draft.trim()) { ui.toast("Type a question first", "error"); return; } void send(draft); }}>
                {slash.length ? (
                  <ul className="slash-menu" id="con-slash" role="listbox" aria-label="Commands">
                    {slash.map((x, i) => <li key={x.cmd} role="option" id={`con-slash-${i}`} className={i === idx ? "is-active" : ""} aria-selected={i === idx} onMouseDown={(e) => { e.preventDefault(); toDraft(x.cmd); }}><span className="mono">{x.cmd.trim()}</span><span className="muted">{x.hint}</span></li>)}
                  </ul>
                ) : null}
                <input id="con-input" ref={input} className="input" type="text" placeholder="Message Gantry" aria-label="Message Gantry" aria-autocomplete="list" aria-controls="con-slash" value={draft} onChange={(e) => { setDraft(e.target.value); setSlashIdx(0); }} onKeyDown={onKey} />
                {streaming ? <Btn label="Stop" kind="danger" icon="x" id="con-stop" onClick={() => ac.current?.abort()} /> : null}
                <Btn label="Send" kind="primary" type="submit" id="con-send" disabledReason={streaming ? "Wait for the answer or stop it." : null} />
              </form>
            )}
          </section>
        </div>
      </div>
    );
  }
  // Only the workspace's embedded chat reaches here (the Console page returned above); it owns its header, list and context.
  const emb = embed!;
  return (
    <div className="view-console ws-chat">
      {emb.header}
      <div className={`console-grid is-embedded`}>
        <section className={`console-main${emb.page ? " panel" : ""}`} aria-label="Conversation">
          {emb.page ? <header><h2><span className="sec" aria-hidden="true" />Conversation</h2></header> : null}
          {emb.agent ? null : <p className="con-mode-line small" id="con-mode-reason">{modeChip}<span>{modeLine}</span><span className="con-mode-pick">{modePicker}</span>{noModels && st?.canManageModels ? <a href="#models" id="con-connect-vendor" onClick={(e) => { e.preventDefault(); navigate("models"); }}>Connect a model vendor</a> : null}</p>}
          <div className="thread" id="con-thread" ref={log} role="log" aria-live="polite" aria-label="Console conversation" data-keep-scroll="con-thread">
            {msgs.map((m) => (
              <div className={`msg msg-${m.role}`} key={m.id}>
                <div className="msg-who">
                  {byPerson(m) ? <Avatar id={m.by} size="sm" /> : <span className="av av-factory av-sm" aria-hidden="true">{embed?.agent ? embed.agent.name.slice(0, 1) : "G"}</span>}
                  <span className="msg-name">{nameOf(m)}</span>
                  {m.at ? <span className="mono muted small">{fmt.ist(m.at)}</span> : null}
                </div>
                {m.streaming ? <div className={`msg-text${m.text ? "" : " is-thinking"}`} id={`con-msg-text-${m.id}`}>{m.text ? <Markdown text={m.text} /> : "Thinking…"}</div> : m.text ? <div className={`msg-text${!byPerson(m) && (m.mode === "model" || m.mode === "pending") ? " is-md" : ""}`} id={`con-msg-text-${m.id}`}>{!byPerson(m) && (m.mode === "model" || m.mode === "pending") ? <Markdown text={m.text} /> : m.text}</div> : null}
                {!byPerson(m) && m.mode !== "pending" ? (
                  <div className="msg-meta">
                    <span className={`msg-mode is-${m.mode}`}>{m.mode === "model" ? `${st?.model ?? "Model"}${m.stopped ? " · stopped" : ""}` : m.mode === "slash" ? "Slash command · live data" : m.mode === "none" ? "No model configured" : "Model did not answer"}</span>
                    {m.note ? <span className="msg-note">{m.note}</span> : null}
                    {retryable && retryable.errId === m.id ? <Btn label="Retry" small kind="ghost" icon="send" id="con-retry" onClick={retry} /> : null}
                  </div>
                ) : m.streaming ? <div className="msg-meta"><span className="msg-mode is-pending">Model · streaming</span></div> : null}
                {m.cited?.length ? <div className="chips msg-chips" aria-label="Used in this answer"><span className="kicker">Based on</span>{m.cited.map((e) => <EntityChip key={`${e.type}:${e.id}`} e={e} />)}</div> : null}
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
            <textarea id="con-input" ref={input} className="input composer-input" rows={embed?.page ? 1 : 2} placeholder={embed?.agent ? `Ask ${embed.agent.name}` : embed?.page ? "Ask the factory: \"what is blocked?\", \"status of WO-2417\"…" : "Ask or instruct. Type / for commands."} aria-label="Message the factory" aria-autocomplete="list" aria-controls="con-slash" value={draft} onChange={(e) => { setDraft(e.target.value); setSlashIdx(0); }} onKeyDown={onKey} />
            <div className="composer-foot">
              <span />
              {streaming ? (
                <div className="row gap-sm"><Btn label="Stop" kind="danger" small icon="x" id="con-stop" onClick={() => ac.current?.abort()} /><Btn label="Send" kind="primary" icon="send" type="submit" id="con-send" disabledReason="Wait for the answer or stop it." /></div>
              ) : <Btn label="Send" kind="primary" icon="send" type="submit" id="con-send" />}
            </div>
          </form>
          )}
        </section>
        {embed?.aside ?? (
        <aside className="ctx" aria-label="Console context">
          {embed?.page ? <details className="con-more"><summary>What you and the console can do here</summary>{ctxPanels}</details> : ctxPanels}
          <p className="footnote">{`Questions go to ${st?.configured ? st.model : "the configured model"} through the Gantry edge, with tools that read only what you may see. Work order, issue and repository text is passed as untrusted data. Slash commands read the same tools directly and never need a model. Conversations are kept for ${st?.retentionDays ?? 90} days. Proposed actions run only after you confirm them here, under your own permissions, and are audited as made via the console.`}</p>
        </aside>
        )}
      </div>
    </div>
  );
}

/** Recent work orders of a project, for the suggested questions only (a stuck one, a finished one). */

function useWorkOrdersLite(projectId: string | null, q: { limit: number }): Array<LiveWo & { bay: string | null }> {
  const r = useWorkOrders(projectId, q);
  const d = r.data;
  const items = Array.isArray(d) ? d : d?.items ?? [];
  return items as Array<LiveWo & { bay: string | null }>;
}
