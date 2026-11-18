/**
 * Console (#console): a general chat with Gantry, the console agent. Ask about any project, work order, gate or agent; answers come from live data and
 * nothing changes without a person's approval. Left: your chats (New chat first), right: the chat, its project scope and settings in the header, the
 * messages in their own scroll area and the composer pinned under them. `#console/<chatId>` is a chat, `#console/new` a new one, `#console/submit`
 * the New work order form (the Control Room prototype's Console screen).
 */
import { useCallback, useMemo, useState } from "react";
import { invalidateSlices } from "../api/keys";
import { useMe } from "../api/queries";
import { navigate, useHash } from "../lib/router";
import { useScope } from "../lib/scope";
import { Btn, Select } from "../ui/primitives";
import { Page } from "../ui/cr";
import { useUI } from "../ui/overlay-context";
import { ChatPane } from "./workspace/ChatPane";
import { patchThread, useInbox } from "./workspace/api";
import { Chats, type ChatRow } from "./console/Chats";
import { SettingsButton } from "./console/Settings";
import { clearThread, renameThread, useThread, useThreads } from "./console/api";
import ConsoleSubmitView from "./console-submit";

const SUB = "Ask Gantry anything about your factory. Answers come from live data, and nothing changes without your approval.";

export default function ConsoleRoute() {
  return useHash().param === "submit" ? <ConsoleSubmitView /> : <ConsoleChatView />;
}

function ConsoleChatView() {
  const hash = useHash();
  const me = useMe();
  const ui = useUI();
  const scope = useScope();
  const threads = useThreads();
  const inbox = useInbox(false);
  const projects = scope.projects.filter((p) => p.status !== "archived");
  const chatId = hash.param && hash.param !== "new" ? hash.param : null;
  const hasChat = !!hash.param;
  const thread = useThread(chatId);
  // The project each chat asks about, picked here; a saved chat starts from the project it was made for, a new one from the current scope.
  const [picked, setPicked] = useState<Record<string, string | null>>({});
  const key = chatId ?? "new";
  const fallback = chatId ? (thread.data?.projectId ?? null) : scope.all ? null : scope.projectId;
  const project = key in picked ? picked[key]! : fallback;
  const setScope = (v: string): void => setPicked((x) => ({ ...x, [key]: v || null }));

  const rows = useMemo<ChatRow[]>(() => {
    const byId = new Map<string, ChatRow>();
    const meId = me?.person.id ?? "";
    for (const i of inbox.data?.items ?? []) {
      if (i.kind !== "chat" || i.archived) continue;
      byId.set(i.key, { id: i.key, title: i.title, project: i.scope.kind === "project" ? i.scope.label : "", updatedAt: i.updatedAt, mine: !i.owner || i.owner === meId, sharedWithProject: i.visibility === "project", canShare: !!i.project });
    }
    for (const t of threads.data?.items ?? []) if (!byId.has(t.id)) byId.set(t.id, { id: t.id, title: t.title, project: "", updatedAt: t.updatedAt, mine: true, sharedWithProject: false, canShare: false });
    return [...byId.values()];
  }, [inbox.data, threads.data, me]);

  const open = useCallback((id: string | null) => navigate("console", id ?? "new"), []);
  const item = inbox.data?.items?.find((i) => i.key === chatId) ?? null;
  const refresh = (): void => invalidateSlices(["workspace", "console"]);
  const onThread = (id: string): void => { setPicked((x) => ({ ...x, [id]: project })); navigate("console", id); };

  if (!me) return null;
  const tools = (
    <>
      <Select id="con-scope" aria-label="Project this chat asks about" value={project ?? ""} onChange={setScope} options={[{ value: "", label: "All projects" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
      <SettingsButton project={project} />
    </>
  );
  return (
    <Page eyebrow="Operate" title="Console" sub={SUB} cls="console-chat" acts={<Btn id="con-new-wo" icon="plus" label="New work order" onClick={() => navigate("console", "submit")} />}>
      <div className={`cc-grid${hasChat ? " has-chat" : ""}`}>
        <Chats
          rows={rows} current={chatId} loading={threads.isLoading || inbox.isLoading} onPick={open} onNew={() => open(null)}
          onRename={async (id, title) => { const r = await renameThread(id, title); if (!r.ok) return r.msg; refresh(); return null; }}
          onDelete={async (id) => { await clearThread(id); if (id === chatId) open(null); refresh(); }}
          onShare={async (id, share) => { const r = await patchThread(id, { visibility: share ? "project" : "private" }); ui.toast(r.msg, r.ok ? "ok" : "error"); refresh(); }}
        />
        <main className="cc-main" aria-label="Chat">
          <Btn small cls="cc-back" id="con-back" icon="back" label="All chats" onClick={() => navigate("console")} />
          <ChatPane id={chatId} item={item} onThread={onThread} page={{ project, tools }} />
        </main>
      </div>
    </Page>
  );
}
