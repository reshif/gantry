/**
 * The Console's chat list (agent workspace, Phase 0): every saved conversation of the signed-in person, newest first, with
 * New chat, search by name, rename and delete. Chats are the person's own; the server keeps them for the retention period.
 */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { Btn, Field } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import type { ThreadSummary } from "./types";

function RenameForm({ initial, onSave, registerSubmit }: { initial: string; onSave: (t: string) => Promise<string | null>; registerSubmit: (fn: () => void) => void }) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState("");
  registerSubmit(() => {
    const t = v.trim();
    if (!t) return setErr("Give the chat a name.");
    void onSave(t).then((e) => setErr(e ?? ""));
  });
  return (
    <div className="form-grid">
      <Field label="Name" htmlFor="con-chat-name">
        <input id="con-chat-name" className="input" value={v} maxLength={120} autoFocus onChange={(e) => setV(e.target.value)} />
      </Field>
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

export function ChatList({ items, current, busy, onPick, onNew, onRename, onDelete }: {
  items: ThreadSummary[];
  current: string | null;
  busy: boolean;
  onPick: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => Promise<string | null>;
  onDelete: (id: string) => Promise<void>;
}) {
  const ui = useUI();
  const [q, setQ] = useState("");
  const shown = q.trim() ? items.filter((t) => t.title.toLowerCase().includes(q.trim().toLowerCase())) : items;
  const now = Date.now();

  const rename = (t: ThreadSummary) => {
    let submit: () => void = () => undefined;
    const d = ui.dialog({
      title: "Rename chat", kicker: "Console",
      body: <RenameForm initial={t.title} registerSubmit={(fn) => (submit = fn)} onSave={async (title) => { const e = await onRename(t.id, title); if (!e) d.close(); return e; }} />,
      actions: [{ label: "Cancel" }, { label: "Rename", kind: "primary", submit: true, id: "con-chat-rename-ok", onClick: () => submit() }],
    });
  };
  const remove = async (t: ThreadSummary) => {
    const ok = await ui.confirm({ title: `Delete "${t.title}"?`, kicker: "Console", kind: "danger", ok: "Delete chat", body: <p>The conversation and its pinned work orders are removed for good. Actions you confirmed from it stay in the audit log.</p> });
    if (ok) await onDelete(t.id);
  };

  return (
    <nav className="con-chats" aria-label="Your chats" id="con-chats">
      <div className="con-chats-h">
        <span className="kicker">Chats</span>
        <Btn small icon="plus" label="New chat" id="con-new-chat" disabled={busy} onClick={onNew} />
      </div>
      {items.length > 4 ? <input type="search" className="input con-chats-q" id="con-chats-q" placeholder="Search chats" aria-label="Search chats by name" value={q} onChange={(e) => setQ(e.target.value)} /> : null}
      {shown.length ? (
        <ul className="con-chats-list">
          {shown.map((t) => (
            <li key={t.id} className={t.id === current ? "is-current" : undefined}>
              <button type="button" className="con-chat" id={`con-chat-${t.id}`} aria-current={t.id === current ? "true" : undefined} disabled={busy && t.id !== current} onClick={() => onPick(t.id)}>
                <span className="con-chat-title">{t.title || "Untitled chat"}</span>
                <span className="con-chat-meta small muted">{`${t.count ?? 0} message${t.count === 1 ? "" : "s"} · ${now - t.updatedAt < 86_400_000 ? fmt.ago(t.updatedAt, now) : fmt.istDate(t.updatedAt)}`}</span>
              </button>
              <button
                type="button" className="icon-btn icon-btn-sm con-chat-more" id={`con-chat-more-${t.id}`} aria-label={`Options for ${t.title}`} aria-haspopup="menu"
                onClick={(e) => ui.menu(e.currentTarget, null, [{ label: "Rename", onClick: () => rename(t) }, { label: "Delete", icon: "x", onClick: () => void remove(t) }])}
              >
                <Icon name="dots" />
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="muted small con-chats-empty">{items.length ? "No chat matches." : "No saved chats yet. Ask something to start one."}</p>}
    </nav>
  );
}
