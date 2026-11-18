/** The sections of Home. Each renders only what the API put in `home.sections` (built by the caller's rights); none checks a role. */
import { useMemo, useState, type ReactNode } from "react";
import { useCan } from "../../api/can";
import { useActivity, useMe, useScorecards } from "../../api/queries";
import { plural } from "../../lib/plural";
import { hasCommand, runCommand } from "../../lib/commands";
import { navigate } from "../../lib/router";
import { gotoWithQuery } from "../../lib/urlState";
import { getPrefs, setProject } from "../../lib/prefs";
import { Avatar, Btn, Chip, Empty, Panel } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { TrendChart } from "./TrendChart";
import { hashFor } from "../../lib/router";
import { GateActions } from "../work/gate";
import { agoMs } from "../work/format";
import type { Item } from "../work/items";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { makeStopActions } from "../../shell/stopActions";
import { useOpenTraveler } from "../../shell/useTraveler";
import { metricsOf, useCatalog, type PView } from "../projects/kit";
import { goAttention, type Approval, type AttentionItem, type HomeSections, type SetupStep } from "./data";

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

/** The prototype's row: work order link and gate chip, the title, "Project · waiting <ago>", Approve and Reject on the right. */
function GateRow({ a }: { a: Approval }) {
  const wo = a.wo ?? "";
  return (
    <li className="hm-need">
      <div className="grow">
        <div className="row"><a className="pri mono" href={hashFor("record", wo, a.project)} id={`hm-my-wo-${wo}`}>{wo}</a><Chip text={a.gateLabel ?? a.gate ?? ""} cls="warn" /></div>
        <div className="trunc hm-need-t">{a.title}</div>
        <div className="small muted">{`${a.projectName} · waiting ${agoMs(a.waitMs ?? 0)}`}</div>
      </div>
      <GateActions a={a} idPrefix="hm-my" />
    </li>
  );
}

/** Onboarding merges still wait on a person (kept from the working app); they follow the gate rows. */
function OnboardingRow({ a }: { a: Approval }) {
  return (
    <li>
      <div className="grow">
        <div className="row"><span className="mono small">{a.note ? "Onboarding" : "PR"}</span><Chip text={a.repoName ?? a.repo ?? ""} cls="info" /></div>
        <div className="trunc">{a.note ? `Onboarding update: ${a.repoName}` : `Merge onboarding PR ${a.repoName}#${a.pr}`}</div>
        <div className="small muted">{a.note ? `${a.projectName} · ${a.note}` : `${a.projectName} · checks green`}</div>
      </div>
      <Btn label={a.note ? "Open session" : "Open onboarding"} small id={`hm-my-onb-${a.repo}`} aria={`${a.note ? "Open session" : "Open onboarding"} for ${a.repoName}`} onClick={() => { if (a.project) setProject(a.project); navigate("onboarding", a.repo); }} />
    </li>
  );
}

const NEEDS = 6;

/** §1 Needs you: at most six pending gates, in the order the server sends them. */
export function WaitingOnYou({ items }: { items: Item[] }) {
  const gates = items.filter((i): i is Extract<Item, { kind: "gate" }> => i.kind === "gate"); // the server's order
  const onb = items.filter((i): i is Extract<Item, { kind: "onboarding" }> => i.kind === "onboarding");
  const shown = gates.slice(0, NEEDS);
  const rest = onb.slice(0, Math.max(0, NEEDS - shown.length));
  return (
    <Section id="hm-waiting" title="Needs you" flush tools={<Btn label="Open inbox" small id="hm-open-inbox" onClick={() => navigate("inbox")} />}>
      {shown.length || rest.length ? (
        <ul className="list">
          {shown.map((i) => <GateRow key={i.key} a={i.a} />)}
          {rest.map((i) => <OnboardingRow key={i.key} a={i.a} />)}
        </ul>
      ) : (
        <Empty id="hm-quiet" title="You are all caught up" text="Nothing needs a decision right now." />
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

export function InMotion({ motion, projects, scope }: { motion: NonNullable<HomeSections["motion"]>; projects: PView[]; scope: string | null }) {
  const cat = useCatalog();
  const m = motion;
  const inScope = scope ? projects.filter((p) => p.id === scope) : projects;
  // The line is the sum of the visible projects' stations: derived from the numbers the Projects list already carries.
  const counts: Record<string, { n: number; blocked: number; lim: number; over: number; known: boolean }> = {};
  for (const p of inScope) for (const [k, v] of Object.entries(metricsOf(p).byPosition)) {
    const c = (counts[k] ??= { n: 0, blocked: 0, lim: 0, over: 0, known: false });
    c.n += v.n;
    c.blocked += v.blocked;
    if (v.n > 0 || scope) {
      const w = p.flow?.stations?.[k]?.wip || 5;
      c.lim += w;
      c.known = true;
      c.over = Math.max(c.over, v.n - w);
    }
  }
  if (!scope) for (const [k, n] of Object.entries(m.byStation ?? {})) if (!counts[k]?.n) counts[k] = { n, blocked: counts[k]?.blocked ?? 0, lim: 0, over: 0, known: false };
  // A custom station (a project's own) shows where it sits on the line, before Close, once it has work; the built-in line always shows.
  const builtin = (cat?.stations ?? []).filter((s) => !s.custom);
  const custom = (cat?.stations ?? []).filter((s) => s.custom && (counts[s.id]?.n ?? 0) > 0);
  const at = builtin.findIndex((s) => s.id === "close");
  const stations = at < 0 ? [...builtin, ...custom] : [...builtin.slice(0, at), ...custom, ...builtin.slice(at)];
  const mx = Math.max(1, ...stations.map((s) => counts[s.id]?.n ?? 0));
  const flight = scope ? inScope.reduce((n, p) => n + metricsOf(p).wip, 0) : m.inFlight;
  return (
    <Section id="hm-motion" cls="hm-motion" title="Line at a glance">
      {flight && cat ? (
        <div className="hbars">
          <div className="hb-list" aria-label="Work by station">
            {stations.map((s) => {
              const c = counts[s.id] ?? { n: 0, blocked: 0, lim: 0, over: 0, known: false };
              const lim = c.known ? Math.max(5, c.lim) : null;
              const over = c.over > 0 || (lim !== null && c.n > lim);
              const route = scope ?? getPrefs().project;
              return (
                <a key={s.id} className={`hb${over ? " over" : ""}`} href={`?station=${encodeURIComponent(s.id)}${hashFor("work-orders", null, route)}`} title={`${s.name}: ${c.n} of limit ${lim ?? "—"}`}
                  onClick={(e) => { e.preventDefault(); gotoWithQuery("work-orders", { station: s.id }, route); }}>
                  <span className="hb-n"><span className="mono">{s.no}</span>{" " + s.name}</span>
                  <span className="hb-bar">
                    <i style={{ width: `${c.n ? Math.max(3, (c.n / mx) * 100) : 0}%` }} />
                    {c.blocked ? <i className="bad" style={{ width: `${(c.blocked / mx) * 100}%` }} /> : null}
                  </span>
                  <span className="hb-v num">{String(c.n)}<small>{`/${lim ?? "—"}`}</small></span>
                </a>
              );
            })}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <a href="#floor" className="btn" id="hm-open-floor"><Icon name="belt" />Open the Floor</a>
            <span className="small muted">Bar = work orders at the station, limit after the slash; red = stuck.</span>
          </div>
        </div>
      ) : (
        <p className="muted hm-quiet">Nothing is moving yet. Work orders appear here once a repo is Ready and work is submitted.</p>
      )}
    </Section>
  );
}

/** §3 Task success, 8 weeks: the mean of the agents' weekly scorecard series. The server keeps no weekly first-pass series, so the dashed line is the current first-pass mean across the agents, labelled as such. */
export function TaskSuccess() {
  const q = useScorecards();
  const data = useMemo(() => {
    const cards = Object.values(q.data ?? {}).filter((c) => c.trend?.success?.length);
    if (!cards.length) return null;
    const weeks = Math.max(...cards.map((c) => c.trend.success.length));
    const success = Array.from({ length: weeks }, (_, i) => {
      const v = cards.map((c) => c.trend.success[i]).filter((x): x is number => typeof x === "number");
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
    });
    const fp = cards.map((c) => c.firstPass).filter((x): x is number => typeof x === "number");
    return { success, first: fp.length ? fp.reduce((a, b) => a + b, 0) / fp.length : null };
  }, [q.data]);
  return (
    <Section id="hm-trend" title="Task success, 8 weeks">
      <Async query={q} what="task success" id="hm-trend-state" isEmpty={() => !data} empty={<Empty id="hm-trend-empty" title="Not available" text="No agent has a weekly success series yet." />}>
        {() => data ? (
          <TrendChart
            series={[{ name: "Success", v: data.success }, ...(data.first !== null ? [{ name: "First pass", v: data.success.map(() => data.first as number), note: "current mean; the server keeps no weekly first-pass series" }] : [])]}
            labels={data.success.map((_, i) => `W${i + 1}`)} min={0.6} max={1} fmt={(v) => `${Math.round(v * 100)}%`} label="Task success trend"
          />
        ) : null}
      </Async>
    </Section>
  );
}

/** §4 Recent activity: the seven newest events, an avatar (square for agents, round for people), the text, "type · WO · ago". */
export function RecentActivity() {
  const q = useActivity();
  return (
    <Section id="hm-activity" title="Recent activity" flush>
      <Async query={q} what="recent activity" id="hm-activity-state" isEmpty={(d) => (Array.isArray(d) ? d : d.items).length === 0} empty={<Empty id="hm-activity-empty" title="No activity yet" text="Events appear here as work moves." />}>
        {(d) => {
          const rows = (Array.isArray(d) ? d : d.items).slice(0, 7);
          return (
            <ul className="list">
              {rows.map((e) => (
                <li key={e.id}>
                  <Avatar id={e.by} />
                  <div className="grow">
                    <div className="trunc">{e.text || e.type}</div>
                    <div className="small muted">{`${e.type} · ${e.wo ? e.wo + " · " : ""}${agoMs(Date.now() - e.at)}`}</div>
                  </div>
                </li>
              ))}
            </ul>
          );
        }}
      </Async>
    </Section>
  );
}

