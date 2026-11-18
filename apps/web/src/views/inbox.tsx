/**
 * Inbox (#inbox): everything that waits for this person, in one list, decided right here. The list is the "waiting on you" part of
 * GET /home: gate approvals (with the rule and who else can decide), onboarding merges, questions agents asked, and the other decisions
 * the server puts in front of this person (trust, learning, MCP and trigger proposals, a factory restore). Every decision is a command the server checks (approver rules, separation of duties).
 */
import { useMemo, useState, type ReactNode } from "react";
import { useAgents, useHome, useLearningProposals, useMe, useProjects, useTrustCells } from "../api/queries";
import { useCan } from "../api/can";
import { Avatar, Btn, Chip, Empty, FilterBar, Panel, SearchBox, Select, Status, Tabs, ViewHead } from "../ui/primitives";
import { DataTable, type Col, type SortState } from "../ui/DataTable";
import { Async } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { hashFor, navigate, useHash } from "../lib/router";
import { setProject } from "../lib/prefs";
import { gotoWithQuery, useUrlParam } from "../lib/urlState";
import { GateActions } from "./work/gate";
import { agoMs } from "./work/format";
import { useItems, type Group, type Item } from "./work/items";
import { useScope } from "./work/scope";
import { makeStopActions } from "../shell/stopActions";
import { useOpenTraveler } from "../shell/useTraveler";
import { goAttention, type HomeFull } from "./home/data";

/** One waiting item as a prototype list row: the work order and a tag, the title, a quiet line, the actions on the right. */
function Row({ id, tag, project, title, sub, status, children, details, actions }: { id: string; tag: string; project: string; title: ReactNode; sub: ReactNode; status?: ReactNode; children?: ReactNode; details?: ReactNode; actions?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <li id={id} className="inb-row" aria-label={typeof title === "string" ? title : undefined} style={{ flexWrap: "wrap" }}>
      <div className="grow">
        <div className="row"><Chip text={tag} cls="info" />{project ? <span className="small muted">{project}</span> : null}{status}</div>
        <div className="pri-cell-title">{title}</div>
        <div className="small muted">{sub}</div>
        <div className="row">
          {children}
          {details ? <Btn label={open ? "Hide details" : "Show details"} small kind="ghost" aria-pressed={open} id={`${id}-details`} onClick={() => setOpen(!open)} /> : null}
        </div>
      </div>
      {actions ? <div className="row inb-actions">{actions}</div> : null}
      {open && details ? <div className="inb-details" style={{ flexBasis: "100%" }}>{details}</div> : null}
    </li>
  );
}

const WO_LINK = (wo: string, project: string) => hashFor("record", wo, project);
const WaitText = (n: number | undefined) => (n ? agoMs(n) : "now");

type GateIt = Extract<Item, { kind: "gate" }>;

/** The gate table: the prototype's columns, sortable (the sort is in the URL), the row opens the work order, Approve and Reject on the right. */
function GateTable({ rows }: { rows: GateIt[] }) {
  const [sortQ, setSortQ] = useUrlParam("sort", "wait:asc");
  const [k = "wait", d = "asc"] = sortQ.split(":");
  const sort: SortState = { key: k, dir: d === "desc" ? -1 : 1 };
  const cols: Col<GateIt>[] = [
    { key: "id", label: "Work order", sort: (r) => r.a.wo ?? "", render: (r) => <div><a className="pri mono" href={WO_LINK(r.a.wo ?? "", r.project)} id={`inb-wo-${r.a.wo}`}>{r.a.wo}</a><span className="sub trunc" style={{ maxWidth: 340 }}>{r.a.title}</span></div> },
    { key: "gate", label: "Gate", render: (r) => <div><Chip text={r.a.gateLabel ?? r.a.gate ?? ""} cls="warn" /><span className="sub">{r.a.gateName}</span></div> },
    { key: "project", label: "Project", render: (r) => r.projectName },
    // oldest first is ascending by the time the gate opened, as the prototype sorts it
    { key: "wait", label: "Waiting", sort: (r) => -r.waitMs, render: (r) => WaitText(r.waitMs) },
    { key: "p", label: "Priority", render: (r) => (r.a.priority ? <Chip text={r.a.priority} cls={r.a.priority === "P0" || r.a.priority === "P1" ? "bad" : "info"} /> : <span className="muted" title="The server did not send a priority">—</span>) },
    { key: "a", label: "", align: "end", render: (r) => <div className="row" style={{ justifyContent: "flex-end" }}><GateActions a={r.a} idPrefix="inb" /></div> },
  ];
  return <DataTable proto id="inbox-g" caption="Approvals waiting for a decision" columns={cols} rows={rows} rowKey={(r) => r.key} rowId={(r) => `inb-${r.key}`} rowHref={(r) => WO_LINK(r.a.wo ?? "", r.project)} rowLabel={(r) => `Open ${r.a.wo}`} sort={sort} onSort={(n) => setSortQ(`${n.key}:${n.dir === 1 ? "asc" : "desc"}`)} pageSize={12} />;
}

function OnboardingItem({ it }: { it: Extract<Item, { kind: "onboarding" }> }) {
  const a = it.a;
  return (
    <Row
      id={`inb-${it.key}`}
      tag="Onboarding"
      project={it.projectName}
      title={a.note ? `Onboarding update: ${a.repoName}` : `Merge onboarding pull request ${a.repoName}#${a.pr}`}
      sub={a.note ?? "Checks are green. Sensitive files need an explicit tick in the session."}
      status={<Status tone="wait">Waiting</Status>}
      actions={<Btn label={a.note ? "Open session" : "Open onboarding"} kind="primary" id={`inb-onb-${a.repo}`} onClick={() => { if (a.project) setProject(a.project); navigate("onboarding", a.repo); }} />}
    />
  );
}

function QuestionItem({ it }: { it: Extract<Item, { kind: "question" }> }) {
  const c = it.c;
  return (
    <li id={`inb-${it.key}`} className="inb-row">
      <Avatar id={c.from ?? null} />
      <div className="grow">
        <div className="row"><a className="pri mono" href={WO_LINK(c.wo, c.project)}>{c.wo}</a><Chip text="Awaiting answer" cls="info" /></div>
        <div className="small muted trunc">{c.title}</div>
      </div>
      <Btn label="Answer" small id={`inb-conv-${c.wo}`} onClick={() => navigate("conversations", c.wo, c.project)} />
    </li>
  );
}

/** A failed or blocked work order, as the prototype's row: the work order, the title with the reason in red, Open. */
function StuckItem({ it }: { it: Extract<Item, { kind: "stuck" }> }) {
  const c = it.c;
  const s = c.stuck!;
  return (
    <li id={`inb-${it.key}`} className="inb-row">
      <a className="pri mono" href={WO_LINK(c.wo, c.project)}>{c.wo}</a>
      <div className="grow">
        <div className="trunc">{c.title}</div>
        <div className="small" style={{ color: "var(--bad)" }}>{s.reason || c.question || "This work order stopped and needs a person."}</div>
      </div>
      <Btn label="Open" small id={`inb-open-${c.wo}`} onClick={() => navigate("record", c.wo, c.project)} />
    </li>
  );
}

function OtherItem({ it }: { it: Extract<Item, { kind: "other" }> }) {
  const ui = useUI();
  const me = useMe();
  const open = useOpenTraveler();
  const x = it.x;
  const r = x.restore;
  const d = useCan(r?.scope === "factory" ? "restore.factory" : "restore.project", r?.scope === "project" ? { project: r.id } : {});
  const done = r?.approvals?.length ?? 0;
  const already = !!(me && r?.approvals?.some((a) => a.by === me.person.id));
  return (
    <Row
      id={`inb-${it.key}`}
      tag={r ? "Restore" : "Decision"}
      project={x.where}
      title={x.title}
      sub={x.sub}
      status={<Status tone="wait">Waiting</Status>}
      actions={
        <>
          {r && me && !d.pending && d.allowed ? (
            <Btn
              label={r.scope === "factory" ? (done ? `Approve restore (${done + 1} of ${r.needs ?? 2})` : "Restore factory") : "Restore project"}
              kind="primary"
              id={`inb-restore-${r.scope}${r.id ? `-${r.id}` : ""}`}
              disabledReason={already ? "You approved this restore already. A second Factory Admin must approve." : null}
              onClick={() => makeStopActions(ui, me).restore(r.scope, r.id)}
            />
          ) : null}
          <Btn label={x.act.label} kind={r ? "ghost" : "primary"} id={`inb-act-${x.id}`} onClick={() => goAttention(x.act, open)} />
        </>
      }
    />
  );
}

const TABS: Array<{ id: string; label: string; groups: Group[]; title: string; empty: [string, string] }> = [
  { id: "gates", label: "Approvals", groups: ["gate", "onboarding"], title: "Waiting for a decision", empty: ["No approvals waiting", "Gate requests appear here as agents finish their work."] },
  { id: "questions", label: "Questions", groups: ["questions"], title: "Agents are asking", empty: ["No open questions", "Agents will ask here when they need information."] },
  { id: "stuck", label: "Blocked", groups: ["stuck"], title: "Blocked or failed", empty: ["Nothing is blocked", "The line is flowing."] },
  { id: "proposals", label: "Proposals", groups: ["other"], title: "Trust promotions", empty: ["", ""] },
];
/** Older links named the tabs `approvals` and `blocked`, in the path. */
const ALIAS: Record<string, string> = { approvals: "gates", blocked: "stuck" };

/** The proposals tab: trust promotions waiting for a decision and learning proposals, from the same reads as the Trust and Learning screens. */
function Proposals({ others }: { others: Item[] }) {
  const trust = useTrustCells();
  const learning = useLearningProposals();
  const agentsQ = useAgents();
  const tp = trust.data?.proposals.filter((p) => p.status === "pending");
  const lp = learning.data?.filter((p) => p.status === "proposed");
  const nameOf = (id: string) => agentsQ.data?.find((a) => a.id === id)?.name ?? id;
  return (
    <>
      <Panel title="Trust promotions" flush id="inbox-trust">
        <Async query={trust} what="trust proposals" id="inbox-trust-state" isEmpty={() => !tp?.length} empty={<Empty id="inbox-trust-empty" title="No promotions pending" text="Trust proposals appear when an agent meets the criteria." />}>
          {() => (
            <ul className="list">
              {(tp ?? []).map((p) => {
                const [agent = "", ...rest] = p.cell.split("|");
                return (
                  <li key={p.id}>
                    <div className="grow">
                      <b>{nameOf(agent)}</b>
                      <div className="small muted">{`L${p.from} → L${p.to}${rest.length ? " · " + rest.join(" · ") : ""}`}</div>
                      <div className="small">{p.evidence.note}</div>
                    </div>
                    <Btn label="Open Trust" small id={`inb-trust-${p.id}`} onClick={() => gotoWithQuery("trust", { tab: "proposals" })} />
                  </li>
                );
              })}
            </ul>
          )}
        </Async>
      </Panel>
      <div style={{ height: 16 }} />
      <Panel title="Learning proposals" flush id="inbox-learning">
        <Async query={learning} what="learning proposals" id="inbox-learning-state" isEmpty={() => !lp?.length} empty={<Empty id="inbox-learning-empty" title="Nothing to review" text="Learning proposals show up here." />}>
          {() => (
            <ul className="list">
              {(lp ?? []).map((p) => (
                <li key={p.id}>
                  <div className="grow"><b>{p.title}</b><div className="small muted">{p.expected}</div></div>
                  <Btn label="Review" small id={`inb-learn-${p.id}`} onClick={() => navigate("learning")} />
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Panel>
      {others.length ? (
        <>
          <div style={{ height: 16 }} />
          <Panel title="Other decisions" flush id="inbox-other"><ul className="list">{others.map((i) => (i.kind === "other" ? <OtherItem key={i.key} it={i} /> : null))}</ul></Panel>
        </>
      ) : null}
    </>
  );
}

const PROPOSAL_ROUTES = new Set(["trust", "learning"]);

export default function InboxView() {
  const q = useHome();
  const home = q.data as HomeFull | undefined;
  const projList = useProjects().data;
  const scope = useScope();
  const names = useMemo(() => new Map((projList ?? []).map((p) => [p.id, p.name] as [string, string])), [projList]);
  const items = useItems(home, names);
  const param = useHash().param;
  const trust = useTrustCells().data;
  const learning = useLearningProposals().data;
  const [tabQ, setTabQ] = useUrlParam("tab", "");
  const tab = TABS.find((t) => t.id === (tabQ || ALIAS[param ?? ""] || param)) ?? TABS[0]!;
  const [project, setProj] = useUrlParam("project", "all");
  const [search, setSearch] = useUrlParam("q", "");
  const scoped = items.filter((i) => !scope.project || i.project === scope.project);
  // Trust and learning proposals have their own panels; what is left on the tab is the server's other decisions (a restore, an MCP or trigger proposal).
  const others = scoped.filter((i): i is Extract<Item, { kind: "other" }> => i.kind === "other" && !PROPOSAL_ROUTES.has(i.x.act.route));
  const inTab = (t: (typeof TABS)[number]) => (t.id === "proposals" ? others : scoped.filter((i) => t.groups.includes(i.group)));
  const proposalsN = (trust?.proposals ?? []).filter((p) => p.status === "pending").length + (learning ?? []).filter((p) => p.status === "proposed").length + others.length;
  const countOf = (t: (typeof TABS)[number]) => (t.id === "proposals" ? proposalsN : inTab(t).length);
  const needle = search.trim().toLowerCase();
  const textOf = (i: Item): string => (i.kind === "gate" || i.kind === "onboarding" ? `${i.a.wo ?? ""} ${i.a.title ?? ""} ${i.a.repoName ?? ""} ${i.projectName} ${i.project}` : i.kind === "other" ? `${i.x.title} ${i.x.sub}` : `${i.c.wo} ${i.c.title} ${i.c.question ?? ""}`).toLowerCase();
  const all = inTab(tab);
  // The prototype filters the Approvals table only; the other lists show everything.
  const shown = tab.id !== "gates" ? all : all.filter((i) => (project === "all" || i.project === project) && (!needle || textOf(i).includes(needle)));
  const gates = shown.filter((i): i is GateIt => i.kind === "gate");
  const onb = shown.filter((i) => i.kind === "onboarding");
  const filtered = project !== "all" || !!needle;
  const render = (i: Item): ReactNode =>
    i.kind === "onboarding" ? <OnboardingItem key={i.key} it={i} /> : i.kind === "question" ? <QuestionItem key={i.key} it={i} /> : i.kind === "stuck" ? <StuckItem key={i.key} it={i} /> : null;
  return (
    <div className="view inbox">
      <ViewHead title="Inbox" kicker={scope.kicker} sub="Everything that is waiting for a person, in one place." />
      <Async query={q} what="your inbox" id="inbox" isEmpty={() => false}>{() => (
        <>
          <Tabs idPrefix="inbox-tab" active={tab.id} onChange={(id) => { setTabQ(id); if (param) navigate("inbox"); }} items={TABS.map((t) => ({ id: t.id, label: t.label, count: countOf(t) }))} />
          <span className="sr" id="inbox-count">{String(scoped.filter((i) => i.kind !== "other").length + proposalsN)}</span>
          {tab.id === "proposals" ? <Proposals others={others} /> : (
            <Panel title={tab.title} flush id={`inbox-${tab.id}`}>
              {all.length ? (
                <>
                  {tab.id === "gates" ? (
                    <FilterBar count={`${shown.length} approvals${filtered ? ` of ${all.length}` : ""}`}>
                      <SearchBox id="inbox-search" value={search} onChange={(v) => setSearch(v)} placeholder="Search…" label="Search approval" />
                      <label htmlFor="inb-proj">
                        <span>Project</span>
                        <Select id="inb-proj" options={[{ value: "all", label: "All" }, ...(projList ?? []).map((p) => ({ value: p.id, label: p.name }))]} value={project} onChange={(v) => setProj(v)} />
                      </label>
                      {filtered ? <Btn label="Clear" small kind="ghost" id="inbox-reset" onClick={() => { setSearch(""); setProj("all"); }} /> : null}
                    </FilterBar>
                  ) : null}
                  {!shown.length ? (
                    <Empty id="inbox-filtered-empty" icon="filter" title="Nothing matches these filters" text="Loosen the search or clear the filters." action={<Btn label="Clear filters" id="inbox-clear-filters" onClick={() => { setSearch(""); setProj("all"); }} />} />
                  ) : tab.id === "gates" ? (
                    <>
                      {gates.length ? <GateTable rows={gates} /> : null}
                      {onb.length ? <ul className="list">{onb.map(render)}</ul> : null}
                    </>
                  ) : (
                    <ul className="list">{shown.map(render)}</ul>
                  )}
                </>
              ) : (
                <Empty id={`inbox-${tab.id}-empty`} title={tab.empty[0]} text={tab.empty[1]} />
              )}
            </Panel>
          )}
        </>
      )}</Async>
    </div>
  );
}
