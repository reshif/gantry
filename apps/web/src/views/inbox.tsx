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
import { Btn, Chip, Empty, FilterBar, Panel, SearchBox, Select, Status, Table, Tabs, ViewHead, type Decision } from "../ui/primitives";
import { Async } from "../ui/async";
import { useCommand } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { navigate, useHash } from "../lib/router";
import { setProject, updatePrefs } from "../lib/prefs";
import { makeStopActions } from "../shell/stopActions";
import { useOpenTraveler } from "../shell/useTraveler";
import { useGateApprovers } from "./traveler/Approvers";
import { goAttention, type Approval, type AttentionItem, type Conversation, type HomeFull } from "./home/data";

type Group = "gate" | "onboarding" | "questions" | "stuck" | "other";
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
      {typeof a.rule.classOverride === "number" ? <p className="small muted">{`This work order's class needs ${a.rule.classOverride} instead of the gate's base ${a.rule.base}.`}</p> : null}
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

function GateItem({ it }: { it: Extract<Item, { kind: "gate" }> }) {
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
  const [more, setMore] = useState(false);
  const id = `inb-${it.key}`;
  return (
    <>
      <tr id={id} aria-label={`${gatePendingTitle({ id: gate, name: a.gateName ?? "gate", label: a.gateLabel ?? gate })} on ${wo}`}>
        <td className="pri-cell" data-l="Work order">
          <div className="mono">{wo}</div>
          <span className="sub small muted">{a.title ?? ""}</span>
        </td>
        <td data-l="Gate"><Chip text={a.gateLabel ?? gate} cls="warn" /><span className="sub small muted">{gatePendingTitle({ id: gate, name: a.gateName ?? "gate", label: a.gateLabel ?? gate })}</span></td>
        <td data-l="Project">{it.projectName}</td>
        <td data-l="Waiting">{a.waitMs ? `${fmt.dur(a.waitMs)} ago` : "now"}</td>
        <td className="r" data-l="">
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Btn label={verb} small kind="primary" id={`inb-ok-${wo}-${gate}`} guard={base} onClick={() => void approve.run()} />
            <Btn label={brief ? "Decline" : "Ask for changes"} small kind="danger" id={`inb-back-${wo}-${gate}`} guard={decideBack} onClick={back} />
            <Btn label="Open" aria={`Open ${wo}`} small kind="ghost" id={`inb-open-${wo}-${gate}`} onClick={() => open(wo)} />
            <Btn label={more ? "Hide details" : "Show details"} small kind="ghost" aria-pressed={more} id={`${id}-details`} onClick={() => setMore(!more)} />
          </div>
        </td>
      </tr>
      {more ? <tr><td colSpan={5}><GateRule wo={wo} gate={gate} project={it.project} /></td></tr> : null}
    </>
  );
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
    <Row
      id={`inb-${it.key}`}
      tag="Question"
      project={it.projectName}
      title={c.question || "Confirm the brief or answer the open question."}
      sub={`${c.wo} · ${c.title}`}
      status={<Status tone="wait">Waiting</Status>}
      actions={<Btn label="Answer" kind="primary" icon="chat" id={`inb-conv-${c.wo}`} onClick={() => { setProject(c.project); updatePrefs({ openConversation: c.wo }); navigate("conversations"); }} />}
    />
  );
}

/** A failed, blocked or parked work order: the reason, and the actions the server allows this person (retry, assign). */
function StuckItem({ it }: { it: Extract<Item, { kind: "stuck" }> }) {
  const open = useOpenTraveler();
  const c = it.c;
  const s = c.stuck!;
  const q = useTravelerWo(c.wo);
  const t = q.data;
  const ifm = t ? { ifMatch: t.version } : undefined;
  const retry = useCommand(() => ops.retry(c.wo, undefined, ifm), {});
  const guard: Decision = !t ? CHECKING : dec(t, "sendback");
  return (
    <Row
      id={`inb-${it.key}`}
      tag="Needs a person"
      project={it.projectName}
      title={c.question || "This work order stopped and needs a person."}
      sub={`${c.wo} · ${c.title}`}
      status={<Status tone="fail">{s.state === "blocked" ? "Blocked" : s.state === "parked" ? "Parked" : "Failed"}</Status>}
      actions={
        <>
          {s.actions.includes("retry") ? <Btn label="Retry" kind="primary" icon="refresh" id={`inb-retry-${c.wo}`} guard={guard} onClick={() => void retry.run()} /> : null}
          <Btn label={s.actions.includes("assign") ? "Open to assign an agent" : `Open ${c.wo}`} kind="ghost" id={`inb-open-${c.wo}`} onClick={() => open(c.wo)} />
        </>
      }
    />
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

const TABS: Array<{ id: string; label: string; groups: Group[]; title: string; hint: string; empty: string }> = [
  { id: "approvals", label: "Approvals", groups: ["gate", "onboarding"], title: "Waiting for a decision", hint: "Longest wait first. Approve, or send it back with what must change. The rule and who else can decide are on every row.", empty: "No approvals waiting. Gate requests appear here as agents finish their work." },
  { id: "questions", label: "Questions", groups: ["questions"], title: "Agents are asking", hint: "Agents ask in the work order's one conversation. Answer there.", empty: "No open questions. Agents will ask here when they need information." },
  { id: "blocked", label: "Blocked", groups: ["stuck"], title: "Blocked or failed", hint: "A station failed or could not start, so nothing is working on it. Retry it, or open it to assign another agent.", empty: "Nothing is blocked. The line is flowing." },
  { id: "proposals", label: "Proposals", groups: ["other"], title: "Other decisions", hint: "Proposals and restores that need a person. A factory restore appears here while the factory is stopped.", empty: "Nothing else is waiting." },
];

export default function InboxView() {
  const q = useHome();
  const home = q.data as unknown as HomeFull | undefined;
  const projList = useProjects().data;
  const names = useMemo(() => new Map((projList ?? []).map((p) => [p.id, p.name] as [string, string])), [projList]);
  const items = useItems(home, names);
  const param = useHash().param;
  const tab = TABS.find((t) => t.id === param) ?? TABS[0]!;
  const [project, setProj] = useState("all");
  const [search, setSearch] = useState("");
  const inTab = (t: (typeof TABS)[number]) => items.filter((i) => t.groups.includes(i.group));
  const projects = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) if (!m.has(i.project) || names.has(i.project)) m.set(i.project, names.get(i.project) ?? (i.projectName || i.project));
    return [...m.entries()];
  }, [items, names]);
  const needle = search.trim().toLowerCase();
  const textOf = (i: Item): string => (i.kind === "gate" || i.kind === "onboarding" ? `${i.a.wo ?? ""} ${i.a.title ?? ""} ${i.a.repoName ?? ""} ${i.projectName}` : i.kind === "other" ? `${i.x.title} ${i.x.sub}` : `${i.c.wo} ${i.c.title} ${i.c.question ?? ""}`).toLowerCase();
  const shown = inTab(tab).filter((i) => (project === "all" || i.project === project) && (!needle || textOf(i).includes(needle)));
  const gates = shown.filter((i): i is Extract<Item, { kind: "gate" }> => i.kind === "gate");
  const others = shown.filter((i) => i.kind !== "gate");
  const render = (i: Item): ReactNode =>
    i.kind === "onboarding" ? <OnboardingItem key={i.key} it={i} /> : i.kind === "question" ? <QuestionItem key={i.key} it={i} /> : i.kind === "stuck" ? <StuckItem key={i.key} it={i} /> : i.kind === "other" ? <OtherItem key={i.key} it={i} /> : null;
  return (
    <div className="view inbox">
      <ViewHead title="Inbox" sub="Everything that is waiting for a person, in one place. Decide right here." />
      <Async query={q} what="your inbox" id="inbox" isEmpty={() => false}>{() =>
        !items.length ? (
          <Empty id="inbox-empty" icon="mail" title="Nothing is waiting on you" text="Approvals you may give and questions addressed to you appear here, one row each." action={<Btn label="Go to Work orders" id="inbox-to-wo" onClick={() => navigate("work-orders")} />} />
        ) : (
          <>
            <Tabs idPrefix="inbox-tab" active={tab.id} onChange={(id) => navigate("inbox", id === "approvals" ? null : id)} items={TABS.map((t) => ({ id: t.id, label: t.label, count: inTab(t).length }))} />
            <span className="sr" id="inbox-count">{String(items.length)}</span>
            <Panel title={tab.title} flush id={`inbox-${tab.id}`}>
              {inTab(tab).length ? (
                <>
                  <FilterBar count={`${shown.length} of ${inTab(tab).length}`}>
                    <SearchBox id="inbox-search" value={search} onChange={setSearch} placeholder="Search…" label="Search the inbox" />
                    {projects.length > 1 ? (
                      <label htmlFor="inb-proj">
                        <span>Project</span>
                        <Select id="inb-proj" options={[{ value: "all", label: "All" }, ...projects.map(([id, name]) => ({ value: id, label: name }))]} value={project} onChange={setProj} />
                      </label>
                    ) : null}
                  </FilterBar>
                  {!shown.length ? (
                    <Empty icon="filter" title="Nothing matches these filters" text="Choose another project or search." action={<Btn label="Show all" id="inbox-reset" onClick={() => { setSearch(""); setProj("all"); }} />} />
                  ) : (
                    <>
                      {gates.length ? (
                        <Table className="cards">
                          <thead><tr><th>Work order</th><th>Gate</th><th>Project</th><th>Waiting</th><th /></tr></thead>
                          <tbody>{gates.map((i) => <GateItem key={i.key} it={i} />)}</tbody>
                        </Table>
                      ) : null}
                      {others.length ? <ul className="list">{others.map(render)}</ul> : null}
                    </>
                  )}
                </>
              ) : (
                <Empty id={`inbox-${tab.id}-empty`} title={tab.empty.split(". ")[0] ?? tab.empty} text={tab.empty.split(". ").slice(1).join(". ") || tab.hint} />
              )}
            </Panel>
          </>
        )
      }</Async>
    </div>
  );
}
