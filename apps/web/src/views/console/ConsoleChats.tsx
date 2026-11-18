/**
 * The Console's chat list (Blueprint page): a general chat app's left pane. A prominent New chat button, search, a Recent group (the person's own
 * chats) and a Shared with me group, each row with its title, project scope (or All projects) and last activity. Rename, delete, share with the
 * project and invite people live in the row's menu. The rows are links to #console/<chat>, so a chat restores from its URL.
 */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { Btn, Field } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { InviteForm } from "../workspace/InviteForm";
import { invite, patchThread } from "../workspace/api";

export interface ChatRow {
  id: string;
  title: string;
  updatedAt: number;
  count?: number;
  /** The project this chat is about; "All projects" for a general chat. Absent while it is not known yet. */
  scope?: string;
  mine: boolean;
  /** Only an owner of a project-scoped chat can share it with the project. */
  visibility?: "private" | "project" | null;
  canShare: boolean;
}

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

export function ConsoleChats({ rows, current, busy, onPick, onNew, onRename, onDelete, onChanged }: {
  rows: ChatRow[];
  current: string | null;
  busy: boolean;
  onPick: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => Promise<string | null>;
  onDelete: (id: string) => Promise<void>;
  /** A share or invite changed a chat: refresh the lists. */
  onChanged: () => void;
}) {
  const ui = useUI();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle ? rows.filter((t) => `${t.title} ${t.scope ?? ""}`.toLowerCase().includes(needle)) : rows;
  const recent = shown.filter((t) => t.mine);
  const shared = shown.filter((t) => !t.mine);
  const now = Date.now();

  const rename = (t: ChatRow) => {
    let submit: () => void = () => undefined;
    const d = ui.dialog({
      title: "Rename chat", kicker: "Console",
      body: <RenameForm initial={t.title} registerSubmit={(fn) => (submit = fn)} onSave={async (title) => { const e = await onRename(t.id, title); if (!e) d.close(); return e; }} />,
      actions: [{ label: "Cancel" }, { label: "Rename", kind: "primary", submit: true, id: "con-chat-rename-ok", onClick: () => submit() }],
    });
  };
  const remove = async (t: ChatRow) => {
    const ok = await ui.confirm({ title: `Delete "${t.title}"?`, kicker: "Console", kind: "danger", ok: "Delete chat", body: <p>The conversation and its pinned work orders are removed for good. Actions you confirmed from it stay in the audit log.</p> });
    if (ok) await onDelete(t.id);
  };
  const share = async (t: ChatRow) => {
    const r = await patchThread(t.id, { visibility: t.visibility === "project" ? "private" : "project" });
    ui.toast(r.msg, r.ok ? "ok" : "error");
    onChanged();
  };
  const addPerson = (t: ChatRow) => {
    let submit: () => void = () => undefined;
    const d = ui.dialog({
      title: "Invite to this chat", kicker: "Console",
      body: <InviteForm exclude={[]} registerSubmit={(fn) => (submit = fn)} onSave={async (p) => { const r = await invite(t.id, p); if (r.ok) { d.close(); onChanged(); ui.toast(r.msg, "ok"); return null; } return r.msg; }} />,
      actions: [{ label: "Cancel" }, { label: "Invite", kind: "primary", submit: true, id: "con-chat-invite-ok", onClick: () => submit() }],
    });
  };

  const row = (t: ChatRow) => (
    <li key={t.id} className={t.id === current ? "is-current" : undefined}>
      <a className="con2-chat" id={`con-chat-${t.id}`} href={`#console/${encodeURIComponent(t.id)}`} aria-current={t.id === current ? "true" : undefined} aria-disabled={busy && t.id !== current ? "true" : undefined}
        onClick={(e) => { e.preventDefault(); if (busy && t.id !== current) return; onPick(t.id); }}>
        <span className="con2-chat-title">{t.title || "Untitled chat"}</span>
        <span className="con2-chat-meta small muted">{[t.scope, t.updatedAt ? (now - t.updatedAt < 86_400_000 ? fmt.ago(t.updatedAt, now) : fmt.istDate(t.updatedAt)) : null].filter(Boolean).join(" · ")}</span>
      </a>
      {t.mine ? (
        <button
          type="button" className="icon-btn icon-btn-sm con2-chat-more" id={`con-chat-more-${t.id}`} aria-label={`Options for ${t.title}`} aria-haspopup="menu"
          onClick={(e) => ui.menu(e.currentTarget, null, [
            { label: "Rename", onClick: () => rename(t) },
            ...(t.canShare ? [{ label: t.visibility === "project" ? "Make private" : "Share with the project (read-only for them)", icon: "people", onClick: () => void share(t) }, { label: "Invite a person", icon: "user", onClick: () => addPerson(t) }] : []),
            { label: "Delete", icon: "x", onClick: () => void remove(t) },
          ])}
        >
          <Icon name="dots" />
        </button>
      ) : null}
    </li>
  );

  return (
    <nav className="con2-list" aria-label="Your chats" id="con-chats">
      <Btn kind="primary" icon="plus" label="New chat" id="con-new-chat" cls="con2-new" disabledReason={busy ? "Wait for the answer or stop it." : null} onClick={onNew} />
      <input type="search" className="input con2-q" id="con-chats-q" placeholder="Search chats" aria-label="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="con2-scroll">
        {recent.length ? <><h3 className="kicker con2-group">Recent</h3><ul className="con2-rows">{recent.map(row)}</ul></> : null}
        {shared.length ? <><h3 className="kicker con2-group">Shared with me</h3><ul className="con2-rows">{shared.map(row)}</ul></> : null}
        {!shown.length ? <p className="muted small con2-empty">{rows.length ? "No chat matches." : "No chats yet. Start one with New chat."}</p> : null}
      </div>
    </nav>
  );
}
