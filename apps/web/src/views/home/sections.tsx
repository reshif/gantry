/** The sections of Home. Each renders only what the API put in `home.sections` (built by the caller's rights); none checks a role. */
import { useState, type ReactNode } from "react";
import { fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { useMe } from "../../api/queries";
import { plural } from "../../lib/plural";
import { hasCommand, runCommand } from "../../lib/commands";
import { navigate } from "../../lib/router";
import { setProject, updatePrefs } from "../../lib/prefs";
import { Btn, Chip, Empty, Meter, Panel, Status } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { makeStopActions } from "../../shell/stopActions";
import { useOpenTraveler } from "../../shell/useTraveler";
import { HealthChip, MiniBelt, goProject, metricsOf, useCatalog, type PView } from "../projects/kit";
import { goAttention, STAGE_NAME, type Approval, type AttentionItem, type Conversation, type HomeSections, type SetupStep } from "./data";

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
    <Panel id={id} cls={`hm-sec ${cls}`} title={<>{title}{count !== undefined ? <span className="hm-count">{count}</span> : null}</>} tools={tools} flush={!!flush}>
      {children}
    </Panel>
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
      <li>
        <div className="grow">
          <div className="row"><span className="mono small">{a.note ? "Onboarding" : "PR"}</span><Chip text={a.repoName ?? a.repo} cls="info" /></div>
          <div className="trunc">{a.note ? `Onboarding update: ${a.repoName}` : `Merge onboarding PR ${a.repoName}#${a.pr}`}</div>
          <div className="small muted">{a.note ? `${a.projectName} · ${a.note}` : `${a.projectName} · checks green`}</div>
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
    <li>
      <div className="grow">
        <div className="row"><span className="mono small">{wo}</span><Chip text={a.gateLabel ?? gate} cls="warn" /><span className="small muted">{a.gateName}</span></div>
        <div className="trunc">{a.title}</div>
        <div className="small muted">{`${a.projectName}${a.need !== undefined ? ` · ${a.have ?? 0} of ${plural(a.need, "approval")}` : ""}${a.waitMs ? ` · waiting ${fmt.dur(a.waitMs)}` : ""}`}</div>
      </div>
      <div className="row">
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
    <Section id="hm-waiting" title="Needs you" count={total} flush tools={total ? <Btn label="Open Inbox" small id="hm-open-inbox" onClick={() => navigate("inbox")} /> : undefined}>
      {total ? (
        <ul className="list">
          {sorted.slice(0, 8).map((a) => <ApprovalRow key={`${a.wo ?? a.repo}-${a.gate ?? ""}-${a.note ? "n" : ""}`} a={a} />)}
          {conversations.slice(0, Math.max(0, 8 - sorted.length)).map((w) => (
            <li key={w.wo}>
              <div className="grow">
                <div className="row"><span className="mono small">{w.wo}</span><Chip text={w.stuck ? "Needs a person" : "Question"} cls="info" /></div>
                <div className="trunc">{w.title}</div>
                <div className="small muted">{w.question || "Confirm the brief or answer the open question."}</div>
              </div>
              <Btn label={w.stuck ? "Open" : "Answer"} small kind="primary" id={`hm-my-conv-${w.wo}`} aria={`${w.stuck ? "Open" : "Answer the question on"} ${w.wo}`} onClick={() => { setProject(w.project); updatePrefs({ openConversation: w.wo }); navigate("conversations"); }} />
            </li>
          ))}
        </ul>
      ) : (
        <Empty id="hm-quiet" title="You are all caught up" text="Nothing is waiting on you." />
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

export function InMotion({ motion, projects }: { motion: NonNullable<HomeSections["motion"]>; projects: PView[] }) {
  const cat = useCatalog();
  const m = motion;
  // The line is the sum of the visible projects' stations: derived from the numbers the Projects list already carries.
  const counts: Record<string, { n: number; blocked: number }> = {};
  for (const p of projects) for (const [k, v] of Object.entries(metricsOf(p).byPosition)) {
    const c = (counts[k] ??= { n: 0, blocked: 0 });
    c.n += v.n;
    c.blocked += v.blocked;
  }
  for (const [k, n] of Object.entries(m.byStation ?? {})) if (!counts[k]?.n) counts[k] = { n, blocked: counts[k]?.blocked ?? 0 };
  const stations = cat?.stations ?? [];
  const mx = Math.max(1, ...stations.map((s) => counts[s.id]?.n ?? 0));
  const delta = m.shippedWeek - m.shippedPrevWeek;
  return (
    <Section id="hm-motion" cls="hm-motion" title="Line at a glance">
      {m.inFlight ? <p className="small muted hm-motion-line">{`${plural(m.inFlight, "work order")} in flight · ${m.running} running${m.inBays ? ` · ${m.inBays} in bays` : ""}`}</p> : null}
      {m.inFlight && cat ? (
        <div className="hbars">
          <div className="hb-list" aria-label="Work by station">
            {stations.map((s) => {
              const c = counts[s.id] ?? { n: 0, blocked: 0 };
              return (
                <a key={s.id} className="hb" href="#work-orders" title={`${s.name}: ${c.n}`}>
                  <span className="hb-n"><span className="mono">{s.no}</span>{" " + s.name}</span>
                  <span className="hb-bar">
                    <i style={{ width: `${c.n ? Math.max(3, (c.n / mx) * 100) : 0}%` }} />
                    {c.blocked ? <i className="bad" style={{ width: `${(c.blocked / mx) * 100}%` }} /> : null}
                  </span>
                  <span className="hb-v num">{String(c.n)}</span>
                </a>
              );
            })}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <a href="#floor" className="btn" id="hm-open-floor"><Icon name="belt" />Open the Floor</a>
            <span className="small muted">Bar = work orders at the station; red = stuck.</span>
          </div>
        </div>
      ) : m.inFlight ? null : (
        <p className="muted hm-quiet">Nothing is moving yet. Work orders appear here once a repo is Ready and work is submitted.</p>
      )}
      {m.shippedWeek || m.shippedToday ? (
        <p className="hm-shipped small"><b>Shipped</b>{" "}<span>{`${m.shippedToday} today, ${m.shippedWeek} this week`}</span>{m.shippedPrevWeek ? <Status tone={delta >= 0 ? "done" : "wait"}>{`${delta >= 0 ? "+" : "-"}${Math.abs(delta)} vs previous week`}</Status> : null}</p>
      ) : null}
    </Section>
  );
}

/** Recent releases and the person's own work orders, as the prototype's list panel. */
export function MineAndDone({ motion }: { motion: NonNullable<HomeSections["motion"]> }) {
  const open = useOpenTraveler();
  const m = motion;
  if (!m.recentDone.length && !m.mine.length) return null;
  return (
    <Section id="hm-mine" title="Your work orders" flush>
      <ul className="list">
        {m.mine.map((w) => (
          <li key={w.id}>
            <div className="grow">
              <div className="row"><span className="mono small">{w.id}</span><Chip text={w.state} cls={w.state === "running" ? "ok" : w.state === "waiting" ? "warn" : w.state === "failed" || w.state === "blocked" ? "bad" : "plain"} /></div>
              <div className="trunc">{w.title}</div>
              <div className="small muted">{`${w.projectName} · ${w.bay ? w.bayName ?? w.bay : w.station}`}</div>
            </div>
            <Btn label="Open" small id={`hm-tok-${w.id}`} data-wo={w.id} aria={`Open ${w.id}, ${w.title}`} onClick={() => open(w.id)} />
          </li>
        ))}
        {m.recentDone.map((w) => (
          <li key={w.id}>
            <div className="grow">
              <div className="row"><span className="mono small">{w.id}</span><Chip text="Released" cls="ok" /></div>
              <div className="trunc">{w.title}</div>
              <div className="small muted">{w.projectName}</div>
            </div>
            <Btn label="Open" small kind="ghost" id={`hm-done-${w.id}`} aria={`Open ${w.id}, ${w.title}`} onClick={() => open(w.id)} />
          </li>
        ))}
      </ul>
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
    <section className="hm-projects" id="hm-projects">
      <Panel title={<>{factoryWide ? "Projects" : "My projects"}<span className="hm-count">{list.length}</span></>} tools={<a href="#projects" className="btn sm" id="hm-all-projects">All projects</a>}>
        {readOnlyNote ? <p className="callout hm-viewonly"><Icon name="info" /><span><b>View only. </b>You can view these projects. Ask a Project Admin for more access.</span></p> : null}
        <ul className="card-grid hm-proj-grid" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {list.slice(0, LIMIT).map(({ r, p }) => (
            <li key={p.id} className={`card hm-proj hk-card-${metricsOf(p).health.id}`}>
              <div className="row">
                <span className="mono small hm-key" style={{ border: "1px solid var(--accent)", color: "var(--accent)", padding: "0 6px" }}>{p.key}</span>
                <h3 className="grow">{p.name}</h3>
                <HealthChip p={p} />
              </div>
              {r.repos.length ? <p className="small muted hm-proj-onb">{r.repos.map((x) => `${x.name}: ${(STAGE_NAME[x.stage] ?? x.stage).toLowerCase()}`).join(" · ")}</p> : metricsOf(p).health.detail ? <p className="small muted hm-proj-detail">{metricsOf(p).health.detail}</p> : null}
              {r.roles.length ? <p className="small hm-proj-roles"><span className="hm-lbl">Your roles here </span>{r.roles.map((x) => <Chip key={x.id} text={x.name} cls="info" />)}</p> : null}
              {cat && !r.repos.length ? <MiniBelt cat={cat} project={p} counts={metricsOf(p).byPosition} onStation={() => goProject(p.id, "floor")} /> : null}
              <div className="row">
                {r.repos.length ? <Btn label="Open onboarding" small kind="primary" id={`hm-proj-onb-${p.id}`} aria={`Open onboarding for ${p.name}`} onClick={() => goProject(p.id, "onboarding")} /> : <Btn label="Floor" small kind="primary" icon="belt" id={`hm-my-floor-${p.id}`} aria={`Open the floor for ${p.name}`} onClick={() => goProject(p.id, "floor")} />}
                <Btn label="Work orders" small id={`hm-my-wos-${p.id}`} aria={`Work orders in ${p.name}`} onClick={() => goProject(p.id, "work-orders")} />
              </div>
            </li>
          ))}
        </ul>
        {list.length > LIMIT ? <p className="small muted hm-more">{`${list.length - LIMIT} more on the `}<a href="#projects" className="linkish">Projects page</a>.</p> : null}
      </Panel>
    </section>
  );
}

/* ----------------------------------------------------- factory health */

export function FactoryHealth({ health }: { health: NonNullable<HomeSections["health"]> }) {
  const { spend, evals } = health;
  const bad = evals?.failing.length ?? 0;
  return (
    <Section id="hm-health" cls="hm-health" title="Factory health" tools={health.audit ? <a href="#audit" className="btn sm" id="hm-audit-link"><Icon name="ledger" />Audit ledger</a> : undefined}>
      <div className="stack">
        <div className="hm-health-row">
          <div className="micro">Spend this month</div>
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
            <div className="micro">Agent evals</div>
            <div>{`${evals.passing} of ${evals.scored} live agent versions pass their suite threshold (last run)`}</div>
            {bad ? (
              <ul className="hm-eval-fail" style={{ listStyle: "none", padding: 0, margin: "6px 0" }}>
                {evals.failing.map((f) => (
                  <li key={f.agent} className="row"><Icon name="alert" /><span>{`${f.name} ${f.version}: ${fmt.pct(f.score)} vs ${fmt.pct(f.threshold)} on ${f.suite}`}</span></li>
                ))}
              </ul>
            ) : null}
            <a href="#evals" className="linkish small">Evals</a>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

