/**
 * Inbox (#inbox): everything that waits for this person, in one list, decided right here. The list is the "waiting on you" part of
 * GET /home: gate approvals (with the rule and who else can decide), onboarding merges, questions agents asked, and the other decisions
 * the server puts in front of this person (trust, learning, MCP and trigger proposals, a factory restore). Every decision is a command the server checks (approver rules, separation of duties).
 * Tabs, search, type and sorting are in the URL (`?tab=&q=&type=&sort=&dir=`). The Decided tab lists what this person decided in this session.
 */
import { useMemo } from "react";
import { fmt } from "@gantry/domain";
import { ops } from "../api/ops";
import { useHome, useProjects } from "../api/queries";
import { useTravelerWo, dec } from "./traveler/model";
import { Btn, Chip, FilterBar, SearchBox, Select, Tabs, Status, type Decision } from "../ui/primitives";
import { DataTable, type SortState } from "../ui/DataTable";
import { Card, CrEmpty, ListItem, Page } from "../ui/cr";
import { Async, useCommand } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { navigate, hashFor } from "../lib/router";
import { setProject, updatePrefs } from "../lib/prefs";
import { setRouteState, useClearRouteStateOnLeave, useRouteState } from "../lib/queryState";
import { useDecided } from "../lib/decided";
import { useOpenTraveler } from "../shell/useTraveler";
import type { Conversation, HomeFull } from "./home/data";
import { useReviewApproval } from "./inbox/ApprovalDialog";
import { TYPE_LABEL, titleOf, typeOf, useItems, type Item } from "./inbox/kit";
import type { PView } from "./projects/kit";
import { StateBody, useStateOverride } from "./ops1/stateOverride";

const CHECKING: Decision = { allowed: false, reason: "Checking what you may decide here.", needs: "" };

/** A failed, blocked or parked work order: the reason, and the actions the server allows this person (retry, assign). */
function StuckActions({ c }: { c: Conversation }) {
  const open = useOpenTraveler();
  const s = c.stuck!;
  const q = useTravelerWo(c.wo);
  const t = q.data;
  const ifm = t ? { ifMatch: t.version } : undefined;
  const retry = useCommand(() => ops.retry(c.wo, undefined, ifm), {});
  const guard: Decision = !t ? CHECKING : dec(t, "sendback");
  return (
    <>
      {s.actions.includes("retry") ? <Btn label="Retry" kind="primary" icon="refresh" id={`inb-retry-${c.wo}`} guard={guard} onClick={() => void retry.run()} /> : null}
      <Btn label={s.actions.includes("assign") ? "Open to assign an agent" : `Open ${c.wo}`} kind="ghost" id={`inb-open-${c.wo}`} onClick={() => open(c.wo)} />
    </>
  );
}


/** The prototype's one "Review" button per row: it opens the decision dialog (gates and proposals) or the onboarding session. */
function ApprovalActions({ it }: { it: Item }) {
  const review = useReviewApproval();
  if (it.kind === "gate" || it.kind === "other") return <Btn label="Review" kind="primary" small id={`inb-review-${it.key}`} onClick={() => review(it)} />;
  if (it.kind === "onboarding") {
    const a = it.a;
    return <Btn label="Review" kind="primary" small id={`inb-onb-${a.repo}`} onClick={() => { if (a.project) setProject(a.project); navigate("onboarding", a.repo); }} />;
  }
  return null;
}

const TYPES = ["gate", "trust", "learning", "mcp", "trigger", "onboarding"];
const agoOf = (ms: number): string => (ms ? fmt.ago(Date.now() - ms, Date.now()) : "just now");

/** One question for a person, as a card (prototype: a stack of cards); the answer is written here or in the conversation. */
function QuestionCard({ it }: { it: Extract<Item, { kind: "question" | "stuck" }> }) {
  const ui = useUI();
  const open = useOpenTraveler();
  const c = it.c;
  const stuck = it.kind === "stuck";
  const answer = () =>
    ui.reasonDialog({
      title: `Answer ${c.wo}`, kicker: "Question", sub: c.question || c.title, label: "Your answer", placeholder: "Your answer", ok: "Send answer", min: 3,
      onOk: async (text) => {
        const r = await ops.answer(c.wo, text);
        if (r.ok) ui.toast("Answer sent.", "ok");
        return r;
      },
    });
  return (
    <Card id={`inb-${it.key}`} title={c.question || (stuck ? "This work order stopped and needs a person." : "Confirm the brief or answer the open question.")}>
      <div className="row" style={{ marginBottom: 12 }}>
        {stuck ? <Status tone="fail">{c.stuck!.state === "blocked" ? "Blocked" : c.stuck!.state === "parked" ? "Parked" : "Failed"}</Status> : <Chip text="Question" cls="agent" />}
        <span className="dim">about</span>
        <a className="mono" href={hashFor("record", c.wo)} onClick={(e) => { e.preventDefault(); open(c.wo); }}>{c.wo}</a>
        <span className="dim">{c.title}</span>
        {it.projectName ? <span className="tag">{it.projectName}</span> : null}
      </div>
      <div className="row">
        {stuck ? <StuckActions c={c} /> : (
          <>
            <Btn label="Write an answer…" kind="primary" icon="chat" id={`inb-answer-${c.wo}`} onClick={answer} />
            <Btn label="Open conversation" kind="ghost" id={`inb-conv-${c.wo}`} onClick={() => { setProject(c.project); updatePrefs({ openConversation: c.wo }); navigate("conversations"); }} />
          </>
        )}
      </div>
    </Card>
  );
}

const KEYS = ["tab", "q", "type", "sort", "dir"];

export default function InboxView() {
  const q = useHome();
  const home = q.data as unknown as HomeFull | undefined;
  const projData: unknown = useProjects().data;
  const projList = useMemo(() => (Array.isArray(projData) ? projData : []) as PView[], [projData]);
  const names = useMemo(() => new Map(projList.map((p) => [p.id, p.name] as [string, string])), [projList]);
  const keys = useMemo(() => new Map(projList.map((p) => [p.id, p.key] as [string, string])), [projList]);
  const items = useItems(home, names);
  const decided = useDecided();
  const [tab, setTab] = useRouteState("tab", "approvals");
  const [search, setSearch] = useRouteState("q", "");
  const [type, setType] = useRouteState("type", "all");
  const [sortKey, setSortKey] = useRouteState("sort", "");
  const [sortDir, setSortDir] = useRouteState("dir", "asc");
  useClearRouteStateOnLeave(KEYS);
  const override = useStateOverride();
  const approvals = items.filter((i) => i.group === "gate" || i.group === "onboarding" || i.group === "other");
  const questions = items.filter((i): i is Extract<Item, { kind: "question" | "stuck" }> => i.kind === "question" || i.kind === "stuck");
  const needle = search.trim().toLowerCase();
  const shown = approvals.filter((i) => {
    if (type !== "all" && typeOf(i) !== type) return false;
    const t = titleOf(i);
    return !needle || `${String(t.title)} ${String(t.sub)} ${i.projectName}`.toLowerCase().includes(needle);
  });
  const sorted = shown.slice().sort((a, b) => (a.kind === "gate" ? 0 : 1) - (b.kind === "gate" ? 0 : 1) || b.waitMs - a.waitMs);
  const filtered = !!needle || type !== "all";
  const extraTypes = [...new Set(approvals.map(typeOf))].filter((t) => !TYPES.includes(t));
  const sort: SortState | undefined = sortKey ? { key: sortKey, dir: sortDir === "desc" ? -1 : 1 } : undefined;
  const clear = () => setRouteState({ q: null, type: null, sort: null, dir: null });
  const tag = (i: Item) => (i.project && i.project !== "factory" ? <span className="tag">{keys.get(i.project) ?? i.projectName}</span> : <span className="dim">factory</span>);
  return (
    <Page eyebrow="Operate" title="Inbox" sub="Everything waiting for a person: gates, proposals, questions." cls="inbox">
      {override ? <StateBody state={override} /> : <Async query={q} what="your inbox" id="inbox" isEmpty={() => false}>{() => (
        <>
          <Tabs idPrefix="inbox-tab" active={tab} onChange={setTab} items={[{ id: "approvals", label: "Approvals", count: approvals.length }, { id: "questions", label: "Questions", count: questions.length }, { id: "decided", label: "Decided", count: decided.length }]} />
          <span className="sr-only" id="inbox-count">{items.length}</span>
          {tab === "approvals" ? (
            <>
              <FilterBar label="Filter approvals" count={`${shown.length} of ${approvals.length}`} actions={filtered || sortKey ? <Btn small kind="ghost" label="Clear" id="inbox-clear" onClick={clear} /> : undefined}>
                <SearchBox id="inbox-q" value={search} onChange={setSearch} placeholder="Search approvals" />
                <Select id="inbox-type" aria-label="Type" value={type} onChange={setType} options={[{ value: "all", label: "Type: all" }, ...[...TYPES, ...extraTypes].map((v) => ({ value: v, label: TYPE_LABEL[v] ?? v }))]} />
              </FilterBar>
              <DataTable<Item>
                id="t-inbox"
                caption="Approvals waiting on you"
                rows={sorted}
                rowKey={(i) => i.key}
                rowId={(i) => `inb-${i.key}`}
                pageSize={10}
                neutralArrow
                pager
                sort={sort}
                onSort={(s) => { setSortKey(s.key); setSortDir(s.dir === -1 ? "desc" : "asc"); }}
                empty={approvals.length ? { title: "Nothing matches these filters", text: "Try clearing a filter or searching for something else.", action: <Btn label="Clear filters" id="inbox-reset" onClick={clear} /> } : { title: "Inbox zero", text: "Nothing is waiting for you." }}
                columns={[
                  { key: "title", label: "Request", sort: (i) => String(titleOf(i).title), render: (i) => { const t = titleOf(i); return (<><ReviewLink it={i}>{t.title}</ReviewLink><span className="dim ell" style={{ fontSize: 12 }}>{t.sub}</span></>); } },
                  { key: "type", label: "Type", sort: (i) => typeOf(i), render: (i) => { const t = titleOf(i); return <Chip text={t.type} cls={t.tone} />; } },
                  { key: "project", label: "Project", sort: (i) => keys.get(i.project) ?? i.projectName, render: tag },
                  { key: "at", label: "Waiting", sort: (i) => i.waitMs, render: (i) => <span className="mono">{agoOf(i.waitMs)}</span> },
                  { key: "votes", label: "Votes", render: (i) => <span className="mono">{(i.kind === "gate" || i.kind === "onboarding") && i.a.need ? `${i.a.have ?? 0}/${i.a.need}` : "—"}</span> },
                  { key: "act", label: "", align: "end", render: (i) => <ApprovalActions it={i} /> },
                ]}
              />
            </>
          ) : tab === "questions" ? (
            questions.length ? (
              <div className="stack">{questions.map((i) => <QuestionCard key={i.key} it={i} />)}</div>
            ) : (
              <div className="card"><CrEmpty icon="chat" title="No open questions" text="Agents will ask here when they need a decision from a person." /></div>
            )
          ) : decided.length ? (
            <div className="card"><div className="card-b flush">{decided.map((d) => (
              <ListItem key={d.key} tone={d.decision === "approved" ? "ok" : "bad"} title={d.title} sub={`${d.decision === "approved" ? "Approved" : d.decision === "rejected" ? "Rejected" : "Changes requested"}${d.note ? `: ${d.note}` : ""} · you`}>
                <span className="mono dim">{fmt.ago(d.at, Date.now())}</span>
              </ListItem>
            ))}</div></div>
          ) : (
            <div className="card"><CrEmpty icon="check" title="No decisions yet this session" text="Approve or reject something and it will be listed here." /></div>
          )}
        </>
      )}</Async>}
    </Page>
  );
}

/** The request title is a link that opens the decision (or the onboarding session). */
function ReviewLink({ it, children }: { it: Item; children: React.ReactNode }) {
  const review = useReviewApproval();
  return (
    <a className="rl ell" href="#inbox" onClick={(e) => {
      e.preventDefault();
      if (it.kind === "onboarding") { if (it.a.project) setProject(it.a.project); navigate("onboarding", it.a.repo); } else review(it);
    }}>{children}</a>
  );
}
