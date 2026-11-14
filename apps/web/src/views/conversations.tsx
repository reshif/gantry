/**
 * Conversations (#conversations): the inbox of intake conversations for the current project, the thread with quick-reply chips
 * and free text, the classification with override, and the live brief. Ported from legacy/js/views/conversations.js;
 * the thread and the brief panel live in views/conversations/ so the traveler's Conversation tab shares them.
 */
import { useEffect, useMemo, useState } from "react";
import { fmt } from "@gantry/domain";
import { useCan } from "../api/can";
import { useConversations, useMe, useProject } from "../api/queries";
import type { WorkOrder } from "../api/types";
import { pickProject } from "../lib/routes";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Btn, Tabs, ViewHead } from "../ui/primitives";
import { Icon } from "../ui/Icon";
import { ClassChip, EmptyState, classOf, useCatalog } from "./projects/kit";
import { BriefPanel } from "./conversations/Brief";
import { StatusChip, ConversationThread } from "./conversations/Thread";
import { atIntake, isOpen, lastAt } from "./conversations/model";
import { useOpenRecordRoute } from "./record/nav";
import { projectSubmitBlock, useNewWorkOrder } from "./work-orders/New";
import { useProjectRepos } from "./floor/kit";
import type { Page } from "../api/types";

type Tab = "awaiting" | "open" | "resolved";

export default function ConversationsView() {
  const me = useMe();
  const prefs = usePrefs();
  const cat = useCatalog();
  const openRecord = useOpenRecordRoute();
  const projectId = me ? pickProject(me, prefs.project) : null;
  const project = useProject(projectId).data ?? null;
  const submit = useCan("wo.submit", projectId ? { project: projectId } : {});
  const repos = useProjectRepos(projectId);
  const newWoDialog = useNewWorkOrder();
  const all = useConversations(projectId ? { project: projectId } : {});
  const mineQ = useConversations(projectId ? { project: projectId, awaitingMe: true } : {});
  const [tab, setTab] = useState<Tab | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [mobileThread, setMobileThread] = useState(false);
  const wos = useMemo(() => {
    const d = all.data as WorkOrder[] | Page<WorkOrder> | undefined;
    return Array.isArray(d) ? d : (d?.items ?? []);
  }, [all.data]);
  const mineIds = useMemo(() => {
    const d = mineQ.data as WorkOrder[] | Page<WorkOrder> | undefined;
    return new Set((Array.isArray(d) ? d : (d?.items ?? [])).map((w) => w.id));
  }, [mineQ.data]);
  const groups = useMemo(() => {
    const g = { awaiting: wos.filter((w) => mineIds.has(w.id)), open: wos.filter(isOpen), resolved: wos.filter((w) => !isOpen(w)) };
    (Object.keys(g) as Tab[]).forEach((k) => g[k].sort((a, b) => lastAt(b) - lastAt(a)));
    return g;
  }, [wos, mineIds]);
  // a deep link (the work orders table, a traveler) asks for one conversation
  const pending = prefs.openConversation;
  useEffect(() => {
    if (!pending || !wos.length) return;
    const pw = wos.find((w) => w.id === pending);
    if (pw) {
      setSel(pending);
      setTab(mineIds.has(pw.id) ? "awaiting" : isOpen(pw) ? "open" : "resolved");
      setMobileThread(true);
      updatePrefs({ openConversation: null });
    }
    // not in the list yet (a work order submitted a moment ago, before the list refetched): keep the request and retry when the list changes
  }, [pending, wos, mineIds]);
  if (!me || !cat) return <div className="view conv-view" />;
  if (!projectId || !project) return <div className="view"><EmptyState title="No project" text="You do not have a project to show." /></div>;
  const cur: Tab = tab ?? (groups.awaiting.length ? "awaiting" : "open");
  let list = groups[cur];
  const selWo = sel ? wos.find((w) => w.id === sel) : null;
  let activeTab = cur;
  // the selected conversation moved (answered, confirmed, declined): follow it to its new tab
  if (selWo && !list.includes(selWo)) {
    activeTab = groups.awaiting.includes(selWo) ? "awaiting" : groups.open.includes(selWo) ? "open" : "resolved";
    list = groups[activeTab];
  }
  const shown = selWo ?? list[0] ?? null;
  const block = projectSubmitBlock(me, project, repos);
  const newWo = () => newWoDialog({ project: project.id });
  const ready = groups.open.filter((w) => atIntake(w) && w.conv.done).length;
  return (
    <div className="view conv-view">
      <ViewHead
        kicker={`Project · ${project.name}`}
        title="Conversations"
        sub="The Intake agent asks what it needs to write the brief. Work stays at Intake until the brief is confirmed at G0+G1 or declined."
        meta={[["For me", String(groups.awaiting.length)], ["Open", String(groups.open.length)], ["Ready to confirm", String(ready)]]}
        actions={<Btn label="New work order" kind="primary" icon="plus" id="conv-new" guard={submit.pending ? null : submit} disabledReason={submit.allowed ? block : null} onClick={newWo} />}
      />
      <div id="conv-headbar" />
      <div className={`conv-layout${mobileThread && shown ? " show-thread" : ""}`}>
        <nav className="conv-inbox" aria-label="Conversations">
          <Tabs
            idPrefix="conv-tab"
            items={[{ id: "awaiting", label: "For me", count: groups.awaiting.length }, { id: "open", label: "Open", count: groups.open.length }, { id: "resolved", label: "Resolved", count: groups.resolved.length }]}
            active={activeTab}
            onChange={(t) => {
              setTab(t as Tab);
              setSel(null);
            }}
          />
          {list.length ? (
            <ul className="conv-list" data-keep-scroll="conv-list">
              {list.map((w) => {
                const mine = mineIds.has(w.id);
                const on = shown?.id === w.id;
                return (
                  <li key={w.id} className="conv-li">
                    <button type="button" className={`conv-item${on ? " is-selected" : ""}${mine ? " is-mine" : ""}`} id={`conv-item-${w.id}`} aria-current={on ? "true" : undefined} onClick={() => { setSel(w.id); setMobileThread(true); }}>
                      <span className="conv-item-top">
                        <span className="mono strong">{w.id}</span>
                        <ClassChip cls={classOf(cat, project, w.cls)} small />
                        <span className="mono muted small conv-item-t">{fmt.ago(lastAt(w), Date.now())}</span>
                      </span>
                      <span className="conv-item-title">{w.title}</span>
                      <span className="conv-item-foot">
                        <StatusChip wo={w} />
                        {mine ? <span className="conv-you">You</span> : null}
                      </span>
                    </button>
                    <button type="button" className="icon-btn icon-btn-sm conv-item-rec" id={`conv-rec-${w.id}`} aria-label={`Open full record for ${w.id}`} data-tip="Full record" onClick={() => openRecord(w.id, w.project)}>
                      <Icon name="record" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              id="conv-empty"
              icon="chat"
              title={activeTab === "awaiting" ? "Nothing waits on you" : activeTab === "open" ? "No open conversations" : "Nothing resolved yet"}
              text={activeTab === "awaiting" ? "Questions for you from the Intake agent and later stations appear here." : "Submit a work order to start an intake conversation."}
              action={activeTab !== "resolved" ? <Btn label="New work order" small icon="plus" id="conv-new-empty" guard={submit.pending ? null : submit} disabledReason={submit.allowed ? block : null} onClick={newWo} /> : null}
            />
          )}
        </nav>
        {shown ? (
          <section className="conv-main" aria-label={`Conversation ${shown.id}`}>
            <button type="button" className="linkish conv-back" id="conv-back" onClick={() => setMobileThread(false)}>
              <Icon name="back" />
              Inbox
            </button>
            <ConversationThread woId={shown.id} head />
          </section>
        ) : (
          <section className="conv-main">
            <EmptyState title="No conversation selected" text="Pick one from the inbox." />
          </section>
        )}
        {shown ? (
          <aside className="conv-brief" aria-label="Brief" data-keep-scroll="conv-brief">
            <BriefPanel woId={shown.id} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
