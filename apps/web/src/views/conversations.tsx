/**
 * Conversations (#conversations): the LIST of work-order sessions for the current project (who is waiting on whom, the latest message, the station) and, with a work order
 * in the route (`#/p/<project>/conversations/<WO>`), that work order's agent conversation (views/conversations/Session.tsx). The list has no forms: every row opens a session.
 * Older links that ask for a conversation through the `openConversation` preference land on the session too.
 */
import { useEffect, useMemo, useState } from "react";
import { fmt } from "@gantry/domain";
import { useCan } from "../api/can";
import { useMe, useProject } from "../api/queries";
import { pickProject } from "../lib/routes";
import { navigate, useHash } from "../lib/router";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Avatar, Btn, SearchBox, Tabs } from "../ui/primitives";
import { CrEmpty, Page } from "../ui/cr";
import { Async } from "../ui/async";
import { EmptyState, useCatalog } from "./projects/kit";
import { WoSessionPage } from "./conversations/Session";
import { useWoSessions, type WoSessionRow } from "./conversations/session-api";
import { projectSubmitBlock, useNewWorkOrder } from "./work-orders/New";
import { useProjectRepos } from "./floor/kit";

type Tab = "waiting" | "open" | "closed";

const WAIT: Record<WoSessionRow["waitingOn"], string> = { you: "Waiting on you", approver: "Waiting on an approver", person: "Waiting on someone else", agent: "Agent working", nobody: "Closed" };

export default function ConversationsView() {
  const hash = useHash();
  const me = useMe();
  const prefs = usePrefs();
  const cat = useCatalog();
  const projectId = me ? pickProject(me, prefs.project) : null;
  const projectQ = useProject(projectId);
  const project = projectQ.data ?? null;
  const submit = useCan("wo.submit", projectId ? { project: projectId } : {});
  const repos = useProjectRepos(projectId);
  const newWoDialog = useNewWorkOrder();
  const q = useWoSessions(projectId ?? undefined);
  const [tab, setTab] = useState<Tab | null>(null);
  const [search, setSearch] = useState("");
  // A deep link from an older screen (the work orders table, the bell, the record) asks for one conversation: land on its session.
  const pending = prefs.openConversation;
  useEffect(() => {
    if (!pending) return;
    updatePrefs({ openConversation: null });
    navigate("conversations", pending);
  }, [pending]);
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const groups = useMemo(() => {
    const byLatest = (a: WoSessionRow, b: WoSessionRow) => (b.latest?.at ?? b.createdAt) - (a.latest?.at ?? a.createdAt);
    return {
      waiting: items.filter((w) => !w.closed && w.waitingOn === "you").sort(byLatest),
      open: items.filter((w) => !w.closed).sort(byLatest),
      closed: items.filter((w) => w.closed).sort(byLatest),
    };
  }, [items]);
  if (!me || !cat) return <div className="view conv-view" />;
  if (!projectId) return <div className="view"><EmptyState title="No project" text="You do not have a project to show." /></div>;
  if (!project) return <div className="view"><Async query={projectQ} what="this project" id="conv-project">{() => null}</Async></div>;
  const cur: Tab = tab ?? "open";
  const list = groups[cur];
  const block = projectSubmitBlock(me, project, repos);
  const needle = search.trim().toLowerCase();
  const shown = list.filter((w) => !needle || `${w.title} ${w.id} ${w.agentName ?? ""}`.toLowerCase().includes(needle));
  // As in the prototype, the first conversation is open on a wide screen until one is picked.
  const wide = typeof window !== "undefined" && window.innerWidth > 720;
  const cur2 = hash.param ?? (wide ? (shown[0]?.id ?? null) : null);
  return (
    <Page
      eyebrow="Operate" title="Conversations" cls="conv-view"
      sub="Talk to the agent on a work order. Answers are recorded on the record."
      acts={<Btn label="New work order" kind="primary" icon="plus" id="conv-new" guard={submit.pending ? null : submit} disabledReason={submit.allowed ? block : null} onClick={() => newWoDialog({ project: project.id })} />}
    >
      <div className={`conv${cur2 ? " has" : ""}`}>
        <div className="card conv-list" hidden={false}>
          <div className="card-b" style={{ padding: 8 }}>
            <SearchBox id="conv-q" value={search} onChange={setSearch} placeholder="Search conversations" />
            <div style={{ marginTop: 8 }}>
              <Tabs idPrefix="conv-tab" items={[{ id: "waiting", label: "Waiting on me", count: groups.waiting.length }, { id: "open", label: "Open", count: groups.open.length }, { id: "closed", label: "Closed", count: groups.closed.length }]} active={cur} onChange={(t) => setTab(t as Tab)} />
            </div>
          </div>
          <div className="card-b flush" data-keep-scroll="conv-list">
            <Async query={q} what="conversations" id="conv-list">{() => shown.length ? (
              <>
                {shown.map((w) => (
                  <a key={w.id} className="li click" id={`conv-item-${w.id}`} href={`#/p/${project.id}/conversations/${w.id}`} aria-label={`${w.id} ${w.title}`} style={{ color: "inherit", textDecoration: "none", ...(cur2 === w.id ? { background: "var(--surface-2)" } : {}) }}>
                    <Avatar id={w.agent} />
                    <div className="main1">
                      <span className="t1">{w.title}</span>
                      <span className="t2">{`${w.agentName ?? "Agent"} · ${w.id} · ${fmt.ago(w.latest?.at ?? w.createdAt, Date.now())}`}</span>
                      <span className="t2">{w.waitingOn === "agent" && w.agentName ? `${w.agentName} working` : WAIT[w.waitingOn]}</span>
                    </div>
                    {w.unread ? <span className="badge hot" role="img" aria-label="Unread">1</span> : null}
                  </a>
                ))}
              </>
            ) : (
              <EmptyState id="conv-empty" icon="chat" title={cur === "waiting" ? "Nothing waits on you" : cur === "open" ? "No open conversations" : "Nothing closed yet"} text={cur === "waiting" ? "When an agent asks you something or proposes a brief, the conversation shows here." : "Submit a work order to start a conversation with its Intake agent."} />
            )}</Async>
          </div>
        </div>
        {cur2 ? (
          <div className="card conv-thread"><div className="card-b"><WoSessionPage key={cur2} woId={cur2} back={() => navigate("conversations", null)} embedded /></div></div>
        ) : (
          <div className="card"><CrEmpty icon="chat" title="Pick a conversation" text="Choose one on the left to read or reply." /></div>
        )}
      </div>
    </Page>
  );
}
