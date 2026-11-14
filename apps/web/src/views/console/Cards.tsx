/** Result cards for the slash commands (legacy console.js `card()`), drawn from what the console tools return. Text from work orders arrives wrapped as untrusted data; it is shown as plain text. */
import { fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import { useMe } from "../../api/queries";
import { navigate } from "../../lib/router";
import { setProject } from "../../lib/prefs";
import { canSeeRoute } from "../../lib/routes";
import { Btn, Who } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useOpenTraveler } from "../../shell/useTraveler";
import { useOpenRecordRoute } from "../record/nav";
import { EntityChip } from "./Chips";
import { SLASH } from "./slash";

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const a = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);
const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
/** Text the console marked as untrusted data, shown plain. */
export const unmark = (v: unknown): string => s(v).replace(/<\/?untrusted>/g, "").replace(/\[tag removed\]/g, "");

export interface CardCtx {
  /** Sends text as the person (a slash command or a question). */
  send: (text: string) => void;
  /** Puts text in the composer without sending it. */
  draft: (text: string) => void;
  /** Ids of the card (unique per message). */
  mid: string;
  pinned: string[];
  pin: (woId: string) => void;
  suggestions: string[];
  actionsEnabled: boolean;
}

const kv = (k: string, v: string) => <div className="kv" key={k}><div className="kv-k">{k}</div><div className="kv-v mono">{v}</div></div>;
const head = (cols: string[]) => <thead><tr>{cols.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>;
const stateBadge = (r: J) => r.killed ? <span className="state state-killed"><Icon name="st-kill" /><span>Killed</span></span> : r.halted ? <span className="state state-blocked"><Icon name="halt" /><span>Halted</span></span> : <span className="con-pstat mono">{s(r.status)}</span>;

function Help({ c }: { c: CardCtx }) {
  return (
    <div className="ccard"><ul className="slash-help">{SLASH.map((x, i) => (
      <li key={x.cmd}><button type="button" className="linkish mono" id={`con-help-${c.mid}-${i}`} onClick={() => c.draft(x.cmd)}>{x.cmd.trim()}</button><span className="muted">{x.hint}</span></li>
    ))}</ul></div>
  );
}

export function Suggest({ c }: { c: CardCtx }) {
  return <div className="ccard"><div className="chips">{c.suggestions.map((t, i) => <button type="button" key={t} className="sugg" id={`con-sug-${c.mid}-${i}`} onClick={() => c.send(t)}>{t}</button>)}</div></div>;
}

function Projects({ d, c }: { d: unknown[]; c: CardCtx }) {
  const goFloor = (id: string) => { setProject(id); navigate("floor"); };
  return (
    <div className="ccard"><div className="table-scroll"><table className="table table-compact">
      {head(["Project", "State", "WIP", "At gates", "In bays", "Health", ""])}
      <tbody>{(d as J[]).map((r) => (
        <tr key={s(r.id)} className={r.killed ? "con-killed" : r.halted ? "row-halt" : ""}>
          <td><strong>{s(r.name)}</strong><span className="mono muted small">{` ${s(r.key)}`}</span></td><td>{stateBadge(r)}</td>
          <td className="mono num">{s(r.inFlight)}</td><td className="mono num">{s(r.waitingAtGates)}</td><td className="mono num">{s(r.inBays)}</td><td className="small">{s(r.health)}</td>
          <td><Btn label="Status" small kind="ghost" id={`con-pst-${c.mid}-${s(r.id)}`} onClick={() => c.send(`/status ${s(r.id)}`)} /><Btn label="Floor" small kind="ghost" id={`con-pfl-${c.mid}-${s(r.id)}`} onClick={() => goFloor(s(r.id))} /></td>
        </tr>
      ))}</tbody></table></div></div>
  );
}

function Status({ d, c }: { d: J; c: CardCtx }) {
  const slots = o(d.slots);
  const blocked = a(d.blocked);
  const repos = a(d.repos);
  return (
    <div className="ccard">
      <div className="ccard-head"><strong>{s(d.name)}</strong>{stateBadge(d)}</div>
      <div className="kv-row">
        {kv("Waiting at gates", String(a(d.waiting).length))}{kv("Slots", slots.total != null ? `${s(slots.used)}/${s(slots.total)}` : "–")}
        {kv("In bays", String(a(d.bays).reduce((n, b) => n + Number(b.count ?? 0), 0)))}{kv("Ready repos", `${repos.filter((r) => r.onboarding === "ready").length}/${repos.length}`)}
      </div>
      <p className="small"><strong>Stations: </strong><span className="mono">{a(d.stations).map((x) => `${s(x.station)} ${s(x.here)}`).join(" · ")}</span></p>
      {a(d.waiting).length ? <p className="small"><strong>Waiting: </strong>{a(d.waiting).map((w) => <EntityChip key={s(w.id)} e={{ type: "wo", id: s(w.id), project: s(d.id) }} />)}</p> : null}
      {blocked.length ? <p className="small"><strong>Blocked or failing: </strong>{blocked.map((b) => <button type="button" key={s(b.id)} className="linkish mono" id={`con-blk-${c.mid}-${s(b.id)}`} onClick={() => c.send(`/why ${s(b.id)}`)}>{`${s(b.id)} `}</button>)}</p> : <p className="small muted">Nothing blocked.</p>}
      <div className="ccard-actions"><Btn label="Open floor" small id={`con-st-floor-${c.mid}`} onClick={() => { setProject(s(d.id)); navigate("floor"); }} /><Btn label="Onboarding" small kind="ghost" id={`con-st-onb-${c.mid}`} onClick={() => c.send(`/onboarding ${s(d.id)}`)} /></div>
    </div>
  );
}

function Onboarding({ d, c }: { d: J[]; c: CardCtx }) {
  const ready = d.filter((r) => r.stage === "ready").length;
  return (
    <div className="ccard"><div className="table-scroll"><table className="table table-compact">
      {head(["Repo", "Stage", "PR", "Note"])}
      <tbody>{d.map((r) => {
        const bad = r.stage === "failed" || r.stage === "person";
        const pr = o(r.pr);
        return <tr key={s(r.repoId)}><td className="mono">{unmark(r.repo)}</td><td><span className={`con-stage${r.stage === "ready" ? " is-ready" : bad ? " is-bad" : ""}`}><Icon name={r.stage === "ready" ? "check" : bad ? "alert" : "clock"} />{s(r.stage)}</span></td><td className="mono">{pr.number ? `#${s(pr.number)} ${s(pr.state)}` : "–"}</td><td className="small">{unmark(r.blocker)}</td></tr>;
      })}</tbody></table></div>
      <p className="small">{`${ready} of ${d.length} repos are Ready.`}</p>
      <div className="ccard-actions"><Btn label="Open onboarding" small id={`con-onb-open-${c.mid}`} onClick={() => navigate("onboarding")} /></div></div>
  );
}

function Evals({ d, c }: { d: J[]; c: CardCtx }) {
  return (
    <div className="ccard"><ul className="eval-mini con-evals">{d.filter((r) => a(r.recent).length).map((r) => {
      const last = a(r.recent)[0]!;
      const score = Number(last.score ?? 0), th = Number(r.threshold ?? 0), prev = a(r.recent)[1];
      const delta = prev ? score - Number(prev.score ?? 0) : 0;
      const pass = score >= th;
      return <li key={s(r.id)}><span className="mono">{s(r.suite)}</span><span>{`${s(r.name)} ${s(last.version)}`}</span><span className={`mono ${pass ? "pos" : "neg"}`}>{`${fmt.pct(score)} / ${fmt.pct(th)}`}</span>{delta < -0.03 ? <span className="state state-failed"><Icon name="st-fail" /><span>{`Regression ${fmt.pct(delta, 0)}`}</span></span> : <span className="muted small">{pass ? "eligible" : "below threshold"}</span>}</li>;
    })}</ul>{!d.some((r) => a(r.recent).length) ? <p className="small muted">No eval runs yet.</p> : null}<div className="ccard-actions"><Btn label="Open Evals" small id={`con-ev-open-${c.mid}`} onClick={() => navigate("evals")} /></div></div>
  );
}

function Triggers({ d, c }: { d: J[]; c: CardCtx }) {
  return (
    <div className="ccard">{d.length ? <ul className="con-trig">{d.map((t) => {
      const last = o(t.lastRun);
      return <li key={s(t.id)}><span className="mono strong">{s(t.id)}</span><span>{unmark(t.name)}<span className="muted small">{` · ${s(t.type)}${t.label ? ` label '${unmark(t.label)}'` : t.schedule ? ` ${s(t.schedule)}` : t.command ? ` ${unmark(t.command)}` : ""}`}</span></span><span className={`small ${t.enabled ? "pos" : "muted"}`}>{t.enabled ? "on" : "off"}</span><span className="small muted">{last.outcome ? `last: ${s(last.outcome)} ${last.at ? fmt.ago(Date.parse(s(last.at)), Date.now()) : ""}` : "never ran"}</span></li>;
    })}</ul> : <p className="small muted">No triggers. Add them in API and triggers.</p>}<div className="ccard-actions"><Btn label="Open API and triggers" small id={`con-trg-open-${c.mid}`} onClick={() => navigate("api")} /></div></div>
  );
}

function WhoCan({ d, c }: { d: J; c: CardCtx }) {
  const me = useMe();
  const people = a(d.people);
  const allowed = people.filter((r) => r.allowed), denied = people.filter((r) => !r.allowed);
  return (
    <div className="ccard">
      <div className={`decision ${Number(d.allowed) ? "is-allowed" : "is-denied"}`}><div className="decision-v"><Icon name={Number(d.allowed) ? "check" : "halt"} />{Number(d.allowed) ? `${s(d.allowed)} allowed` : "Nobody"}</div><div className="small">{`${s(d.name)} · ${d.project ? s(d.project) : "factory"} · ${d.at ? fmt.stamp(Date.parse(s(d.at))) : ""}`}</div></div>
      {allowed.length ? <ul className="who-list">{allowed.map((r) => <li key={s(r.id)}><Who id={s(r.id)} /><span className="muted small">{s(r.reason)}</span></li>)}</ul> : null}
      {denied.length ? <details className="who-denied"><summary>{`${denied.length} denied`}</summary><ul className="who-list">{denied.map((r) => <li key={s(r.id)}><Who id={s(r.id)} /><span className="muted small">{s(r.reason)}</span></li>)}</ul></details> : null}
      <div className="ccard-actions">{canSeeRoute("access", me) ? <Btn label="Open the simulator" small kind="ghost" id={`con-wc-acc-${c.mid}`} onClick={() => navigate("access")} /> : null}</div>
    </div>
  );
}

function Explain({ d, c }: { d: J; c: CardCtx }) {
  const open = useOpenTraveler();
  const can = useCan("gate.approve", { project: s(d.project) });
  const stop = o(d.stop);
  const bullets: string[] = [];
  if (d.state === "killed") bullets.push("Killed.");
  if (stop.reason) bullets.push(`${s(stop.mode ?? "Stopped")}: ${s(stop.reason)}`);
  if (d.bay) bullets.push(`Parked in ${s(d.bay)}.`);
  if (d.state === "blocked") bullets.push(`Blocked at ${s(d.station)}: ${unmark(d.blockReason) || "no reason recorded"}.`);
  if (d.state === "failed") bullets.push(`Check failed at ${s(d.station)}: ${unmark(d.failReason) || "see the traveler"}.`);
  const gates = a(d.gates);
  const waiting = gates.find((g) => g.status === "waiting");
  if (d.state === "waiting" && waiting) bullets.push(`Waiting at ${s(waiting.gate)}: ${a(waiting.approvals).length} approval${a(waiting.approvals).length === 1 ? "" : "s"} so far.`);
  if (d.state === "running") bullets.push(`Running at ${s(d.station)}.`);
  if (d.state === "done") bullets.push("Done and released.");
  if (!bullets.length) bullets.push("Nothing is holding it right now.");
  return (
    <div className="ccard">
      <div className="ccard-head"><EntityChip e={{ type: "wo", id: s(d.id), project: s(d.project) }} /><span className="muted">{unmark(d.title)}</span></div>
      <ul className="bullets">{bullets.map((b) => <li key={b}>{b}</li>)}</ul>
      <div className="kv-row">{kv("State", s(d.state))}{kv("Station", s(d.station))}{kv("Created", d.createdAt ? fmt.stamp(Date.parse(s(d.createdAt))) : "–")}</div>
      <div className="ccard-actions"><Btn label="Open traveler" small id={`con-ex-open-${c.mid}`} onClick={() => open(s(d.id))} />
        {d.state === "waiting" && waiting && c.actionsEnabled ? <Btn label="Approve…" small kind="primary" icon="check" id={`con-ex-appr-${c.mid}`} guard={can.allowed ? null : can} onClick={() => c.send(`/approve ${s(d.id)}`)} /> : null}
        <Btn label={c.pinned.includes(s(d.id)) ? "Pinned" : "Pin"} small kind="ghost" icon="pin" id={`con-ex-pin-${c.mid}`} disabledReason={c.pinned.includes(s(d.id)) ? "Already pinned in the context panel." : null} onClick={() => c.pin(s(d.id))} /></div>
    </div>
  );
}

function Summary({ d, c }: { d: J; c: CardCtx }) {
  const open = useOpenRecordRoute();
  return (
    <div className="ccard"><div className="ccard-head"><EntityChip e={{ type: "wo", id: s(d.id), project: s(d.project) }} /><span className="muted small">Record summary</span></div>
      <p className="msg-text">{unmark(d.summary) || "The record has no summary yet."}</p>
      <div className="ccard-actions"><Btn label="Open full record" small icon="record" id={`con-sum-rec-${c.mid}`} onClick={() => open(s(d.id), s(d.project))} /></div></div>
  );
}

function Mine({ d, c }: { d: J; c: CardCtx }) {
  const ap = a(d.approvals).filter((x) => x.wo);
  const onb = a(d.approvals).filter((x) => !x.wo);
  const conv = a(d.conversations);
  if (!ap.length && !onb.length && !conv.length) return <div className="ccard"><p className="small muted">Nothing is waiting on you right now: no gates you can decide and no intake questions for you.</p></div>;
  return (
    <div className="ccard">
      {ap.length ? <ul className="con-list">{ap.map((x, i) => <li key={s(x.wo)}><EntityChip e={{ type: "wo", id: s(x.wo), project: s(x.project) }} /><span className="mono small">{s(x.gate)}</span><span className="small">{unmark(x.title)}</span><Btn label="Approve…" small kind="ghost" icon="check" id={`con-mine-ap-${c.mid}-${i}`} onClick={() => c.send(`/approve ${s(x.wo)}`)} /></li>)}</ul> : null}
      {onb.length ? <p className="small">{`Onboarding PRs ready to merge: ${onb.map((x) => unmark(x.repo)).join(", ")}`}</p> : null}
      {conv.length ? <p className="small"><strong>Conversations: </strong>{conv.map((x) => <EntityChip key={s(x.wo)} e={{ type: "wo", id: s(x.wo), project: s(x.project) }} />)}</p> : null}
    </div>
  );
}

const EV_LABELS: Record<string, string> = { "wo.submit": "submitted", "wo.enter": "station entries", "gate.decision": "gate decisions", "gate.approve": "gate approvals", release: "releases", "wo.done": "finished", halt: "halts", resume: "resumes", kill: "kills", restore: "restores", "trust.grant": "trust grants", "trust.demote": "trust demotions" };
function Changes({ d, c }: { d: J; c: CardCtx }) {
  const me = useMe();
  const count = o(d.count);
  const recent = a(d.recent).slice(-10).reverse();
  return (
    <div className="ccard">
      <div className="kv-row">{Object.keys(count).map((k) => kv(EV_LABELS[k] ?? k, s(count[k])))}</div>
      {recent.length ? <ul className="con-list">{recent.map((e, i) => <li key={i}><span className="mono muted small">{`${fmt.istDate(Date.parse(s(e.at)))} ${fmt.ist(Date.parse(s(e.at)))}`}</span><span className={`con-ev con-ev-${s(e.type).replace(".", "-")}`}>{EV_LABELS[s(e.type)] ?? s(e.type)}</span>{e.wo ? <EntityChip e={{ type: "wo", id: s(e.wo), project: s(d.project) }} /> : null}{e.by ? <span className="muted small">{s(e.by)}</span> : null}</li>)}</ul> : <p className="small muted">No events in that window.</p>}
      <div className="ccard-actions"><Btn label="Open floor" small id={`con-chg-floor-${c.mid}`} onClick={() => { setProject(s(d.project)); navigate("floor"); }} />{canSeeRoute("audit", me) ? <Btn label="Open audit" small kind="ghost" id={`con-chg-aud-${c.mid}`} onClick={() => navigate("audit")} /> : null}</div>
    </div>
  );
}

function Bottlenecks({ d, c }: { d: J; c: CardCtx }) {
  const me = useMe();
  const rows = a(d.bottlenecks).slice(0, 6);
  if (!rows.length) return <div className="ccard"><p className="small muted">{`Nothing waits on people in ${s(d.scope)} this period.`}</p></div>;
  return (
    <div className="ccard"><div className="table-scroll"><table className="table table-compact">
      {head(["Gate", "Project", "Median wait", "Waiting now", "Oldest", "Eligible"])}
      <tbody>{rows.map((b, i) => <tr key={i}><td className="mono strong">{s(b.gate)}</td><td><EntityChip e={{ type: "project", id: s(b.project) }} /></td><td className="mono">{Number(b.decisions) ? `${fmt.dur(Number(b.medianWaitMin ?? 0) * 60000)} (n=${s(b.decisions)}${Number(b.decisions) < 5 ? ", insufficient data" : ""})` : "no decisions"}</td><td className="mono num">{s(b.open)}</td><td className="mono">{Number(b.open) ? fmt.dur(Number(b.oldestMin ?? 0) * 60000) : "–"}</td><td className="mono">{b.minEligible == null ? "–" : s(b.minEligible)}</td></tr>)}</tbody></table></div>
      <div className="ccard-actions">{canSeeRoute("workload", me) ? <Btn label="Open Workload" small id={`con-bn-wl-${c.mid}`} onClick={() => navigate("workload")} /> : null}</div></div>
  );
}

function Workload({ d, c }: { d: J; c: CardCtx }) {
  const me = useMe();
  const rows = a(d.people).filter((r) => Number(r.approvals) || Number(r.waiting)).sort((x, y) => Number(y.minutes) - Number(x.minutes)).slice(0, 6);
  if (!rows.length) return <div className="ccard"><p className="small muted">{`No approvals, confirmations or answers in ${s(d.scope)} in that period.`}</p></div>;
  return (
    <div className="ccard"><ul className="con-list">{rows.map((r) => <li key={s(r.person)}><Who id={s(r.person)} /><span className="mono small">{`${s(r.minutes)} min`}</span><span className="small">{`${s(r.approvals)} approvals, ${s(r.waiting)} waiting${Number(r.sole) ? `, only approver on ${s(r.sole)}` : ""}`}</span><span className="muted small">{Number(r.n) >= 5 ? `${fmt.pct(Number(r.afterHours) / Number(r.n))} out of hours` : "after hours: insufficient data"}</span></li>)}</ul>
      <div className="ccard-actions">{canSeeRoute("workload", me) ? <Btn label="Open Workload" small id={`con-wl-open-${c.mid}`} onClick={() => navigate("workload")} /> : null}</div></div>
  );
}

function Trust({ d, c }: { d: J; c: CardCtx }) {
  const me = useMe();
  const lv = Array.isArray(d.byLevel) ? (d.byLevel as number[]) : [];
  return (
    <div className="ccard"><div className="kv-row">{lv.map((n, i) => kv(`L${i}`, String(n || 0)))}</div>
      <p className="small">{Number(d.pendingProposals) ? `${s(d.pendingProposals)} cell${Number(d.pendingProposals) === 1 ? " has" : "s have"} a pending promotion proposal.` : "No pending promotion proposals."}</p>
      <div className="ccard-actions">{canSeeRoute("trust", me) ? <Btn label="Open Trust" small id={`con-tr-open-${c.mid}`} onClick={() => { if (d.project) setProject(s(d.project)); navigate("trust"); }} /> : null}</div></div>
  );
}

/** The card for a tool result, by the card type the slash plan named. */
export function ResultCard({ type, data, c }: { type: string; data: unknown; c: CardCtx }) {
  switch (type) {
    case "help": return <Help c={c} />;
    case "suggest": return <Suggest c={c} />;
    case "projects": return <Projects d={Array.isArray(data) ? data : []} c={c} />;
    case "status": return <Status d={o(data)} c={c} />;
    case "onboarding": return <Onboarding d={a(data)} c={c} />;
    case "evals": return <Evals d={a(data)} c={c} />;
    case "triggers": return <Triggers d={a(data)} c={c} />;
    case "whocan": return <WhoCan d={o(data)} c={c} />;
    case "explain": return <Explain d={o(data)} c={c} />;
    case "summary": return <Summary d={o(data)} c={c} />;
    case "mine": return <Mine d={o(data)} c={c} />;
    case "changes": return <Changes d={o(data)} c={c} />;
    case "bottlenecks": return <Bottlenecks d={o(data)} c={c} />;
    case "workload": return <Workload d={o(data)} c={c} />;
    case "trust": return <Trust d={o(data)} c={c} />;
    default: return null;
  }
}
