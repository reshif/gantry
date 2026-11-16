/**
 * Agents at work (#workspace): one place for every conversation with agents (agent workspace, Phase 4). The inbox on the left lists the work
 * orders' threads, side threads with a chosen agent, repositories' onboarding threads and factory chats; the centre shows the one picked, with its
 * own context pane. `#workspace/<key>`: `wo:<id>`, `repo:<id>`, a chat id, `new` (a new factory chat) or `operator`.
 * The older Conversations (#conversations/<WO>) and Console (#console) links land here.
 */
import { useEffect, useMemo, useState } from "react";
import { useMe } from "../api/queries";
import { anyRole, BUILD_READ } from "../lib/routes";
import { navigate, useHash } from "../lib/router";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Btn, Empty } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { WoSessionPage } from "./conversations/Session";
import { SessionPage } from "./onboarding/Session";
import { ChatPane, toWorkspace } from "./workspace/ChatPane";
import { Inbox } from "./workspace/Inbox";
import { NewChatForm } from "./workspace/NewChat";
import { OperatorPanel } from "./workspace/Operator";
import { SearchResults } from "./workspace/Search";
import { createThread, filterInbox, useInbox, type InboxFilter } from "./workspace/api";

export default function WorkspaceView() {
  const hash = useHash();
  const me = useMe();
  const ui = useUI();
  const prefs = usePrefs();
  // Older links: #conversations/<WO> and #console[/<chat>] open here.
  useEffect(() => {
    if (hash.id === "conversations") toWorkspace(hash.param ? `wo:${hash.param}` : null);
    else if (hash.id === "console") toWorkspace(hash.param ?? "new");
  }, [hash.id, hash.param]);
  const pending = prefs.openConversation;
  useEffect(() => {
    if (!pending) return;
    updatePrefs({ openConversation: null });
    navigate("workspace", `wo:${pending}`);
  }, [pending]);

  const key = hash.id === "workspace" ? hash.param : null;
  const [filter, setFilter] = useState<InboxFilter | null>(null);
  const [q, setQ] = useState<string | null>(null);
  const all = useInbox(false);
  const archived = useInbox(filter === "archived");
  const items = useMemo(() => (filter === "archived" ? archived.data?.items : all.data?.items) ?? [], [filter, all.data, archived.data]);
  const needs = useMemo(() => filterInbox(all.data?.items ?? [], "needs").length, [all.data]);
  const cur: InboxFilter = filter ?? (needs ? "needs" : "active");
  const item = items.find((i) => i.key === key) ?? all.data?.items.find((i) => i.key === key) ?? null;
  const operator = !!me && anyRole(me, BUILD_READ);

  const open = (k: string | null) => { setQ(null); navigate("workspace", k); };
  const newChat = () => {
    let submit: () => void = () => undefined;
    const d = ui.dialog({
      title: "New chat", kicker: "Agents at work",
      body: <NewChatForm wos={all.data?.items ?? []} initialWo={key?.startsWith("wo:") ? key.slice(3) : null} registerSubmit={(fn) => (submit = fn)} onSave={async (c) => {
        // A factory chat with the Console starts with its first message (no empty chats are saved).
        if (c.scope.kind === "factory") { d.close(); open("new"); return null; }
        const r = await createThread({ scope: c.scope, agent: c.agent, visibility: c.visibility });
        if (!r.ok) return r.msg;
        d.close();
        open(r.id);
        return null;
      }} />,
      actions: [{ label: "Cancel" }, { label: "Start", kind: "primary", submit: true, id: "ws-new-ok", onClick: () => submit() }],
    });
  };

  if (!me) return <div className="view ws-view" />;
  const main = q ? <SearchResults q={q} onOpen={(k) => open(k)} onClose={() => setQ(null)} />
    : key === "operator" ? <OperatorPanel onOpen={(k) => open(k)} />
    : key?.startsWith("wo:") ? <WoSessionPage key={key} woId={key.slice(3)} back={() => open(null)} embedded />
    : key?.startsWith("repo:") && (item?.project ?? prefs.project) ? <SessionPage key={key} projectId={(item?.project ?? prefs.project)!} repoId={key.slice(5)} back={() => open(null)} details={() => navigate("onboarding", key.slice(5), item?.project ?? null)} />
    : key === "new" || key?.startsWith("ct-") ? <ChatPane id={key === "new" ? null : key} item={item} onThread={(id) => navigate("workspace", id)} />
    : (
      <div className="ws-home">
        <Empty id="ws-home" icon="chat" title={needs ? `${needs} conversation${needs === 1 ? "" : "s"} need you` : "Pick a conversation"}
          text="Every work order has one primary thread with its station agents. Start a side thread to ask a work order's Researcher or Spec writer about what it did, or a chat with the Console about the whole factory. Search covers messages, documents, sources and questions."
          action={<div className="ws-home-actions"><Btn kind="primary" icon="plus" label="New chat" id="ws-home-new" onClick={newChat} />{operator ? <Btn label="Operator view" id="ws-home-op" onClick={() => open("operator")} /> : null}</div>} />
      </div>
    );
  return (
    <div className="view ws-view">
      <div className="ws-grid">
        <Inbox me={me.person.id} items={items} loading={filter === "archived" ? archived.isLoading : all.isLoading} current={key} filter={cur} onFilter={setFilter} onPick={(k) => open(k)} onNew={newChat} onSearch={(s) => setQ(s)}
          operator={operator ? { show: true, active: key === "operator", onOpen: () => open("operator") } : null} />
        <main className="ws-main" aria-label="Conversation">{main}</main>
      </div>
    </div>
  );
}
