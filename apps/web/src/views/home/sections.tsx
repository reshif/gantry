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
import { Btn, Chip, Meter } from "../../ui/primitives";
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

function Section({ id, title, count, tools, cls = "", children }: { id: string; title: string; count?: number | undefined; tools?: ReactNode; cls?: string; children: ReactNode }) {
  return (
    <section className={`hm-sec ${cls}`} aria-labelledby={`${id}-h`} id={id}>
      <div className="hm-sec-head">
        <h2 className="panel-title" id={`${id}-h`}>{title}{count !== undefined ? <span className="hm-count mono">{` ${count}`}</span> : null}</h2>
        {tools ?? null}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------ attention */

const SEV = [{ id: "crit", label: "Critical" }, { id: "high", label: "High" }, { id: "watch", label: "Watch" }] as const;
const SHOWN = 5;

/** Restore for a killed scope, only for people who may (no locked copy for anyone else). */
function RestoreAction({ item }: { item: AttentionItem }) {
  const ui = useUI();
  const me = useMe();
  const r = item.restore!;
  const d = useCan(r.scope === "factory" ? "restore.factory" : "restore.project", r.scope === "project" ? { project: r.id } : {});
  if (!me || d.pending || !d.allowed) return null;
  const done = r.approvals?.length ?? 0;
  const already = !!r.approvals?.some((a) => a.by === me.person.id);
  const label = r.scope === "factory" ? (done ? `Approve restore (${done + 1} of ${r.needs ?? 2})` : "Restore factory") : "Restore project";
  return (
    <Btn
      label={label} small kind="primary" id={`hm-restore-${r.scope}${r.id ? `-${r.id}` : ""}`} aria={`${label}: ${item.title}`}
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
    <Section id="hm-attention" title="Needs attention" count={items.length} cls="hm-att-sec">
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
      {items.length > SHOWN ? <Btn label={all ? `Show the top ${SHOWN}` : `Show all ${items.length}`} small kind="ghost" id="hm-att-more" aria={all ? undefined : `Show all ${plural(items.length, "attention item")}`} onClick={() => setAll(!all)} /> : null}
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
    const r = await ops.approveGate(wo, gate);
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
    <Section id="hm-waiting" title="Waiting on you" count={total} tools={total ? <Btn label="Open Inbox" small kind="ghost" id="hm-open-inbox" onClick={() => navigate("inbox")} /> : undefined}>
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
              <Btn label="Answer" small kind="primary" id={`hm-my-conv-${w.wo}`} aria={`Answer the question on ${w.wo}`} onClick={() => { setProject(w.project); updatePrefs({ openConversation: w.wo }); navigate("conversations"); }} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small hm-quiet">Nothing is waiting on you.</p>
      )}
    </Section>
  );
}

/** The Auditor's read-only view of the human bottleneck: who the factory is waiting on, never a button that decides. */
export function ApproversWatch({ data }: { data: NonNullable<HomeSections["approvers"]> }) {
  return (
    <Section id="hm-approvers" title="Waiting on approvers" count={data.count}>
      {data.count ? (
        <>
          <p className="small">{`Oldest ${fmt.dur(data.oldestMs)}${data.late ? ` · ${data.late} past SLA` : ""}.`}</p>
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
        <p className="muted small hm-quiet">No gate is waiting on an approver.</p>
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
    <Section id="hm-setup" title="Set up the factory" tools={<span className="mono small muted">{`${setup.done} of ${setup.total}`}</span>} cls="hm-setup">
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
    <Section id="hm-motion" title="In motion">
      {m.inFlight ? (
        <>
          <p className="small hm-motion-line">{`${plural(m.inFlight, "work order")} in flight · ${m.running} running${m.inBays ? ` · ${m.inBays} in bays` : ""}`}</p>
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
        <p className="muted small hm-quiet">No work orders in flight. They appear here once a repo is Ready and work is submitted.</p>
      )}
      {m.shippedWeek || m.shippedToday ? (
        <p className="small hm-shipped">{`Shipped: ${m.shippedToday} today, ${m.shippedWeek} this week`}{m.shippedPrevWeek ? ` (${delta >= 0 ? "+" : "-"}${Math.abs(delta)} vs previous week)` : ""}</p>
      ) : null}
      {m.recentDone.length ? (
        <p className="small hm-recent">
          <span className="kv-k">Recently done </span>
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
          <div className="sub-h">Your work orders</div>
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

export function ProjectsSummary({ rows, projects, factoryWide, readOnlyNote }: { rows: NonNullable<HomeSections["projects"]>; projects: PView[]; factoryWide: boolean; readOnlyNote: boolean }) {
  const cat = useCatalog();
  const list = rows
    .map((r) => ({ r, p: projects.find((p) => p.id === r.id) }))
    .filter((x): x is { r: (typeof rows)[number]; p: PView } => !!x.p)
    .sort((a, b) => (WORST[metricsOf(a.p).health.id] ?? 9) - (WORST[metricsOf(b.p).health.id] ?? 9) || a.p.name.localeCompare(b.p.name));
  if (!list.length) return null;
  return (
    <Section id="hm-projects" title={factoryWide ? "Projects" : "My projects"} count={list.length} tools={<a href="#projects" className="linkish small" id="hm-all-projects">All projects</a>}>
      <ul className="hm-my-projs">
        {list.slice(0, LIMIT).map(({ r, p }) => (
          <li key={p.id} className="hm-my-proj">
            <div className="hm-proj-head">
              <div className="hm-proj-name"><span className="mono hm-key">{p.key}</span><h3>{p.name}</h3></div>
              <HealthChip p={p} />
            </div>
            {r.repos.length ? <div className="small hm-proj-onb">{r.repos.map((x) => `${x.name}: ${(STAGE_NAME[x.stage] ?? x.stage).toLowerCase()}`).join(" · ")}</div> : null}
            {r.roles.length ? <div className="small"><span className="kv-k">Your roles here </span>{r.roles.map((x) => <Chip key={x.id} text={x.name} cls="chip-accent" />)}</div> : null}
            {cat && !r.repos.length ? <MiniBelt cat={cat} project={p} counts={metricsOf(p).byPosition} onStation={() => goProject(p.id, "floor")} /> : null}
            <div className="hm-proj-actions">
              {r.repos.length ? <Btn label="Open onboarding" small id={`hm-proj-onb-${p.id}`} aria={`Open onboarding for ${p.name}`} onClick={() => goProject(p.id, "onboarding")} /> : <Btn label="Floor" small icon="belt" id={`hm-my-floor-${p.id}`} aria={`Open the floor for ${p.name}`} onClick={() => goProject(p.id, "floor")} />}
              <Btn label="Work orders" small kind="ghost" id={`hm-my-wos-${p.id}`} aria={`Work orders in ${p.name}`} onClick={() => goProject(p.id, "work-orders")} />
            </div>
          </li>
        ))}
      </ul>
      {list.length > LIMIT ? <p className="small muted">{`${list.length - LIMIT} more on the Projects page.`}</p> : null}
      {readOnlyNote ? <p className="small muted hm-quiet">You can view these projects. Ask a Project Admin for more access.</p> : null}
    </Section>
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
    <section className="hm-sec hm-health" id="hm-health" aria-labelledby="hm-health-h">
      <h2 className="panel-title hm-health-h" id="hm-health-h">
        <button type="button" className="hm-health-toggle" id="hm-health-toggle" aria-expanded={open} aria-controls="hm-health-body" onClick={() => setOpen(!open)}>
          <Icon name="chevron" className={open ? "hm-chev is-open" : "hm-chev"} />
          <span>Factory health</span>
          {open ? null : <span className="muted small hm-health-sum">{summary}</span>}
        </button>
      </h2>
      {open ? (
        <div className="hm-health-body" id="hm-health-body">
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
      ) : null}
      {health.audit ? <a href="#audit" className="linkish small hm-audit-link" id="hm-audit-link">Audit ledger</a> : null}
    </section>
  );
}
