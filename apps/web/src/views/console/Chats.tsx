/**
 * The Console page's chat list: every chat of the signed-in person (Recent) and the ones others shared with them (Shared with me), each with its
 * title, the project it asks about (or All projects) and its last activity. New chat is the first control; the row menu renames, deletes and shares.
 */
import { useMemo, useState } from "react";
import { fmt } from "@gantry/domain";
import { Btn, IconBtn, SearchBox } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { RenameForm } from "./ChatList";

export interface ChatRow {
  id: string;
  title: string;
  /** The project name the chat asks about; empty for All projects. */
  project: string;
  updatedAt: number;
  mine: boolean;
  /** Shared with the project (the owner's chats only). */
  sharedWithProject: boolean;
  /** The owner can share it with the project it belongs to. */
  canShare: boolean;
}

export function Chats({ rows, current, loading, onPick, onNew, onRename, onDelete, onShare }: {
  rows: ChatRow[]; current: string | null; loading: boolean;
  onPick: (id: string) => void; onNew: () => void;
  onRename: (id: string, title: string) => Promise<string | null>;
  onDelete: (id: string) => Promise<void>;
  onShare: (id: string, share: boolean) => Promise<void>;
}) {
  const ui = useUI();
  const [q, setQ] = useState("");
  const now = Date.now();
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (t ? rows.filter((r) => `${r.title} ${r.project}`.toLowerCase().includes(t)) : rows).slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }, [rows, q]);
  const groups = [{ id: "recent", label: "Recent", rows: shown.filter((r) => r.mine) }, { id: "shared", label: "Shared with me", rows: shown.filter((r) => !r.mine) }];

  const rename = (r: ChatRow) => {
    let submit: () => void = () => undefined;
    const d = ui.dialog({
      title: "Rename chat", kicker: "Console",
      body: <RenameForm initial={r.title} registerSubmit={(fn) => (submit = fn)} onSave={async (title) => { const e = await onRename(r.id, title); if (!e) d.close(); return e; }} />,
      actions: [{ label: "Cancel" }, { label: "Rename", kind: "primary", submit: true, id: "con-chat-rename-ok", onClick: () => submit() }],
    });
  };
  const remove = async (r: ChatRow) => {
    const ok = await ui.confirm({ title: `Delete "${r.title}"?`, kicker: "Console", kind: "danger", ok: "Delete chat", body: <p>The conversation is removed for good. Actions you confirmed from it stay in the audit log.</p> });
    if (ok) await onDelete(r.id);
  };

  const menu = (r: ChatRow): void => {
    const anchor = document.getElementById(`con-chat-more-${r.id}`);
    if (!anchor) return;
    ui.menu(anchor, null, [
      { label: "Rename", onClick: () => rename(r) },
      ...(r.canShare ? [{ label: r.sharedWithProject ? "Make private" : "Share with the project (read-only for them)", icon: "people", onClick: () => void onShare(r.id, !r.sharedWithProject) }] : []),
      { label: "Delete", icon: "x", onClick: () => void remove(r) },
    ]);
  };

  return (
    <nav className="con-chats cc-list" aria-label="Your chats" id="con-chats">
      <Btn kind="primary" icon="plus" label="New chat" id="con-new-chat" onClick={onNew} />
      <SearchBox id="con-chats-q" value={q} onChange={setQ} placeholder="Search chats" label="Search chats by name or project" />
      {groups.map((g) => (g.rows.length || (g.id === "recent" && !q.trim()) ? (
        <section key={g.id} className="cc-group" aria-label={g.label}>
          <h2 className="kicker cc-group-h">{g.label}</h2>
          {g.rows.length ? (
            <ul className="con-chats-list">
              {g.rows.map((r) => (
                <li key={r.id} className={r.id === current ? "is-current" : undefined}>
                  <button type="button" className="con-chat" id={`con-chat-${r.id}`} aria-current={r.id === current ? "true" : undefined} onClick={() => onPick(r.id)}>
                    <span className="con-chat-title">{r.title || "Untitled chat"}</span>
                    <span className="con-chat-meta small muted">{`${r.project || "All projects"} · ${now - r.updatedAt < 86_400_000 ? fmt.ago(r.updatedAt, now) : fmt.istDate(r.updatedAt)}`}</span>
                  </button>
                  {r.mine ? (
                    <IconBtn
                      icon="dots" label={`Options for ${r.title}`} className="icon-btn-sm con-chat-more" id={`con-chat-more-${r.id}`} aria-haspopup="menu"
                      onClick={() => menu(r)}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : <p className="muted small con-chats-empty">{loading ? "Loading chats." : "No chats yet. Start one with New chat."}</p>}
        </section>
      ) : null))}
      {!shown.length && q.trim() ? <p className="muted small con-chats-empty">No chat matches.</p> : null}
    </nav>
  );
}
