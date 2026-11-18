/** The sections of Home. Each renders only what the API put in `home.sections` (built by the caller's rights); none checks a role. */
import { useEffect, useState, type ReactNode } from "react";
import { WO_STATES, fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { useMe } from "../../api/queries";
import { plural } from "../../lib/plural";
import { hasCommand, runCommand } from "../../lib/commands";
import { navigate } from "../../lib/router";
import { setProject, updatePrefs } from "../../lib/prefs";
import { Btn, Chip, Meter, Panel, Status } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { makeStopActions } from "../../shell/stopActions";
import { useOpenTraveler } from "../../shell/useTraveler";
import { ClassChip, HealthChip, MiniBelt, classOf, goProject, metricsOf, useCatalog, type PView } from "../projects/kit";
import { goAttention, STAGE_NAME, type Approval, type AttentionItem, type Conversation, type HomeSections, type MineWo, type SetupStep } from "./data";

/** From Home to the New project wizard on the Projects screen, once that screen has mounted and registered it. */
export function openNewProject(): void {
  navigate("projects");
  let tries = 0;
  const t = setInterval(() => {
    tries += 1;
    if (hasCommand("newProject")) {
      clearInterval(t);
      runCommand("newProject");
    } else if (tries > 40) clearInterval(t);
  }, 50);
}

/** A Home section is one titled card. `id` stays on the wrapper so the page can link to it. */
function Section({ id, title, count, tools, cls = "", flush, children }: { id: string; title: string; count?: number | undefined; tools?: ReactNode; cls?: string; flush?: boolean; children: ReactNode }) {
  return (
    <div id={id} className={`hm-sec ${cls}`}>
      <Panel title={<>{title}{count !== undefined ? <span className="hm-count">{count}</span> : null}</>} tools={tools} flush={!!flush}>
        {children}
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------ attention */

const SEV = [{ id: "crit", label: "Critical" }, { id: "high", label: "High" }, { id: "watch", label: "Watch" }] as const;
const SHOWN = 5;

/** Restore for a killed scope, only for people who may (no locked copy for anyone else). */
export function RestoreAction({ item, startLabel, small = true }: { item: AttentionItem; startLabel?: string; small?: boolean }) {
  const ui = useUI();
  const me = useMe();
  const r = item.restore!;
  const d = useCan(r.scope === "factory" ? "restore.factory" : "restore.project", r.scope === "project" ? { project: r.id } : {});
  if (!me || d.pending || !d.allowed) return null;
  const done = r.approvals?.length ?? 0;
  const already = !!r.approvals?.some((a) => a.by === me.person.id);
  const label = r.scope === "factory" ? (done ? `Approve restore (${done + 1} of ${r.needs ?? 2})` : (startLabel ?? "Restore factory")) : (startLabel ?? "Restore project");
  return (
    <Btn
      label={label} small={small} kind={small ? "primary" : undefined} id={`hm-restore-${r.scope}${r.id ? `-${r.id}` : ""}`} aria={`${label}: ${item.title}`}
      disabledReason={already ? "You approved this restore already. A second Factory Admin must approve." : null}
      onClick={() => makeStopActions(ui, me).restore(r.scope, r.id)}
    />
  );
}

export function AttentionStrip({ items }: { items: AttentionItem[] }) {
  const [all, setAll] = useState(false);
  const openTraveler = useOpenTraveler();
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, SHOWN);
  const crit = items.filter((x) => x.sev === 0).length;
  return (
    <Section id="hm-attention" title="Needs attention" count={items.length} flush tools={items.length > SHOWN ? <Btn label={all ? `Show the top ${SHOWN}` : `Show all ${items.length}`} small kind="ghost" id="hm-att-more" aria={all ? undefined : `Show all ${plural(items.length, "attention item")}`} onClick={() => setAll(!all)} /> : null}>
      {crit ? <p className="sr" role="status">{`${plural(crit, "critical item")}.`}</p> : null}
      <ol className="hm-att">
        {shown.map((x) => {
          const s = SEV[x.sev];
          return (
            <li key={x.id} className={`hm-att-item hm-sev-${s.id}`}>
              <span className="hm-att-ic" title={s.label}><Icon name={x.icon} /></span>
              <div className="hm-att-main">
                <div className="hm-att-t"><span className="sr">{s.label + ": "}</span>{x.title}</div>
                <div className="muted small hm-att-w">{x.where + " · " + x.sub}</div>
              </div>
              <div className="hm-att-acts">
                {x.restore ? <RestoreAction item={x} /> : null}
                <Btn label={x.act.label} small kind="ghost" id={x.id} aria={`${x.act.label} for ${x.title}`} onClick={() => goAttention(x.act, openTraveler)} />
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

/* ------------------------------------------------------- waiting on you */

function ApprovalRow({ a }: { a: Approval }) {
  const ui = useUI();
  const open = useOpenTraveler();
  if (a.repo) {
    return (
      <li className="hm-my-row">
        <Icon name="rocket" className="hm-my-ic" />
        <div className="hm-my-main">
          <div>{a.note ? `Onboarding update: ${a.repoName}` : `Merge onboarding PR ${a.repoName}#${a.pr}`}</div>
          <div className="muted small">{a.note ? `${a.projectName} · ${a.note}` : `${a.projectName} · checks green`}</div>
        </div>
        <Btn label={a.note ? "Open session" : "Open onboarding"} small id={`hm-my-onb-${a.repo}`} aria={`${a.note ? "Open session" : "Open onboarding"} for ${a.repoName}`} onClick={() => { if (a.project) setProject(a.project); navigate("onboarding", a.repo); }} />
      </li>
    );
  }
  const wo = a.wo ?? "";
  const gate = a.gate ?? "";
  const approve = async () => {
    const r = await ops.approveGate(wo, gate, a.instance);
    ui.toast(r.msg, r.ok ? "ok" : "error");
  };
  const verb = gate === "G6" ? "Confirm release" : "Approve";
  return (
    <li className="hm-my-row">
      <span className="gate gate-waiting gate-sm" aria-label={`${a.gateName} (${a.gateLabel}): waiting on approvers`}>
        <span className="gate-shape" aria-hidden="true"><span className="gate-count">{String(a.need !== undefined ? Math.max(1, a.need - (a.have ?? 0)) : 1)}</span></span>
      </span>
      <div className="hm-my-main">
        <div><span className="mono">{wo}</span>{" · " + a.gateName + " · " + a.gateLabel}</div>
        <div className="muted small">{`${a.title} · ${a.projectName}${a.need !== undefined ? ` · ${a.have ?? 0} of ${plural(a.need, "approval")}` : ""}${a.waitMs ? ` · waiting ${fmt.dur(a.waitMs)}` : ""}`}</div>
      </div>
      <div className="hm-my-acts">
        <Btn label="Review" small kind="ghost" id={`hm-my-open-${wo}-${gate}`} aria={`Review ${wo} at ${a.gateLabel}`} onClick={() => open(wo)} />
        {gate === "G0G1" ? null : <Btn label={verb} small kind="primary" id={`hm-my-ok-${wo}-${gate}`} aria={`${verb} ${wo} at ${a.gateLabel}`} onClick={() => void approve()} />}
      </div>
    </li>
  );
}

export function WaitingOnYou({ approvals, conversations }: { approvals: Approval[]; conversations: Conversation[] }) {
  const total = approvals.length + conversations.length;
  const sorted = approvals.slice().sort((a, b) => (b.waitMs ?? 0) - (a.waitMs ?? 0));
  return (
    <Section id="hm-waiting" title="Waiting on you" count={total} flush={total > 0} tools={total ? <Btn label="Open Inbox" small kind="ghost" id="hm-open-inbox" onClick={() => navigate("inbox")} /> : undefined}>
      {total ? (
        <ul className="hm-my-list">
          {sorted.map((a) => <ApprovalRow key={`${a.wo ?? a.repo}-${a.gate ?? ""}-${a.note ? "n" : ""}`} a={a} />)}
          {conversations.map((w) => (
            <li key={w.wo} className="hm-my-row">
              <Icon name="chat" className="hm-my-ic" />
              <div className="hm-my-main">
                <div><span className="mono">{w.wo}</span>{" · " + w.title}</div>
                <div className="muted small">{w.question || "Confirm the brief or answer the open question."}</div>
              </div>
              <Btn label={w.stuck ? "Open" : "Answer"} small kind="primary" id={`hm-my-conv-${w.wo}`} aria={`${w.stuck ? "Open" : "Answer the question on"} ${w.wo}`} onClick={() => { setProject(w.project); updatePrefs({ openConversation: w.wo }); navigate("conversations"); }} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted hm-quiet">Nothing is waiting on you.</p>
      )}
    </Section>
  );
}

/** The Auditor's read-only view of the human bottleneck: who the factory is waiting on, never a button that decides. */
export function ApproversWatch({ data }: { data: NonNullable<HomeSections["approvers"]> }) {
  return (
    <Section id="hm-approvers" title="Waiting on approvers" count={data.count} flush={data.count > 0}>
      {data.count ? (
        <>
          <p className="small hm-pad">{`Oldest ${fmt.dur(data.oldestMs)}${data.late ? ` · ${data.late} past SLA` : ""}.`}</p>
          <ul className="hm-my-list">
            {data.byProject.map((p) => (
              <li key={p.id} className="hm-my-row hm-plain-row">
                <span className="hm-my-main">{p.name}</span>
                <span className="muted small">{`${plural(p.count, "gate")} · oldest ${fmt.dur(p.oldestMs)}`}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted hm-quiet">No gate is waiting on an approver.</p>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------ set up */

export function SetupChecklist({ setup }: { setup: NonNullable<HomeSections["setup"]> }) {
  const create = useCan("project.create");
  const go = (s: SetupStep): void => {
    if (s.id === "project") return openNewProject();
    if (s.id === "work-order" && hasCommand("newWorkOrder")) return void runCommand("newWorkOrder");
    if (s.project) setProject(s.project);
    navigate(s.route);
  };
  const label: Record<SetupStep["id"], string> = { github: "Connect", vendor: "Add a vendor", project: "New project", repo: "Open onboarding", "work-order": "New work order" };
  return (
    <Section id="hm-setup" title="Set up the factory" tools={<span className="muted small">{`${setup.done} of ${setup.total} done`}</span>} cls="hm-setup" flush>
      <ol className="hm-steps">
        {setup.steps.map((s, i) => (
          <li key={s.id} className={`hm-step is-${s.state}`} {...(s.state === "active" ? { "aria-current": "step" as const } : {})}>
            <span className="hm-step-n mono" aria-hidden="true">{s.state === "done" ? <Icon name="check" /> : String(i + 1)}</span>
            <div className="hm-step-main">
              <div className="hm-step-t">{s.label}{s.state === "done" ? <span className="sr"> (done)</span> : null}</div>
              {s.detail && s.state !== "done" ? <div className="muted small">{s.detail}</div> : null}
            </div>
            {s.state === "active" ? <Btn label={label[s.id]} small kind="primary" id={`hm-setup-${s.id}`} aria={`${label[s.id]}: ${s.label}`} {...(s.id === "project" ? { guard: create } : {})} onClick={() => go(s)} /> : null}
          </li>
        ))}
      </ol>
    </Section>
  );
}

/* --------------------------------------------------------- in motion */

function Token({ w, p }: { w: MineWo; p?: PView | undefined }) {
  const open = useOpenTraveler();
  const cat = useCatalog();
  const glyph = (WO_STATES as Record<string, { glyph: string; label: string }>)[w.state] ?? { glyph: "dots", label: w.state };
  const note = w.state === "running" ? null : w.state === "waiting" ? "waiting on a gate" : w.state === "parked" ? w.bayName ?? "Parked" : w.state === "killed" ? "Killed" : w.state === "blocked" ? "Blocked" : w.state === "failed" ? "Check failed" : w.state === "done" ? "Shipped" : "";
  return (
    <button type="button" className={`tok tok-${w.state}`} id={`hm-tok-${w.id}`} data-wo={w.id} aria-label={`${w.id}, ${w.title}, ${glyph.label}${note ? `, ${note}` : ""}`} onClick={() => open(w.id)}>
      <span className="tok-top">
        <Icon name={glyph.glyph} className="tok-glyph" />
        <span className="mono tok-id">{w.id}</span>
      </span>
      <span className="tok-title">{w.title}</span>
      <span className={`tok-foot${w.state === "running" ? "" : " has-note"}`}>
        {cat && p ? <ClassChip cls={classOf(cat, p, w.cls)} small /> : null}
        <span className="tok-note">{note}</span>
      </span>
    </button>
  );
}

export function InMotion({ motion, projects }: { motion: NonNullable<HomeSections["motion"]>; projects: PView[] }) {
  const cat = useCatalog();
  const open = useOpenTraveler();
  const m = motion;
  // The belt is the sum of the visible projects' stations: derived from the numbers the Projects list already carries.
  const counts: Record<string, { n: number; blocked: number }> = {};
  for (const p of projects) for (const [k, v] of Object.entries(metricsOf(p).byPosition)) {
    const c = (counts[k] ??= { n: 0, blocked: 0 });
    c.n += v.n;
    c.blocked += v.blocked;
  }
  const stations = cat?.stations ?? [];
  const nonEmpty = stations.filter((s) => (counts[s.id]?.n ?? 0) > 0);
  const delta = m.shippedWeek - m.shippedPrevWeek;
  return (
    <Section id="hm-motion" cls="hm-motion" title="In motion" tools={<a href="#floor" className="btn btn-sm btn-ghost" id="hm-open-floor">Open Floor</a>}>
      {m.inFlight ? (
        <>
          <p className="hm-motion-line">{`${plural(m.inFlight, "work order")} in flight · ${m.running} running${m.inBays ? ` · ${m.inBays} in bays` : ""}`}</p>
          {cat ? (
            <>
              <div className="hm-belt"><MiniBelt cat={cat} project={null} counts={counts} labels /></div>
              <ul className="hm-belt-list" aria-label="Work in flight by station">
                {nonEmpty.map((s) => <li key={s.id}><span>{s.name}</span><span className="mono">{String(counts[s.id]?.n ?? 0)}</span></li>)}
              </ul>
            </>
          ) : null}
        </>
      ) : (
        <p className="muted hm-quiet">No work orders in flight. They appear here once a repo is Ready and work is submitted.</p>
      )}
      {m.shippedWeek || m.shippedToday ? (
        <p className="hm-shipped"><b>Shipped</b> <span>{`${m.shippedToday} today, ${m.shippedWeek} this week`}</span>{m.shippedPrevWeek ? <Status tone={delta >= 0 ? "done" : "wait"}>{`${delta >= 0 ? "+" : "-"}${Math.abs(delta)} vs previous week`}</Status> : null}</p>
      ) : null}
      {m.recentDone.length ? (
        <p className="small hm-recent">
          <span className="hm-lbl">Recently done </span>
          {m.recentDone.map((w, i) => (
            <span key={w.id}>
              {i ? ", " : ""}
              <button type="button" className="linkish mono" id={`hm-done-${w.id}`} aria-label={`Open ${w.id}, ${w.title}`} onClick={() => open(w.id)}>{w.id}</button>
            </span>
          ))}
        </p>
      ) : null}
      {m.mine.length ? (
        <div className="hm-mine">
          <div className="hm-lbl">Your work orders</div>
          <div className="hm-my-toks">
            {m.mine.map((w) => (
              <div key={w.id} className="hm-my-tok">
                <Token w={w} p={projects.find((x) => x.id === w.project)} />
                <div className="small muted">{`${w.projectName} · ${w.bay ? w.bayName ?? w.bay : w.station}`}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Section>
  );
}

/* ---------------------------------------------------------- projects */

const WORST: Record<string, number> = { killed: 0, halted: 1, attention: 2, onboarding: 3, new: 4, ok: 5, archived: 6 };
const LIMIT = 6;

/** The projects a person works in, as cards in a grid: worst health first. The grid sits on the page, each card is the card. */
export function ProjectsSummary({ rows, projects, factoryWide, readOnlyNote }: { rows: NonNullable<HomeSections["projects"]>; projects: PView[]; factoryWide: boolean; readOnlyNote: boolean }) {
  const cat = useCatalog();
  const list = rows
    .map((r) => ({ r, p: projects.find((p) => p.id === r.id) }))
    .filter((x): x is { r: (typeof rows)[number]; p: PView } => !!x.p)
    .sort((a, b) => (WORST[metricsOf(a.p).health.id] ?? 9) - (WORST[metricsOf(b.p).health.id] ?? 9) || a.p.name.localeCompare(b.p.name));
  if (!list.length) return null;
  return (
    <section className="hm-projects" id="hm-projects" aria-labelledby="hm-projects-h">
      <div className="hm-projects-head">
        <h2 className="panel-title" id="hm-projects-h">{factoryWide ? "Projects" : "My projects"}<span className="hm-count">{list.length}</span></h2>
        <a href="#projects" className="btn btn-sm btn-ghost" id="hm-all-projects">All projects</a>
      </div>
      {readOnlyNote ? <p className="callout hm-viewonly"><Icon name="info" /><span><b>View only. </b>You can view these projects. Ask a Project Admin for more access.</span></p> : null}
      <ul className="hm-proj-grid">
        {list.slice(0, LIMIT).map(({ r, p }) => (
          <li key={p.id} className={`hm-proj hk-card-${metricsOf(p).health.id}`}>
            <div className="hm-proj-head">
              <div className="hm-proj-name"><span className="mono hm-key">{p.key}</span><h3>{p.name}</h3></div>
              <HealthChip p={p} />
            </div>
            {r.repos.length ? <p className="small hm-proj-onb">{r.repos.map((x) => `${x.name}: ${(STAGE_NAME[x.stage] ?? x.stage).toLowerCase()}`).join(" · ")}</p> : metricsOf(p).health.detail ? <p className="small hm-proj-detail">{metricsOf(p).health.detail}</p> : null}
            {r.roles.length ? <p className="small hm-proj-roles"><span className="hm-lbl">Your roles here </span>{r.roles.map((x) => <Chip key={x.id} text={x.name} cls="chip-accent" />)}</p> : null}
            {cat && !r.repos.length ? <MiniBelt cat={cat} project={p} counts={metricsOf(p).byPosition} onStation={() => goProject(p.id, "floor")} /> : null}
            <div className="hm-proj-actions">
              {r.repos.length ? <Btn label="Open onboarding" small kind="primary" id={`hm-proj-onb-${p.id}`} aria={`Open onboarding for ${p.name}`} onClick={() => goProject(p.id, "onboarding")} /> : <Btn label="Floor" small icon="belt" id={`hm-my-floor-${p.id}`} aria={`Open the floor for ${p.name}`} onClick={() => goProject(p.id, "floor")} />}
              <Btn label="Work orders" small kind="ghost" id={`hm-my-wos-${p.id}`} aria={`Work orders in ${p.name}`} onClick={() => goProject(p.id, "work-orders")} />
            </div>
          </li>
        ))}
      </ul>
      {list.length > LIMIT ? <p className="small muted hm-more">{`${list.length - LIMIT} more on the `}<a href="#projects" className="linkish">Projects page</a>.</p> : null}
    </section>
  );
}

/* ----------------------------------------------------- factory health */

const OPEN_KEY = "gantry.home.health.open";
const readOpen = (): boolean => {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
};

export function FactoryHealth({ health }: { health: NonNullable<HomeSections["health"]> }) {
  const [open, setOpen] = useState(readOpen);
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      /* private window: the state just is not remembered */
    }
  }, [open]);
  const { spend, evals } = health;
  const bad = evals?.failing.length ?? 0;
  const summary = `${spend.spent > 0 ? `${fmt.money0(spend.spent)} of ${fmt.money0(spend.budget)} this month` : "No spend yet"}${evals ? ` · ${evals.passing} of ${evals.scored} live agent versions pass evals` : ""}`;
  return (
    <section className="panel hm-health" id="hm-health" aria-labelledby="hm-health-h">
      <h2 className="panel-title hm-health-h" id="hm-health-h">
        <button type="button" className="hm-health-toggle" id="hm-health-toggle" aria-expanded={open} aria-controls="hm-health-body" onClick={() => setOpen(!open)}>
          <Icon name="chevron" className={open ? "hm-chev is-open" : "hm-chev"} />
          <span>Factory health</span>
          {open ? null : <span className="muted small hm-health-sum">{summary}</span>}
        </button>
      </h2>
      {open ? (
        <div className="hm-health-body" id="hm-health-body">
          <div className="hm-health-cols">
            <div className="hm-health-row">
              <div className="sub-h">Spend this month</div>
              {spend.spent > 0 ? (
                <>
                  <div>{`${fmt.money0(spend.spent)} of ${fmt.money0(spend.budget)}`}{spend.budget ? <span className="muted">{` (${fmt.pct(spend.spent / spend.budget)})`}</span> : null}</div>
                  {spend.budget ? <Meter value={spend.spent} max={spend.budget} label="Factory spend this month" warnAt={0.8} /> : null}
                </>
              ) : (
                <div className="muted">No spend yet</div>
              )}
            </div>
            {evals ? (
              <div className="hm-health-row">
                <div className="sub-h">Agent evals</div>
                <div>{`${evals.passing} of ${evals.scored} live agent versions pass their suite threshold (last run)`}</div>
                {bad ? (
                  <ul className="hm-eval-fail">
                    {evals.failing.map((f) => (
                      <li key={f.agent}><Icon name="alert" /><span>{`${f.name} ${f.version}: ${fmt.pct(f.score)} vs ${fmt.pct(f.threshold)} on ${f.suite}`}</span></li>
                    ))}
                  </ul>
                ) : null}
                <a href="#evals" className="linkish small">Evals</a>
              </div>
            ) : null}
          </div>
          {health.audit ? <a href="#audit" className="btn btn-sm hm-audit-link" id="hm-audit-link"><Icon name="ledger" />Audit ledger</a> : null}
        </div>
      ) : health.audit ? <div className="hm-health-body"><a href="#audit" className="btn btn-sm hm-audit-link" id="hm-audit-link"><Icon name="ledger" />Audit ledger</a></div> : null}
    </section>
  );
}
