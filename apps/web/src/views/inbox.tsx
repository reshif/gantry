/**
 * Inbox (#inbox): everything that waits for this person, in one list, decided right here. The list is the "waiting on you" part of
 * GET /home: gate approvals (with the rule and who else can decide), onboarding merges, questions agents asked, and the other decisions
 * the server puts in front of this person (trust, learning, MCP and trigger proposals, a factory restore). Every decision is a command the server checks (approver rules, separation of duties).
 */
import { useMemo, useState, type ReactNode } from "react";
import { fmt } from "@gantry/domain";
import { ops } from "../api/ops";
import { useHome, useMe, useProjects } from "../api/queries";
import { dec, useTravelerWo } from "./traveler/model";
import { useCan } from "../api/can";
import { Btn, Empty, Field, Segmented, Select, Status, ViewHead, type Decision } from "../ui/primitives";
import { Async } from "../ui/async";
import { useCommand } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { navigate } from "../lib/router";
import { setProject, updatePrefs } from "../lib/prefs";
import { makeStopActions } from "../shell/stopActions";
import { useOpenTraveler } from "../shell/useTraveler";
import { useGateApprovers } from "./traveler/Approvers";
import { goAttention, type Approval, type AttentionItem, type Conversation, type HomeFull } from "./home/data";

type Group = "gate" | "onboarding" | "questions" | "other";
type Item =
  | { kind: "gate"; group: "gate"; key: string; project: string; projectName: string; waitMs: number; a: Approval }
  | { kind: "onboarding"; group: "onboarding"; key: string; project: string; projectName: string; waitMs: number; a: Approval }
  | { kind: "question"; group: "questions"; key: string; project: string; projectName: string; waitMs: number; c: Conversation }
  | { kind: "other"; group: "other"; key: string; project: string; projectName: string; waitMs: number; x: AttentionItem };

/** Attention items that are decisions for this person, rather than health to look at: a restore, and proposals on the governance pages. */
const DECISION_ROUTES = new Set(["trust", "learning", "mcp", "api", "integrations"]);
const isDecision = (x: AttentionItem): boolean => !!x.restore || DECISION_ROUTES.has(x.act.route);

const GROUPS: Array<{ id: Group; label: string; title: string; hint: string; empty: string }> = [
  { id: "gate", label: "Gate approvals", title: "Gate approvals", hint: "Longest wait first. Approve, or send it back with what must change. The rule and who else can decide are shown on every row.", empty: "No gate approvals waiting." },
  { id: "onboarding", label: "Onboarding", title: "Onboarding approvals", hint: "Pull requests that wire a repo into Gantry. Open the onboarding session to review the files before the merge.", empty: "No onboarding merges waiting." },
  { id: "questions", label: "Questions", title: "Questions for you", hint: "Agents ask in the work order's one conversation. Answer there.", empty: "No open questions." },
  { id: "other", label: "Other decisions", title: "Other decisions", hint: "Proposals and restores that need a person. A factory restore appears here while the factory is stopped.", empty: "Nothing else is waiting." },
];

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
    for (const c of s.waiting?.conversations ?? []) out.push({ kind: "question", group: "questions", key: `q-${c.wo}`, project: c.project, projectName: projectNames.get(c.project) ?? "", waitMs: 0, c });
    for (const x of s.attention ?? []) if (isDecision(x)) out.push({ kind: "other", group: "other", key: x.id, project: x.act.project ?? "factory", projectName: x.where, waitMs: 0, x });
    return out.sort((p, q) => q.waitMs - p.waitMs);
  }, [home, names]);
}

function Row({ id, tag, project, title, sub, status, children, details, actions }: { id: string; tag: string; project: string; title: ReactNode; sub: ReactNode; status?: ReactNode; children?: ReactNode; details?: ReactNode; actions?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="inb-row" id={id} aria-label={typeof title === "string" ? title : undefined}>
      <div className="inb-top">
        <div className="inb-main">
          <div className="inb-meta">
            <span className="chip chip-accent">{tag}</span>
            {project ? <span className="muted small">{project}</span> : null}
          </div>
          <h3 className="inb-title">{title}</h3>
          <p className="muted small inb-sub">{sub}</p>
          <div className="inb-links">
            {children}
            {details ? <Btn label={open ? "Hide details" : "Show details"} small kind="ghost" aria-pressed={open} id={`${id}-details`} onClick={() => setOpen(!open)} /> : null}
          </div>
        </div>
        {status ? <div className="inb-status">{status}</div> : null}
      </div>
      {open && details ? <div className="inb-details">{details}</div> : null}
      {actions ? <div className="inb-actions">{actions}</div> : null}
    </article>
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
  return (
    <Row
      id={`inb-${it.key}`}
      tag="Gate approval"
      project={it.projectName}
      title={`${a.gateName ?? "Gate"} · ${a.gateLabel ?? gate} on ${wo}`}
      sub={`${wo} · ${a.title ?? ""}${a.waitMs ? ` · waiting ${fmt.dur(a.waitMs)}` : ""}`}
      status={<Status tone="wait">Waiting</Status>}
      details={<GateRule wo={wo} gate={gate} project={it.project} />}
      actions={
        <>
          <Btn label={verb} kind="primary" icon="check" id={`inb-ok-${wo}-${gate}`} guard={base} onClick={() => void approve.run()} />
          <Btn label={brief ? "Decline" : "Ask for changes"} icon={brief ? "x" : "undo"} id={`inb-back-${wo}-${gate}`} guard={decideBack} onClick={back} />
        </>
      }
    >
      <Btn label={`Open ${wo}`} small kind="ghost" id={`inb-open-${wo}-${gate}`} onClick={() => open(wo)} />
    </Row>
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

export default function InboxView() {
  const q = useHome();
  const home = q.data as unknown as HomeFull | undefined;
  const projList = useProjects().data;
  const names = useMemo(() => new Map((projList ?? []).map((p) => [p.id, p.name] as [string, string])), [projList]);
  const items = useItems(home, names);
  const [group, setGroup] = useState<"all" | Group>("all");
  const [project, setProj] = useState("all");
  const count = (g: Group | "all") => items.filter((i) => g === "all" || i.group === g).length;
  const projects = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) if (!m.has(i.project) || names.has(i.project)) m.set(i.project, names.get(i.project) ?? (i.projectName || i.project));
    return [...m.entries()];
  }, [items, names]);
  const shown = items.filter((i) => (group === "all" || i.group === group) && (project === "all" || i.project === project));
  const render = (i: Item): ReactNode =>
    i.kind === "gate" ? <GateItem key={i.key} it={i} /> : i.kind === "onboarding" ? <OnboardingItem key={i.key} it={i} /> : i.kind === "question" ? <QuestionItem key={i.key} it={i} /> : <OtherItem key={i.key} it={i} />;
  return (
    <div className="view inbox">
      <ViewHead title="Inbox" sub="Everything that waits for you, in one list. Decide right here." />
      <Async query={q} what="your inbox" id="inbox" isEmpty={() => false}>{() =>
        !items.length ? (
          <Empty id="inbox-empty" icon="mail" title="Nothing is waiting on you" text="Approvals you may give and questions addressed to you appear here, one row each." action={<Btn label="Go to Work orders" id="inbox-to-wo" onClick={() => navigate("work-orders")} />} />
        ) : (
          <div className="inb-stack">
            <div className="inb-bar">
              <h2 className="panel-title">Waiting on you <span className="chip chip-accent mono" id="inbox-count">{count("all")}</span></h2>
              <div className="inb-filters">
                <Segmented name="inb-type" label="Filter by type" value={group} onChange={(v) => setGroup(v as "all" | Group)} items={[{ id: "all", label: `All ${count("all")}` }, ...GROUPS.map((g) => ({ id: g.id, label: `${g.label} ${count(g.id)}` }))]} />
                {projects.length > 1 ? (
                  <div className="filters">
                    <Field label="Project" htmlFor="inb-proj">
                      <Select id="inb-proj" options={[{ value: "all", label: "All projects" }, ...projects.map(([id, name]) => ({ value: id, label: name }))]} value={project} onChange={setProj} />
                    </Field>
                  </div>
                ) : null}
              </div>
            </div>
            {!shown.length ? (
              <Empty icon="filter" title="Nothing matches these filters" text="Choose another type or project." action={<Btn label="Show all" id="inbox-reset" onClick={() => { setGroup("all"); setProj("all"); }} />} />
            ) : (
              GROUPS.filter((g) => group === "all" || group === g.id).map((g) => {
                const rows = shown.filter((i) => i.group === g.id);
                return (
                  <section key={g.id} className="inb-sec" aria-labelledby={`inb-h-${g.id}`}>
                    <h2 className="panel-title" id={`inb-h-${g.id}`}>{g.title} <span className="muted num">{rows.length}</span></h2>
                    <p className="muted small inb-hint">{g.hint}</p>
                    {rows.length ? <div className="inb-list">{rows.map(render)}</div> : <p className="muted small">{g.empty}</p>}
                  </section>
                );
              })
            )}
          </div>
        )
      }</Async>
    </div>
  );
}
