/**
 * Inbox (#inbox): everything that waits for this person, in one list, decided right here. The list is the "waiting on you" part of
 * GET /home: gate approvals (with the rule and who else can decide), onboarding merges, questions agents asked, and the other decisions
 * the server puts in front of this person (trust, learning, MCP and trigger proposals, a factory restore). Every decision is a command the server checks (approver rules, separation of duties).
 */
import { useMemo, useState, type ReactNode } from "react";
import { fmt, gatePendingTitle } from "@gantry/domain";
import { ops } from "../api/ops";
import { useHome, useMe, useProjects } from "../api/queries";
import { dec, useTravelerWo } from "./traveler/model";
import { useCan } from "../api/can";
import { Btn, Chip, FilterBar, SearchBox, Select, Tabs, Status, type Decision } from "../ui/primitives";
import { DataTable } from "../ui/DataTable";
import { Card, CrEmpty, Page } from "../ui/cr";
import { Async } from "../ui/async";
import { useCommand } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { navigate } from "../lib/router";
import { setProject, updatePrefs } from "../lib/prefs";
import { makeStopActions } from "../shell/stopActions";
import { useOpenTraveler } from "../shell/useTraveler";
import { useGateApprovers } from "./traveler/Approvers";
import { goAttention, type Approval, type AttentionItem, type Conversation, type HomeFull } from "./home/data";

type Item =
  | { kind: "gate"; group: "gate"; key: string; project: string; projectName: string; waitMs: number; a: Approval }
  | { kind: "onboarding"; group: "onboarding"; key: string; project: string; projectName: string; waitMs: number; a: Approval }
  | { kind: "question"; group: "questions"; key: string; project: string; projectName: string; waitMs: number; c: Conversation }
  | { kind: "stuck"; group: "stuck"; key: string; project: string; projectName: string; waitMs: number; c: Conversation }
  | { kind: "other"; group: "other"; key: string; project: string; projectName: string; waitMs: number; x: AttentionItem };

/** Attention items that are decisions for this person, rather than health to look at: a restore, and proposals on the governance pages. */
const DECISION_ROUTES = new Set(["trust", "learning", "mcp", "api", "integrations"]);
const isDecision = (x: AttentionItem): boolean => !!x.restore || DECISION_ROUTES.has(x.act.route);

function useItems(home: HomeFull | undefined, names: Map<string, string>): Item[] {
  return useMemo(() => {
    const s = home?.sections;
    if (!s) return [];
    const out: Item[] = [];
    const projectNames = new Map(names);
    for (const a of s.waiting?.approvals ?? []) if (a.project && a.projectName) projectNames.set(a.project, a.projectName);
    for (const a of s.waiting?.approvals ?? []) {
      const base = { project: a.project, projectName: a.projectName, waitMs: a.waitMs ?? 0 };
      out.push(a.repo ? { kind: "onboarding", group: "onboarding", key: `onb-${a.repo}-${a.note ? "n" : "m"}`, ...base, a } : { kind: "gate", group: "gate", key: `gate-${a.wo}-${a.gate}`, ...base, a });
    }
    for (const c of s.waiting?.conversations ?? []) {
      const projectName = projectNames.get(c.project) ?? "";
      // The brief gate is a gate decision whatever line the conversation last said (the classifier's line is not a question): it is listed with the gate approvals.
      if (c.gate) {
        if (out.some((i) => i.kind === "gate" && i.a.wo === c.wo && i.a.gate === c.gate!.id)) continue;
        const a: Approval = { wo: c.wo, title: c.title, gate: c.gate.id, gateLabel: c.gate.label, gateName: c.gate.name, project: c.project, projectName };
        out.push({ kind: "gate", group: "gate", key: `gate-${c.wo}-${c.gate.id}`, project: c.project, projectName, waitMs: 0, a });
        continue;
      }
      if (c.stuck) { out.push({ kind: "stuck", group: "stuck", key: `stuck-${c.wo}`, project: c.project, projectName, waitMs: 0, c }); continue; }
      out.push({ kind: "question", group: "questions", key: `q-${c.wo}`, project: c.project, projectName, waitMs: 0, c });
    }
    for (const x of s.attention ?? []) if (isDecision(x)) out.push({ kind: "other", group: "other", key: x.id, project: x.act.project ?? "factory", projectName: x.where, waitMs: 0, x });
    return out.sort((p, q) => q.waitMs - p.waitMs);
  }, [home, names]);
}

/** The rule, progress and who else may decide: read from the server for this gate, never worked out here. */
function GateRule({ wo, gate, project }: { wo: string; gate: string; project: string }) {
  const q = useGateApprovers(wo, gate);
  const a = q.data;
  const go = (route: string, param?: string) => navigate(route, param ?? null, route === "project-config" ? project : undefined);
  if (!a) return <Async query={q} what="who may approve this gate" id={`inb-rule-${wo}-${gate}`} rows={2}>{() => null}</Async>;
  return (
    <div className="inb-rule">
      <div className="inb-rule-h">Who can approve and why</div>
      <p className="small">{a.rule.text}</p>
      <p className="small"><strong>{`${a.progress.have} of ${a.progress.need}`}</strong>{a.progress.approvals.length ? ` · approved by ${a.progress.approvals.map((x) => x.name).join(", ")}` : ""}{a.progress.unmet.length ? ` · still needs ${a.progress.unmet.join("; ")}` : ""}</p>
      {!a.satisfiable ? <p className="small inb-warn" role="alert">{a.warning}</p> : null}
      {a.eligible.length ? <p className="small muted">{`Can decide: ${a.eligible.map((e) => e.name + (e.away ? " (away)" : "")).join(", ")}.`}</p> : <p className="small muted">Nobody is eligible today.</p>}
      <div className="inb-rule-acts">
        <Btn small kind="ghost" label="Edit rule" id={`inb-edit-${wo}-${gate}`} guard={a.can.editRule ? null : { allowed: false, reason: a.can.editWhy || "You may not edit approver rules.", needs: "" }} onClick={() => go("project-config", `approvers/${gate}`)} />
        <Btn small kind="ghost" label="Grant a role" id={`inb-grant-${wo}-${gate}`} guard={a.can.grantRole ? null : { allowed: false, reason: a.can.grantWhy || "You may not grant roles.", needs: "" }} onClick={() => go("people")} />
      </div>
    </div>
  );
}

const CHECKING: Decision = { allowed: false, reason: "Checking what you may decide here.", needs: "" };



/** Approve / ask for changes on one gate, pinned to the gate instance and the work order version the server returned. */
function GateActions({ it, onDone }: { it: Extract<Item, { kind: "gate" }>; onDone?: () => void }) {
  const ui = useUI();
  const open = useOpenTraveler();
  const a = it.a;
  const wo = a.wo ?? "";
  const gate = a.gate ?? "";
  const q = useTravelerWo(wo);
  const t = q.data;
  const brief = gate === "G0G1";
  const ap = t?.allowed?.approve;
  // Locked, with the reason, until the server's decision for this person is known; the brief gate has its own decline decision.
  const base: Decision = !t
    ? q.isError
      ? { allowed: false, reason: "Could not check what you may decide. Open the work order to decide there.", needs: "" }
      : CHECKING
    : ap && ap.gate === gate
      ? { allowed: ap.allowed, reason: ap.reason, needs: ap.needs }
      : { allowed: false, reason: `${wo} is no longer waiting at this gate.`, needs: "" };
  const decideBack: Decision = brief && t && base.allowed ? dec(t, "decline") : base;
  const ifm = t ? { ifMatch: t.version } : undefined;
  const approve = useCommand(() => (brief ? ops.confirmBrief(wo, undefined, ifm) : ops.approveGate(wo, gate, ap?.instance ?? a.instance, undefined, ifm)), {});
  const back = () =>
    ui.reasonDialog({
      title: brief ? `Decline ${wo}` : `Ask for changes on ${wo}`,
      kicker: a.gateName ?? "Gate decision",
      ok: brief ? "Decline" : "Ask for changes",
      kind: "danger",
      min: 5,
      placeholder: brief ? "Why will the factory not do this?" : "What must change before this passes?",
      sub: brief ? "The work order moves to Declined and the submitter is told why." : "The station's agent reworks the step with your reason.",
      onOk: async (v) => {
        const r = brief ? await ops.decline(wo, v, undefined, ifm) : await ops.rejectGate(wo, gate, ap?.instance ?? a.instance, v, undefined, ifm);
        if (r.ok) ui.toast(r.msg, "ok");
        return r;
      },
    });
  const verb = gate === "G6" ? "Confirm release" : brief ? "Confirm brief" : "Approve";
  return (
    <div className="row nowrap inb-acts">
      <Btn label={verb} kind="primary" id={`inb-ok-${wo}-${gate}`} guard={base} onClick={() => void approve.run().then(() => onDone?.())} />
      <Btn label={brief ? "Decline" : "Ask for changes"} id={`inb-back-${wo}-${gate}`} guard={decideBack} onClick={back} />
      <Btn label={`Open ${wo}`} kind="ghost" id={`inb-open-${wo}-${gate}`} onClick={() => open(wo)} />
    </div>
  );
}

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

function OtherActions({ it }: { it: Extract<Item, { kind: "other" }> }) {
  const ui = useUI();
  const me = useMe();
  const open = useOpenTraveler();
  const x = it.x;
  const r = x.restore;
  const d = useCan(r?.scope === "factory" ? "restore.factory" : "restore.project", r?.scope === "project" ? { project: r.id } : {});
  const done = r?.approvals?.length ?? 0;
  const already = !!(me && r?.approvals?.some((a) => a.by === me.person.id));
  return (
    <div className="row nowrap inb-acts">
      {r && me && !d.pending && d.allowed ? (
        <Btn
          label={r.scope === "factory" ? (done ? `Approve restore (${done + 1} of ${r.needs ?? 2})` : "Restore factory") : "Restore project"}
          kind="primary" small
          id={`inb-restore-${r.scope}${r.id ? `-${r.id}` : ""}`}
          disabledReason={already ? "You approved this restore already. A second Factory Admin must approve." : null}
          onClick={() => makeStopActions(ui, me).restore(r.scope, r.id)}
        />
      ) : null}
      <Btn label={x.act.label} kind={r ? "ghost" : "primary"} small id={`inb-act-${x.id}`} onClick={() => goAttention(x.act, open)} />
    </div>
  );
}

/** The prototype's one "Review" button per row: it opens the decision with the rule, who else can decide and the approve / ask-for-changes buttons. */
function ApprovalActions({ it }: { it: Item }) {
  const ui = useUI();
  const review = () => {
    const t = titleOf(it);
    ui.dialog({
      title: t.title, kicker: it.projectName || "Factory", sub: t.sub, wide: true,
      body: (close) => it.kind === "gate" ? (<div className="stack"><GateRule wo={it.a.wo ?? ""} gate={it.a.gate ?? ""} project={it.project} /><GateActions it={it} onDone={close} /></div>) : it.kind === "other" ? <OtherActions it={it} /> : null,
      actions: [{ label: "Close" }],
    });
  };
  if (it.kind === "gate" || it.kind === "other") return <Btn label="Review" kind="primary" small id={`inb-review-${it.key}`} onClick={review} />;
  if (it.kind === "onboarding") {
    const a = it.a;
    return <Btn label={a.note ? "Open session" : "Open onboarding"} kind="primary" small id={`inb-onb-${a.repo}`} onClick={() => { if (a.project) setProject(a.project); navigate("onboarding", a.repo); }} />;
  }
  return null;
}

const titleOf = (it: Item): { title: ReactNode; sub: ReactNode; type: string; tone: string } => {
  if (it.kind === "gate") {
    const a = it.a;
    return { title: `${gatePendingTitle({ id: a.gate ?? "", name: a.gateName ?? "gate", label: a.gateLabel ?? a.gate ?? "" })} on ${a.wo}`, sub: `${a.wo} · ${a.title ?? ""}`, type: "Gate", tone: "warn" };
  }
  if (it.kind === "onboarding") {
    const a = it.a;
    return { title: a.note ? `Onboarding update: ${a.repoName}` : `Merge onboarding pull request ${a.repoName}#${a.pr}`, sub: a.note ?? "Checks are green. Sensitive files need an explicit tick in the session.", type: "Onboarding", tone: "agent" };
  }
  if (it.kind === "other") return { title: it.x.title, sub: it.x.sub, type: it.x.restore ? "Restore" : "Decision", tone: "agent" };
  return { title: "", sub: "", type: "", tone: "idle" };
};

const TYPES: Array<[string, string]> = [["gate", "Gate"], ["onboarding", "Onboarding"], ["other", "Decision / restore"]];

/** One question for a person, as a card with its answer action (prototype: a stack of cards). */
function QuestionCard({ it }: { it: Extract<Item, { kind: "question" | "stuck" }> }) {
  const c = it.c;
  const stuck = it.kind === "stuck";
  return (
    <Card id={`inb-${it.key}`} title={c.question || (stuck ? "This work order stopped and needs a person." : "Confirm the brief or answer the open question.")}>
      <div className="row" style={{ marginBottom: 12 }}>
        {stuck ? <Status tone="fail">{c.stuck!.state === "blocked" ? "Blocked" : c.stuck!.state === "parked" ? "Parked" : "Failed"}</Status> : <Chip text="Question" cls="agent" />}
        <span className="dim">about</span>
        <span className="mono">{c.wo}</span>
        <span className="dim">{c.title}</span>
        {it.projectName ? <span className="tag">{it.projectName}</span> : null}
      </div>
      <div className="row">
        {stuck ? <StuckActions c={c} /> : <Btn label="Answer" kind="primary" icon="chat" id={`inb-conv-${c.wo}`} onClick={() => { setProject(c.project); updatePrefs({ openConversation: c.wo }); navigate("conversations"); }} />}
      </div>
    </Card>
  );
}

export default function InboxView() {
  const q = useHome();
  const home = q.data as unknown as HomeFull | undefined;
  const projList = useProjects().data;
  const names = useMemo(() => new Map((projList ?? []).map((p) => [p.id, p.name] as [string, string])), [projList]);
  const items = useItems(home, names);
  const [tab, setTab] = useState<"approvals" | "questions">("approvals");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [project, setProj] = useState("all");
  const approvals = items.filter((i) => i.group === "gate" || i.group === "onboarding" || i.group === "other");
  const questions = items.filter((i): i is Extract<Item, { kind: "question" | "stuck" }> => i.kind === "question" || i.kind === "stuck");
  const projects = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) if (!m.has(i.project) || names.has(i.project)) m.set(i.project, names.get(i.project) ?? (i.projectName || i.project));
    return [...m.entries()];
  }, [items, names]);
  const needle = search.trim().toLowerCase();
  const shown = approvals.filter((i) => {
    if (type !== "all" && i.kind !== type) return false;
    if (project !== "all" && i.project !== project) return false;
    const t = titleOf(i);
    return !needle || `${String(t.title)} ${String(t.sub)} ${i.projectName}`.toLowerCase().includes(needle);
  });
  const sorted = shown.slice().sort((a, b) => (a.kind === "gate" ? 0 : 1) - (b.kind === "gate" ? 0 : 1) || b.waitMs - a.waitMs);
  return (
    <Page eyebrow="Operate" title="Inbox" sub="Everything waiting for a person: gates, proposals, questions." cls="inbox">
      <Async query={q} what="your inbox" id="inbox" isEmpty={() => false}>{() => (
        <>
          <Tabs idPrefix="inbox-tab" active={tab} onChange={(t) => setTab(t as typeof tab)} items={[{ id: "approvals", label: "Approvals", count: approvals.length }, { id: "questions", label: "Questions", count: questions.length }]} />
          <span className="sr-only" id="inbox-count">{items.length}</span>
          {tab === "approvals" ? (
            <>
              <FilterBar label="Filter approvals" count={`${shown.length} of ${approvals.length}`}>
                <SearchBox id="inbox-q" value={search} onChange={setSearch} placeholder="Search approvals" />
                <Select id="inbox-type" aria-label="Type" value={type} onChange={setType} options={[{ value: "all", label: "Type: all" }, ...TYPES.map(([v, l]) => ({ value: v, label: l }))]} />
                {projects.length > 1 ? <Select id="inb-proj" aria-label="Project" value={project} onChange={setProj} options={[{ value: "all", label: "Project: all" }, ...projects.map(([id, name]) => ({ value: id, label: name }))]} /> : <></>}
              </FilterBar>
              {approvals.length ? (
                <DataTable<Item>
                  id="t-inbox"
                  caption="Approvals waiting on you"
                  rows={sorted}
                  rowKey={(i) => i.key}
                  rowId={(i) => `inb-${i.key}`}
                  pageSize={10}
                  empty={{ title: "Nothing matches these filters", text: "Choose another type or project.", action: <Btn label="Show all" id="inbox-reset" onClick={() => { setType("all"); setProj("all"); setSearch(""); }} /> }}
                  columns={[
                    { key: "title", label: "Request", render: (i) => { const t = titleOf(i); return (<><span className="rl ell">{t.title}</span><span className="dim ell" style={{ fontSize: 12 }}>{t.sub}</span></>); } },
                    { key: "type", label: "Type", render: (i) => { const t = titleOf(i); return <Chip text={t.type} cls={t.tone} />; } },
                    { key: "project", label: "Project", render: (i) => (i.projectName ? <span className="tag">{i.projectName}</span> : <span className="dim">factory</span>) },
                    { key: "wait", label: "Waiting", sort: (i) => i.waitMs, render: (i) => <span className="mono">{i.waitMs ? fmt.dur(i.waitMs) : "—"}</span> },
                    { key: "act", label: "", align: "end", render: (i) => <ApprovalActions it={i} /> },
                  ]}
                />
              ) : (
                <div className="card"><CrEmpty icon="check" title="Inbox zero" text="Approvals you may give appear here, one row each." action={<Btn label="Go to Work orders" id="inbox-to-wo" onClick={() => navigate("work-orders")} />} /></div>
              )}
            </>
          ) : questions.length ? (
            <div className="stack">{questions.map((i) => <QuestionCard key={i.key} it={i} />)}</div>
          ) : (
            <div className="card"><CrEmpty icon="chat" title="No open questions" text="Agents will ask here when they need a decision from a person." /></div>
          )}
        </>
      )}</Async>
    </Page>
  );
}
