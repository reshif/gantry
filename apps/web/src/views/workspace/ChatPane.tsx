/**
 * A chat in the workspace: the Console's conversation (views/console.tsx, embedded) with the workspace's header: the title, what it is about,
 * who answers, who can read it, and the thread actions (rename, share with the project, invite, export, archive). A side thread (a chat about a
 * work order, repository or project, or with a chosen agent) replaces the Console's context panel with what the thread is about and its people.
 */
import { useRef, useState } from "react";
import { fmt } from "@gantry/domain";
import { useMe, usePeople } from "../../api/queries";
import { Btn, Chip, Field, Panel, Select, Who } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { navigate, formatHash, replaceHash } from "../../lib/router";
import { useOpenTraveler } from "../../shell/useTraveler";
import ConsoleView from "../console";
import { useThread } from "../console/api";
import { exportUrl, invite, patchThread, removeMember, type InboxItem } from "./api";
import { takeAsk } from "./mention";

function RenameForm({ initial, registerSubmit, onSave }: { initial: string; registerSubmit: (fn: () => void) => void; onSave: (t: string) => Promise<string | null> }) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState("");
  registerSubmit(() => { const t = v.trim(); if (!t) return setErr("Give the conversation a name."); void onSave(t).then((e) => setErr(e ?? "")); });
  return <div className="form-grid"><Field label="Name" htmlFor="ws-chat-name"><input id="ws-chat-name" className="input" value={v} maxLength={120} autoFocus onChange={(e) => setV(e.target.value)} /></Field><div className="form-err" role="alert">{err}</div></div>;
}

function InviteForm({ exclude, registerSubmit, onSave }: { exclude: string[]; registerSubmit: (fn: () => void) => void; onSave: (p: string) => Promise<string | null> }) {
  const people = usePeople();
  const opts = (people.data ?? []).filter((p) => !exclude.includes(p.id)).map((p) => ({ value: p.id, label: p.name }));
  const [v, setV] = useState("");
  const [err, setErr] = useState("");
  registerSubmit(() => { const id = v.trim(); if (!id) return setErr("Choose a person."); void onSave(id).then((e) => setErr(e ?? "")); });
  return (
    <div className="form-grid">
      {people.data ? (
        <Field label="Person" htmlFor="ws-invite-who" hint="They can read and post here. Someone who cannot see the project cannot be invited."><Select id="ws-invite-who" value={v} onChange={setV} options={[{ value: "", label: "Choose…" }, ...opts]} /></Field>
      ) : (
        <Field label="Person id" htmlFor="ws-invite-who" hint="For example p-meera. They can read and post here."><input id="ws-invite-who" className="input" value={v} onChange={(e) => setV(e.target.value)} /></Field>
      )}
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

export function ChatPane({ id, item, onThread }: { id: string | null; item: InboxItem | null; onThread: (id: string) => void }) {
  const me = useMe();
  const ui = useUI();
  const actor = useActors();
  const openTraveler = useOpenTraveler();
  const t = useThread(id).data;
  const meId = me?.person.id ?? "";
  // A question an @mention queued for this thread (taken once per thread).
  const initials = useRef<Record<string, string | null>>({});
  if (id && !(id in initials.current)) initials.current[id] = takeAsk(id);
  if (!me) return null;
  const side = !!t && ((t.scope?.kind ?? "factory") !== "factory" || !!t.agentId);
  const owner = !!t && t.owner === meId;
  const agentName = t?.agentId ? (item?.agentName ?? actor(t.agentId).name.replace(" (agent)", "")) : side ? "Gantry assistant" : null;
  const about = t?.scope?.kind === "work_order" ? `work order ${t.scope.id}` : t?.scope?.kind === "repo" ? `repository ${item?.scope.label ?? t.scope.id}` : t?.scope?.kind === "project" ? `project ${item?.scope.label ?? t.scope.id}` : "the factory";
  const readOnly = !t || !t.can ? null : t.status === "archived" ? `Archived${t.archivedBy ? ` by ${actor(t.archivedBy).name}` : ""}${t.archivedAt ? ` on ${fmt.istDate(t.archivedAt)}` : ""}: read-only.${owner ? " Unarchive it to continue." : ""}` : !t.can.post ? "Read-only: this conversation was shared with the project. Its owner can invite you to post." : null;

  const rename = () => {
    if (!t) return;
    let submit: () => void = () => undefined;
    const d = ui.dialog({ title: "Rename conversation", body: <RenameForm initial={t.title} registerSubmit={(fn) => (submit = fn)} onSave={async (title) => { const r = await patchThread(t.id, { title }); if (r.ok) d.close(); return r.ok ? null : r.msg; }} />, actions: [{ label: "Cancel" }, { label: "Rename", kind: "primary", submit: true, id: "ws-rename-ok", onClick: () => submit() }] });
  };
  const addPerson = () => {
    if (!t) return;
    let submit: () => void = () => undefined;
    const d = ui.dialog({ title: "Invite to this conversation", body: <InviteForm exclude={[t.owner ?? "", ...(t.members ?? [])]} registerSubmit={(fn) => (submit = fn)} onSave={async (p) => { const r = await invite(t.id, p); if (r.ok) { d.close(); ui.toast(r.msg, "ok"); } return r.ok ? null : r.msg; }} />, actions: [{ label: "Cancel" }, { label: "Invite", kind: "primary", submit: true, id: "ws-invite-ok", onClick: () => submit() }] });
  };
  const act = async (b: Parameters<typeof patchThread>[1]) => { const r = await patchThread(t!.id, b); ui.toast(r.msg, r.ok ? "ok" : "error"); };
  const more = (el: HTMLElement) => ui.menu(el, null, [
    ...(owner ? [{ label: "Rename", onClick: rename }] : []),
    ...(owner && t?.projectId ? [{ label: t.visibility === "project" ? "Make private (you and invited people)" : "Share with the project (read-only for them)", icon: "people", onClick: () => void act({ visibility: t.visibility === "project" ? "private" : "project" }) }] : []),
    ...(owner ? [{ label: "Invite a person", icon: "user", onClick: addPerson }] : []),
    { label: "Export as markdown", icon: "page", onClick: () => window.open(exportUrl(t!.id, "md"), "_blank", "noopener") },
    { label: "Export as JSON", icon: "page", onClick: () => window.open(exportUrl(t!.id, "json"), "_blank", "noopener") },
    { sep: true },
    owner
      ? { label: t?.status === "archived" ? "Unarchive" : "Archive (read-only for everyone)", icon: "down", onClick: () => void act({ archived: t?.status !== "archived" }) }
      : { label: item?.archived === "me" ? "Move back to the inbox" : "Archive for me", icon: "down", onClick: () => void act({ archived: item?.archived !== "me" }) },
    ...(!owner && t?.members?.includes(meId) ? [{ label: "Leave this conversation", icon: "x", onClick: () => void removeMember(t.id, meId).then((r) => ui.toast(r.msg, r.ok ? "ok" : "error")) }] : []),
  ]);

  const header = (
    <header className="ws-chat-h" id="ws-chat-h">
      <h2 className="ws-chat-title">{t?.title || (id ? "Conversation" : "New chat")}</h2>
      {t && side && !(t.title ?? "").includes(String(t.scope?.kind === "work_order" ? t.scope.id : item?.scope.label ?? t.scope?.id ?? "")) ? <Chip text={t.scope?.kind === "work_order" ? t.scope.id : item?.scope.label ?? t.scope?.id ?? ""} cls="chip-mono" /> : null}
      {agentName ? <Chip text={agentName} cls="chip-accent" /> : !id ? <Chip text="Console" /> : null}
      {t ? <span className="ws-vis small muted" id="ws-vis"><Icon name={t.visibility === "project" ? "people" : "lock"} />{t.visibility === "project" ? "Project can read" : (t.members?.length ?? 0) > 0 ? `You and ${t.members!.length} invited` : "Private"}</span> : null}
      {t?.status === "archived" ? <Chip text="Archived" /> : null}
      {item?.spendUsd ? <span className="mono small muted" title="What this conversation's answers cost">{`$${item.spendUsd.toFixed(2)}`}</span> : null}
      <span className="osx-spacer" />
      {t?.scope?.kind === "work_order" && t.scope.id ? <Btn small id="ws-chat-wo" label={`${t.scope.id} thread`} onClick={() => navigate("workspace", `wo:${t.scope!.id}`)} /> : null}
      {t ? <button type="button" className="icon-btn" id="ws-chat-more" aria-label="Conversation options" aria-haspopup="menu" onClick={(e) => more(e.currentTarget)}><Icon name="dots" /></button> : null}
    </header>
  );

  const aside = side && t ? (
    <aside className="ctx ws-ctx" aria-label="About this thread">
      <Panel title="About">
        <p className="small">{agentName ? `${agentName} answers here about ${about}, from what the work has produced and with read tools that run under your permissions.` : `A conversation about ${about}.`}</p>
        <p className="small muted">A side thread changes nothing: answers to the station, corrections and send-backs belong in the primary thread, where the station agent writes a new version.</p>
        {t.scope?.kind === "work_order" && t.scope.id ? <div className="ws-home-actions"><Btn small id="ws-ctx-open-wo" label="Primary thread" onClick={() => navigate("workspace", `wo:${t.scope!.id}`)} /><Btn small id="ws-ctx-traveler" label="Traveler" onClick={() => openTraveler(t.scope!.id!)} /></div> : null}
      </Panel>
      <Panel title="People" tools={owner ? <Btn small icon="plus" label="Invite" id="ws-ctx-invite" onClick={addPerson} /> : null}>
        <ul className="ws-people">
          <li><Who id={t.owner} /><span className="muted small">started it</span></li>
          {(t.members ?? []).map((p) => <li key={p}><Who id={p} /><span className="muted small">invited</span>{owner ? <button type="button" className="icon-btn icon-btn-sm" id={`ws-rm-${p}`} aria-label={`Remove ${actor(p).name}`} onClick={() => void removeMember(t.id, p).then((r) => ui.toast(r.msg, r.ok ? "ok" : "error"))}><Icon name="x" /></button> : null}</li>)}
        </ul>
        <p className="small muted">{t.visibility === "project" ? "Everyone who can see the project can read it; only the people above post." : "Only the people above can read it."}</p>
      </Panel>
    </aside>
  ) : undefined;

  return (
    <ConsoleView embed={{ threadId: id, onThread, header, ...(aside ? { aside } : {}), readOnly, agent: side ? { name: agentName ?? "Gantry assistant", about } : null, initial: id ? initials.current[id] ?? null : null }} />
  );
}

/** Moves an old link onto the workspace without leaving a dead back-button step. */
export const toWorkspace = (key: string | null): void => replaceHash(formatHash("workspace", key));
