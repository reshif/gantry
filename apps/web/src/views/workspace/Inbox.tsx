/**
 * The workspace inbox (left pane): every conversation the person can read, filtered (Needs me, Active, Mine, Shared, Archived) and grouped by
 * scope (work orders, side threads, repositories, factory chats). Typing filters the list by name; Enter searches everything (messages,
 * documents, sources, questions). Pins and archive marks are per person and set from each row's menu.
 */
import { useMemo, useState } from "react";
import { fmt } from "@gantry/domain";
import { Btn } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { filterInbox, GROUPS, patchThread, type InboxFilter, type InboxItem } from "./api";

/** The tabs; Archived is a link under the list (it is looked at rarely). */
const FILTERS: Array<{ id: InboxFilter; label: string; count: boolean }> = [
  { id: "needs", label: "Needs me", count: true },
  { id: "active", label: "Active", count: false },
  { id: "mine", label: "Mine", count: true },
  { id: "shared", label: "Shared", count: true },
];

const WAIT: Record<InboxItem["waitingOn"], string> = { you: "Waiting on you", approver: "Waiting on an approver", person: "Waiting on someone else", agent: "Agent working", nobody: "" };

export function waitText(i: InboxItem): string {
  if (i.waitingOn === "agent") return i.kind === "chat" || i.kind === "side" ? "Answering" : `${i.agentName ?? "Agent"} working`;
  if (i.wo?.closed) return "Closed";
  if (i.waitingOn === "you" && i.wo?.gate && !i.wo.bay) return `${i.wo.gate}: yours to decide`;
  return WAIT[i.waitingOn];
}

/** Where the conversation sits: the agent for chats and side threads, the full station name (and the bay when in one) for work orders. */
export function rowWhere(i: InboxItem): string {
  if (i.kind === "side" || i.kind === "chat") return i.agentName ?? "";
  if (i.wo) return i.wo.bay ? `${i.wo.stationName} · Bay ${i.wo.bay}` : i.wo.stationName;
  return i.agentName ?? "";
}

function Row({ i, current, onPick, me }: { i: InboxItem; current: boolean; onPick: (key: string) => void; me: string }) {
  const ui = useUI();
  const now = Date.now();
  const wait = waitText(i);
  const where = rowWhere(i);
  const menu = (el: HTMLElement) => ui.menu(el, null, [
    { label: i.pinned ? "Unpin" : "Pin to top", icon: "pin", onClick: () => void patchThread(i.key, { pinned: !i.pinned }).then((r) => !r.ok && ui.toast(r.msg, "error")) },
    i.archived === "auto" ? { label: "Archived because the work order closed", icon: "lock" }
      : { label: i.archived ? (i.archived === "thread" ? "Unarchive" : "Move back to the inbox") : i.owner === me ? "Archive (read-only for everyone)" : "Archive for me", icon: "down", onClick: () => void patchThread(i.key, { archived: !i.archived }).then((r) => ui.toast(r.msg, r.ok ? "ok" : "error")) },
  ]);
  return (
    <li className={`ws-row${current ? " is-current" : ""}${i.unread ? " is-unread" : ""}${i.waitingOn === "you" ? " is-mine" : ""}`}>
      <button type="button" className="ws-row-btn" id={`ws-item-${i.key.replace(/[^A-Za-z0-9_-]/g, "-")}`} aria-current={current ? "true" : undefined} onClick={() => onPick(i.key)}>
        <span className="ws-row-top">
          {i.pinned ? <Icon name="pin" /> : null}
          <span className={`ws-scope is-${i.scope.kind}`}>{i.kind === "primary" ? i.scope.id : i.kind === "onboarding" ? "Repo" : i.kind === "side" ? i.scope.label : "Chat"}</span>
          <span className="ws-row-title" title={i.title}>{i.title}</span>
          {i.unread ? <span className="wos-unread" role="img" aria-label="Unread" /> : null}
        </span>
        {where ? <span className="ws-row-where small muted" title={where}>{where}</span> : null}
        <span className="ws-row-meta small">
          {wait ? <span className={`ws-wait is-${i.waitingOn}`} title={wait}>{wait}</span> : null}
          {i.shared && (i.kind === "side" || i.kind === "chat") ? <span className="muted" title={i.visibility === "project" ? "Shared with the project" : "Shared with invited people"}><Icon name="people" /></span> : null}
          <span className="mono muted ws-row-t">{now - i.updatedAt < 86_400_000 ? fmt.ago(i.updatedAt, now) : fmt.istDate(i.updatedAt)}</span>
        </span>
      </button>
      <button type="button" className="icon-btn icon-btn-sm ws-row-more" aria-label={`Options for ${i.title}`} aria-haspopup="menu" onClick={(e) => menu(e.currentTarget)}><Icon name="dots" /></button>
    </li>
  );
}

export function Inbox({ me, items, loading, current, filter, onFilter, onPick, onNew, onSearch, operator }: {
  me: string; items: InboxItem[]; loading: boolean; current: string | null; filter: InboxFilter; onFilter: (f: InboxFilter) => void;
  onPick: (key: string) => void; onNew: () => void; onSearch: (q: string) => void; operator: { show: boolean; active: boolean; onOpen: () => void } | null;
}) {
  const [q, setQ] = useState("");
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, filterInbox(items, f.id).length])) as Record<InboxFilter, number>, [items]);
  const archived = filter === "archived";
  const shown = useMemo(() => {
    const base = filterInbox(items, filter);
    const t = q.trim().toLowerCase();
    return t ? base.filter((i) => `${i.title} ${i.scope.label} ${i.agentName ?? ""} ${i.key}`.toLowerCase().includes(t)) : base;
  }, [items, filter, q]);
  const pinned = shown.filter((i) => i.pinned);
  const rest = shown.filter((i) => !i.pinned);
  return (
    <nav className="ws-inbox" aria-label="Conversations" id="ws-inbox">
      <div className="ws-inbox-h">
        <span className="kicker">Agents at work</span>
        <Btn small kind="primary" icon="plus" label="New chat" id="ws-new" onClick={onNew} />
      </div>
      <form className="ws-search" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= 2) { onSearch(q.trim()); setQ(""); } }}>
        <Icon name="search" />
        <input type="search" className="input" id="ws-q" placeholder="Filter, or Enter to search everything" aria-label="Filter conversations; press Enter to search messages, documents and sources" value={q} onChange={(e) => setQ(e.target.value)} />
      </form>
      <div className="ws-filters" role="tablist" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="tab" id={`ws-f-${f.id}`} aria-selected={filter === f.id} className={`ws-filter${filter === f.id ? " is-active" : ""}`} onClick={() => onFilter(f.id)}>
            {f.label}{f.count && !archived ? <span className="ws-count">{counts[f.id]}</span> : null}
          </button>
        ))}
      </div>
      {operator?.show ? (
        <button type="button" className={`ws-op-link${operator.active ? " is-current" : ""}`} id="ws-operator" onClick={operator.onOpen}><Icon name="workload" /><span className="ws-op-txt"><span>Operator view</span><span className="muted small">Stuck, waiting, over budget</span></span></button>
      ) : null}
      <div className="ws-list" data-keep-scroll="ws-list">
        {loading && !items.length ? <p className="muted small ws-empty">Loading conversations…</p> : null}
        {pinned.length ? <section aria-label="Pinned"><h3 className="ws-group">Pinned</h3><ul>{pinned.map((i) => <Row key={i.key} i={i} me={me} current={i.key === current} onPick={onPick} />)}</ul></section> : null}
        {GROUPS.map((g) => {
          const rows = rest.filter((i) => g.kinds.includes(i.kind));
          return rows.length ? <section key={g.id} aria-label={g.label}><h3 className="ws-group">{g.label}<span className="ws-count">{rows.length}</span></h3><ul>{rows.map((i) => <Row key={i.key} i={i} me={me} current={i.key === current} onPick={onPick} />)}</ul></section> : null;
        })}
        {!loading && !shown.length ? (
          <p className="muted small ws-empty" id="ws-empty">
            {q.trim() ? "No conversation matches. Press Enter to search inside messages, documents and sources." : filter === "needs" ? "Nothing waits on you. When an agent asks you something or a gate needs you, it shows here." : filter === "archived" ? "Nothing archived. Closed work orders move here 14 days after they close." : "No conversations here yet."}
          </p>
        ) : null}
        <button type="button" className="linkish small ws-archived-link" id="ws-f-archived" aria-pressed={archived} onClick={() => onFilter(archived ? "active" : "archived")}>{archived ? "Back to active conversations" : "Show archived"}</button>
      </div>
    </nav>
  );
}
