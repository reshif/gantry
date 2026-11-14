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
import { Btn, Tabs, ViewHead } from "../ui/primitives";
import { ClassChip, EmptyState, classOf, useCatalog } from "./projects/kit";
import { WoSessionPage } from "./conversations/Session";
import { useWoSessions, type WoSessionRow } from "./conversations/session-api";
import { projectSubmitBlock, useNewWorkOrder } from "./work-orders/New";
import { useProjectRepos } from "./floor/kit";

type Tab = "waiting" | "open" | "closed";

const WAIT: Record<WoSessionRow["waitingOn"], string> = { you: "Waiting on you", approver: "Waiting on an approver", agent: "Agent working", nobody: "Closed" };

export default function ConversationsView() {
  const hash = useHash();
  const me = useMe();
  const prefs = usePrefs();
  const cat = useCatalog();
  const projectId = me ? pickProject(me, prefs.project) : null;
  const project = useProject(projectId).data ?? null;
  const submit = useCan("wo.submit", projectId ? { project: projectId } : {});
  const repos = useProjectRepos(projectId);
  const newWoDialog = useNewWorkOrder();
  const q = useWoSessions(projectId ?? undefined);
  const [tab, setTab] = useState<Tab | null>(null);
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
  if (hash.param) return <div className="view conv-view"><WoSessionPage woId={hash.param} back={() => navigate("conversations", null)} /></div>;
  if (!me || !cat) return <div className="view conv-view" />;
  if (!projectId || !project) return <div className="view"><EmptyState title="No project" text="You do not have a project to show." /></div>;
  const cur: Tab = tab ?? (groups.waiting.length ? "waiting" : "open");
  const list = groups[cur];
  const block = projectSubmitBlock(me, project, repos);
  const unread = items.filter((w) => w.unread).length;
  return (
    <div className="view conv-view">
      <ViewHead
        kicker={`Project · ${project.name}`}
        title="Conversations"
        sub="One conversation per work order, for its whole life, with the agent at its current station. Open one to talk to the agent, review its proposals and see what happened."
        meta={[["Waiting on me", String(groups.waiting.length)], ["Open", String(groups.open.length)], ["Unread", String(unread)]]}
        actions={<Btn label="New work order" kind="primary" icon="plus" id="conv-new" guard={submit.pending ? null : submit} disabledReason={submit.allowed ? block : null} onClick={() => newWoDialog({ project: project.id })} />}
      />
      <Tabs idPrefix="conv-tab" items={[{ id: "waiting", label: "Waiting on me", count: groups.waiting.length }, { id: "open", label: "Open", count: groups.open.length }, { id: "closed", label: "Closed", count: groups.closed.length }]} active={cur} onChange={(t) => setTab(t as Tab)} />
      {list.length ? (
        <ul className="wos-list-rows" aria-label="Work-order conversations" data-keep-scroll="conv-list">
          {list.map((w) => (
            <li key={w.id}>
              <button type="button" className={`wos-row${w.unread ? " is-unread" : ""}${w.waitingOn === "you" ? " is-mine" : ""}`} id={`conv-item-${w.id}`} onClick={() => navigate("conversations", w.id)}>
                <span className="wos-row-top">
                  <span className="mono strong">{w.id}</span>
                  <ClassChip cls={classOf(cat, project, w.cls)} small />
                  <span className="chip">{w.bay ? `Bay · ${w.bay}` : w.stationName}</span>
                  <span className={`chip wos-wait is-${w.waitingOn}`}>{w.waitingOn === "agent" && w.agentName ? `${w.agentName} working` : WAIT[w.waitingOn]}</span>
                  {w.unread ? <span className="wos-unread" role="img" aria-label="Unread" /> : null}
                  <span className="mono muted small wos-row-t">{fmt.ago(w.latest?.at ?? w.createdAt, Date.now())}</span>
                </span>
                <span className="wos-row-title">{w.title}</span>
                <span className="wos-row-last small muted">{w.latest ? `${w.latest.role === "user" ? "You or a teammate" : w.latest.role === "assistant" ? (w.agentName ?? "Agent") : "Gantry"}: ${w.latest.text.replace(/\s+/g, " ").slice(0, 140)}` : w.started ? "" : "The conversation has not started yet."}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState id="conv-empty" icon="chat" title={cur === "waiting" ? "Nothing waits on you" : cur === "open" ? "No open conversations" : "Nothing closed yet"} text={cur === "waiting" ? "When an agent asks you something or proposes a brief, the conversation shows here." : "Submit a work order to start a conversation with its Intake agent."} />
      )}
    </div>
  );
}
