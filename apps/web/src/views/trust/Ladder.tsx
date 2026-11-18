/** Ladder tab (legacy ladderTab): agent x class x project matrix with level, evidence count and ceiling marker, cell detail with evidence, criteria and history, and the projection. */
import { useState } from "react";
import { useAgents, useProjects, useTrustCells } from "../../api/queries";
import { fmt, flowOf, type Catalog, type Project, type TrustProposal, type WorkOrder } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { useWorkOrders } from "../../api/queries";
import { useCatalog } from "../projects/kit";
import { DataView } from "../dataview";
import { openRecordRoute } from "../../lib/router";
import { IconBtn, Avatar, Btn, Chip, Empty, Field, LockNote, Panel, Select, type Decision } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { useOutcome, useAllRepos } from "../govern/data";
import { ClassChip } from "../projects/kit";
import { OutcomeDialog } from "./Tabs";
import { KV, LevelTag, Rate, Rungs, code, gateForAgent, ladderRows, lv, pct, rerender, trustCellId, trustUi, useTrustUi, type CellOut, type LadderRow, MIN_RUNS } from "./kit";

export interface LadderProps { cat: Catalog; project: Project; projects: Project[]; cells: CellOut[]; proposals: TrustProposal[]; switchOn: boolean; criteria: Record<string, { cleanRuns: number; evalMin: number; reworkMax: number; incidentsMax: number; windowD: number }>; sampleRate: number; coverage: { total: number; auto: number }; agentName: (id: string) => string; clsName: (id: string) => string }

const label = (c: { agent: string; cls: string; project: string; repo?: string | null }, p: LadderProps): string => `${p.agentName(c.agent)} · ${p.clsName(c.cls)} · ${p.projects.find((x) => x.id === c.project)?.name ?? c.project}${c.repo ? ` · ${c.repo}` : ""}`;
export const cellLabel = label;

/** The cell in force for (agent, class): the repo cell when a repo is picked and has one, else the project cell, else a default one. */
function cellFor(p: LadderProps, agent: string, cls: string): { cell: CellOut; inherited: boolean } {
  const repo = trustUi.repo;
  const repoCell = repo ? p.cells.find((c) => c.id === trustCellId(agent, cls, p.project.id, repo)) : undefined;
  if (repoCell) return { cell: repoCell, inherited: false };
  const c = p.cells.find((x) => x.id === trustCellId(agent, cls, p.project.id));
  if (c) return { cell: c, inherited: !!repo };
  return { cell: { id: trustCellId(agent, cls, p.project.id, repo || null), agent, cls, project: p.project.id, repo: repo || null, level: 1, since: 0, cleanRuns: 0, history: [], rev: 0, virtual: true, gate: gateForAgent(p.cat, agent)?.id ?? null, evidence: { runs: 0, cleanRuns: 0, evalScore: 0, rework: 0, incidents: 0, incidentWos: [] }, meets: { ok: false, next: 2, missing: [] }, ceiling: { max: 4, ids: [] }, effective: 1, projection: 0, pending: null }, inherited: false };
}

const recentDemotion = (c: CellOut) => [...(c.history || [])].reverse().find((e) => e.kind === "demote" && e.at >= Date.now() - 7 * 86_400_000);

function Matrix({ p, rows }: { p: LadderProps; rows: LadderRow[] }) {
  const classes = flowOf(p.cat, p.project).classes;
  if (!rows.length) return <Empty id="tr-matrix-empty" title="No human gates in this flow" text={`Every gate in ${p.project.name} is automatic, so there is nothing for trust to replace.`} />;
  return (
    <div className="tr-matrix-scroll" data-keep-scroll="tr-matrix">
      <table className="tr-matrix" id="tr-matrix">
        <caption className="sr-only">{`Trust level per agent and work class on ${p.project.name}`}</caption>
        <thead><tr><th scope="col" className="tr-corner"><span>Agent · gate judged</span><span>Class →</span></th>{classes.map((c) => <th key={c.id} scope="col"><ClassChip cls={c} small /></th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.agent} className={r.off ? "is-off" : ""}>
              <th scope="row" className="tr-rowh">
                <span className="who"><Avatar id={r.agent} size="xs" /><strong>{p.agentName(r.agent)}</strong></span>
                <span className="mono small muted">{r.gate ? r.gate.label + (r.off ? " (not in this flow)" : r.gate.mode === "mixed" ? " · checks + person" : "") : ""}</span>
              </th>
              {classes.map((c) => <td key={c.id}><CellButton p={p} r={r} cls={c} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CellButton({ p, r, cls }: { p: LadderProps; r: LadderRow; cls: { id: string; name: string } }) {
  const { cell, inherited } = cellFor(p, r.agent, cls.id);
  const virtual = !!cell.virtual;
  const eff = cell.effective;
  const prop = virtual ? null : p.proposals.find((x) => x.cell === cell.id && x.status === "pending");
  const dem = virtual ? null : recentDemotion(cell);
  const on = !!trustUi.sel && trustUi.sel.agent === r.agent && trustUi.sel.cls === cls.id;
  const ev = cell.evidence;
  const lbl = `${p.agentName(r.agent)}, ${cls.name}: ${code(cell.level)} ${lv(cell.level).name}${eff < cell.level ? `, runs at ${code(eff)}` : ""}, ${ev.runs} finished runs${cell.ceiling.max < 4 ? `, ceiling ${code(cell.ceiling.max)}` : ""}${prop ? `, promotion to ${code(prop.to)} proposed` : ""}${dem ? ", demoted recently" : ""}${virtual ? ", no cell yet" : ""}`;
  return (
    <button type="button" className={`tr-cell lvl-${eff}${on ? " is-on" : ""}${virtual ? " is-virtual" : ""}${inherited ? " is-inherited" : ""}`} id={`tr-cell-${r.agent}-${cls.id}`} aria-pressed={on ? "true" : "false"} aria-label={lbl} title={lbl}
      onClick={() => { trustUi.sel = { agent: r.agent, cls: cls.id }; rerender(); setTimeout(() => { const d = document.getElementById("tr-detail"); if (d && d.getBoundingClientRect().top > window.innerHeight * 0.75) d.scrollIntoView?.({ block: "start", behavior: "smooth" }); }, 30); }}>
      <span className="tr-cell-top"><Rungs level={eff} /><span className="tr-cell-l mono">{code(cell.level)}</span>{eff < cell.level ? <span className="tr-cap-eff mono">{`→${code(eff)}`}</span> : null}</span>
      <span className="tr-cell-n mono">{`${ev.runs} run${ev.runs === 1 ? "" : "s"}`}</span>
      <span className="tr-cell-marks">
        {cell.ceiling.max < 4 ? <span className="tr-mark tr-mark-cap" title={`Ceiling ${code(cell.ceiling.max)}`}>{`≤${code(cell.ceiling.max)}`}</span> : null}
        {prop ? <span className="tr-mark tr-mark-up" title={`Promotion to ${code(prop.to)} proposed`}>{`▲${code(prop.to)}`}</span> : null}
        {dem ? <span className="tr-mark tr-mark-down" title={`Demoted ${fmt.ago(dem.at, Date.now())}`}>▼</span> : null}
        {inherited ? <span className="tr-mark" title="Project cell; no repo override">proj</span> : null}
      </span>
    </button>
  );
}

function Legend() {
  return (
    <ul className="tr-legend" aria-label="Trust levels">
      {[0, 1, 2, 3, 4].map((n) => <li key={n} title={lv(n).desc}><LevelTag level={n} /></li>)}
      <li className="tr-legend-marks small"><span className="tr-mark tr-mark-cap">≤L2</span>{" ceiling "}<span className="tr-mark tr-mark-up">▲L3</span>{" proposal pending "}<span className="tr-mark tr-mark-down">▼</span>{" demoted in the last 7 days"}</li>
    </ul>
  );
}

export function ProposalButtons({ prop, cell, p }: { prop: TrustProposal; cell: CellOut; p: LadderProps }) {
  const ui_ = useUI();
  const out = useOutcome();
  const perm = useCan("trust.grant", { project: cell.project });
  const name = p.agentName(cell.agent);
  const accGuard: Decision | null = !perm.allowed ? perm
    : prop.to > 3 ? { allowed: false, needs: "", reason: "L4 cannot be granted in this version. Decline it." }
    : prop.to > 1 && !p.switchOn ? { allowed: false, needs: "Turn on trust levels above L1", reason: "Trust levels above L1 are switched off." }
    : prop.to > cell.ceiling.max ? { allowed: false, needs: "", reason: `Capped at ${code(cell.ceiling.max)} by ${cell.ceiling.ids.join(", ")}. Decline it or change the ceiling.` } : null;
  return (
    <>
      <Btn label="Decline" small id={`tr-prop-no-${prop.id}`} guard={perm}
        onClick={() => ui_.reasonDialog({ title: `Decline ${name}`, kicker: "Trust · promotion", sub: `${label(cell, p)} stays at ${code(prop.from)}. The system will not propose this cell again for 3 days.`, label: "Reason (required)", ok: "Decline", kind: "danger", min: 6, guard: perm,
          onOk: async (t) => out(await ops.decideTrustProposal(prop.id, false, t)) })} />
      <Btn label="Promote" small kind="primary" id={`tr-prop-ok-${prop.id}`} guard={accGuard}
        onClick={() => ui_.reasonDialog({ title: `Promote ${name}`, kicker: "Trust · promotion", sub: `${prop.evidence.note || label(cell, p)} About ${prop.savedPerWeek || 0} approvals a week stop needing a person.`, label: "Reason (optional)", placeholder: "Recorded with the decision", ok: `Promote to L${prop.to}`, min: 0, guard: accGuard,
          onOk: async (t) => out(await ops.decideTrustProposal(prop.id, true, t.trim() || prop.evidence.note || "Meets the criteria for the next level.")) })} />
    </>
  );
}

function LevelDialog({ cell, p, onDone }: { cell: CellOut; p: LadderProps; onDone: () => void }) {
  const out = useOutcome();
  const perm = useCan("trust.grant", { project: cell.project });
  const g = gateForAgent(p.cat, cell.agent);
  const [pick, setPick] = useState(cell.level);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Trust levels" />
      <div className="radio-cards tr-lvl-cards" role="radiogroup" aria-label="Trust level">
        {[0, 1, 2, 3, 4].map((n) => {
          const why = n > 3 ? "L4 (unattended including release) cannot be granted in this version."
            : n > 1 && !p.switchOn ? "Trust levels above L1 are switched off. Turn them on in Ceilings and criteria."
            : n > cell.ceiling.max ? `Above the ceiling: ${cell.ceiling.ids.join(", ")}.`
            : null;
          return (
            <label key={n} className={`radio-card${why ? " is-locked" : ""}`} htmlFor={`tr-lvl-${n}`} data-reason={why ?? undefined}>
              <input type="radio" name="tr-lvl" id={`tr-lvl-${n}`} value={String(n)} checked={pick === n} disabled={!!why || !perm.allowed} onChange={() => setPick(n)} />
              <span className="rc-t"><LevelTag level={n} />{n === cell.level ? <span className="chip">current</span> : null}</span>
              <span className="rc-d small muted">{lv(n).desc}</span>
              {why ? <span className="rc-why small neg"><Icon name="lock" />{` ${why}`}</span> : null}
            </label>
          );
        })}
      </div>
      <Field label="Reason (required)" htmlFor="tr-lvl-reason"><textarea id="tr-lvl-reason" className="input" rows={3} placeholder="Why this level, in one or two sentences" value={reason} disabled={!perm.allowed} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="form-err" role="alert">{err}</div>
      <div className="dlg-actions-inline">
        <Btn label="Save level" kind="primary" id="tr-lvl-ok" guard={perm} onClick={() => {
          if (reason.trim().length < 4) { setErr("Give a reason of at least 4 characters."); return; }
          if (pick === cell.level) { setErr("Pick a different level."); return; }
          const target = cell.virtual ? { agent: cell.agent, cls: cell.cls, project: cell.project, repo: cell.repo } : cell.id;
          void ops.grantTrust(target, pick, reason.trim(), { ifMatch: cell.rev }).then((r) => { if (!r.ok) { setErr(r.msg); return; } out(r); onDone(); });
        }} />
      </div>
      <p className="small muted">{`Raising a level lets ${g ? g.label : "its gate"} pass without a person for this class; lowering it brings people back in. Pending proposals for this cell are withdrawn. Audited.`}</p>
    </div>
  );
}

function DecisionText({ d, who }: { d: NonNullable<WorkOrder["gates"][string]["decision"]> | null | undefined; who: (id: string) => { name: string } }) {
  if (!d) return <span className="muted">no decision yet</span>;
  if (d.mode === "trust") return <span className="tr-dec is-trust"><Icon name="sparkle" />{`passed under trust ${d.trust != null ? code(d.trust) : ""}`}</span>;
  if (d.mode === "auto") return <span className="tr-dec"><Icon name="check" />automatic checks</span>;
  return <span className="tr-dec is-human"><Icon name="human" />{`${who(d.by ?? "").name}${d.trust != null ? ` at ${code(d.trust)}` : ""}`}</span>;
}

function Detail({ p, rows }: { p: LadderProps; rows: LadderRow[] }) {
  const ui_ = useUI();
  const who = useActors();
  const sel = trustUi.sel;
  const wosQ = useWorkOrders(p.project.id, { cls: sel?.cls ?? "", limit: 100 });
  const perm = useCan("trust.grant", { project: p.project.id });
  const outPerm = useCan("outcome.record", { project: p.project.id });
  if (!sel) return <section className="panel tr-detail" id="tr-detail"><Empty title="Select a cell" text="Pick an agent and class in the ladder to see its evidence, history and what it needs for the next level." /></section>;
  if (!sel.agent) {
    const first = rows[0];
    if (first) sel.agent = first.agent;
    else return <div />;
  }
  const { cell, inherited } = cellFor(p, sel.agent!, sel.cls);
  const g = gateForAgent(p.cat, cell.agent);
  const ev = cell.evidence;
  const m = cell.meets;
  const eff = cell.effective;
  const crit = m.next ? p.criteria[String(m.next)] : null;
  const prop = cell.virtual ? null : p.proposals.find((x) => x.cell === cell.id && x.status === "pending");
  const list = (wosQ.data ? (Array.isArray(wosQ.data) ? wosQ.data : wosQ.data.items) : []) as WorkOrder[];
  const wos = list.filter((w) => w.cls === cell.cls && (!cell.repo || w.repo === cell.repo) && g && w.gates[g.id] && (w.gates[g.id]!.decision || w.state === "done"));
  const lines: Array<[string, string, boolean, string | null]> = crit ? [
    ["Clean runs", `${ev.cleanRuns} of ${crit.cleanRuns}`, ev.cleanRuns >= crit.cleanRuns, ev.cleanRuns >= crit.cleanRuns ? null : `${crit.cleanRuns - ev.cleanRuns} more`],
    ["Eval score", `${pct(ev.evalScore)} vs ≥ ${pct(crit.evalMin)}`, ev.evalScore >= crit.evalMin, ev.evalScore >= crit.evalMin ? null : `${pct(crit.evalMin - ev.evalScore)} short`],
    ["Rework", `${pct(ev.rework)} vs ≤ ${pct(crit.reworkMax)}`, ev.rework <= crit.reworkMax, ev.rework <= crit.reworkMax ? null : `${pct(ev.rework - crit.reworkMax)} over`],
    [`Incidents in ${crit.windowD} days`, `${ev.incidents} vs ≤ ${crit.incidentsMax}`, ev.incidents <= crit.incidentsMax, ev.incidents <= crit.incidentsMax ? null : "wait out the window"],
    ["Ceiling", `≤ ${code(cell.ceiling.max)}`, (m.next ?? 0) <= cell.ceiling.max, (m.next ?? 0) <= cell.ceiling.max ? null : `blocked by ${cell.ceiling.ids.join(", ")}`],
  ] : [];
  if (m.next && m.next > 3) lines.push(["Grantable", "L4 is not grantable", false, "unattended release stays with a person in this version"]);
  if (m.next && m.next > 1 && !p.switchOn) lines.push(["Switch", "levels above L1 are off", false, "turn them on in Ceilings and criteria"]);
  const metN = lines.filter((l) => l[2]).length;
  const hist = [...(cell.history || [])].reverse();
  const reasonWhy = eff < cell.level ? (!p.switchOn && cell.level > 1 && cell.ceiling.max >= cell.level ? "levels above L1 are switched off" : `capped by ${cell.ceiling.ids.join(", ")}`) : "";
  const openLevel = () => ui_.dialog({ title: `Trust level for ${label(cell, p)}`, kicker: `Trust · ${cell.virtual ? "new cell" : `${code(cell.level)} now`}`, wide: true, sub: "A person sets a level, with a reason. Raising it lets the gate pass without a person for this class; lowering it brings people back in.", body: (close) => <LevelDialog cell={cell} p={p} onDone={close} />, actions: [{ label: "Close" }] });
  return (
    <section className="panel tr-detail" id="tr-detail" aria-label={`Trust cell ${label(cell, p)}`}>
      <div className="tr-dhead">
        <div className="tr-dmain">
          <div className="kicker">{`Trust cell${cell.repo ? " · repo override" : inherited ? " · project cell (no repo override)" : ""}`}</div>
          <h2 className="tr-dtitle">{label(cell, p)}</h2>
          <div className="tr-dmeta small">{"Judged at "}<strong>{g ? `${g.label} ${g.name}` : "no gate"}</strong>{" · "}{cell.virtual ? "no cell yet, default L1" : `since ${fmt.istDate(cell.since)}`}</div>
        </div>
        <div className="tr-dlevel"><LevelTag level={cell.level} extra="is-big" />{eff < cell.level ? <div className="small warn-text"><Icon name="lock" />{` Runs at ${code(eff)}: ${reasonWhy}`}</div> : null}</div>
        <div className="tr-dact"><Btn label={cell.virtual ? "Set level" : "Change level"} icon="trust" id="tr-change" guard={perm} onClick={openLevel} /><Btn label="Record a post-release outcome" icon="alert" id="tr-rec-outcome" guard={outPerm} onClick={() => ui_.dialog({ title: "Record a post-release outcome", kicker: "Trust · outcomes", sub: "Recorded on the shipped work order with your name and what it is attributed to. An attributed revert or incident lowers the agent's cells for that class and project to L1 at once. Audited.", wide: true, body: (close) => <OutcomeDialog cells={p.cells} projects={p.projects} onDone={close} />, actions: [{ label: "Close" }] })} /></div>
      </div>
      <LockNote decision={perm} what={`Trust levels on ${p.project.name}`} />
      <div className="tr-dgrid">
        <section className="tr-sec">
          <h3 className="sub-h">Evidence</h3>
          <dl className="tr-kv">
            <KV k="Finished on record" v={<span className="mono">{ev.runs}</span>} />
            <KV k="Clean streak" v={<span className="mono">{ev.cleanRuns}</span>} />
            <KV k="Clean share" v={<Rate value={ev.runs ? Math.min(1, ev.cleanRuns / ev.runs) : 0} n={ev.runs} />} />
            <KV k="Agent eval score" v={<span className="mono">{pct(ev.evalScore)}</span>} />
            <KV k="Agent rework rate" v={<span className="mono">{pct(ev.rework)}</span>} />
            <KV k="Reverts and incidents" v={<span className={`mono${ev.incidents ? " neg" : ""}`}>{ev.incidents}</span>} extra={ev.incidentWos.length ? <span className="tr-chips">{ev.incidentWos.map((id) => <button key={id} type="button" className="chip entity-chip" onClick={() => openRecordRoute(id)}>{id}</button>)}</span> : null} />
          </dl>
          <p className="small muted" id="tr-evid-note">Only a person's decision on a completed attempt counts. An unattended pass, a halted, killed or budget-held attempt and a fallback-model attempt do not. A run is clean after its soak period with no attributed revert or incident.</p>
          {wos.length ? (
            <div className="tr-wolist">
              <div className="small muted">{`Latest work orders through ${g ? g.label : "the gate"} (${wos.length})`}</div>
              <ul className="plain-list">
                {wos.slice(0, 6).map((w) => {
                  const d = g ? w.gates[g.id]?.decision : null;
                  const bad = (w.outcomes || []).find((o) => o.kind === "revert" || o.kind === "incident");
                  return (
                    <li key={w.id} className="tr-woline">
                      <button type="button" className="chip entity-chip" onClick={() => openRecordRoute(w.id)}>{w.id}</button>
                      <span className="small tr-wotitle">{w.title}</span><span className="small"><DecisionText d={d} who={who} /></span>
                      {bad ? <span className="chip chip-block">{bad.kind}</span> : w.state === "done" ? <span className="chip">shipped</span> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : <p className="small muted">{`No work orders of this class have reached ${g ? g.label : "this gate"} here yet.`}</p>}
        </section>
        <section className="tr-sec">
          <h3 className="sub-h">Next level</h3>
          {!m.next || m.next > 4 ? <p className="small">Already at the top of the ladder.</p> : (
            <div>
              <div className="tr-next-head"><span>To reach </span><LevelTag level={m.next} /><span className="small muted">{`${metN} of ${lines.length} criteria met`}</span></div>
              <div className="meter tr-meter" role="img" aria-label={`${metN} of ${lines.length} criteria met`}><span className="meter-fill" style={{ width: `${Math.round((metN / (lines.length || 1)) * 100)}%` }} /></div>
              <ul className="checklist tr-crit">{lines.map((l) => <li key={l[0]} className={l[2] ? "ok" : "bad"}><span>{l[0]}</span><span className="mono small">{l[1]}</span>{l[3] ? <span className="small muted">{l[3]}</span> : null}</li>)}</ul>
              <p className="small">{`Projection: moving to ${code(m.next)} saves about `}<strong className="mono">{String(cell.projection)}</strong>{` human approvals a week (from ${ev.runs ? "the work orders of this class this week" : "no finished work yet"}).`}</p>
            </div>
          )}
          {prop ? <div className="callout tr-prop-inline"><Icon name="trust" /><div><strong>{`${prop.id}: promotion to ${code(prop.to)} proposed ${fmt.ago(prop.at, Date.now())}. `}</strong><span className="small">{prop.evidence.note || ""}</span><div className="tr-prop-acts"><ProposalButtons prop={prop} cell={cell} p={p} /></div></div></div> : null}
        </section>
        <section className="tr-sec">
          <h3 className="sub-h">History</h3>
          {hist.length ? (
            <ol className="tr-hist">
              {hist.map((e, i) => (
                <li key={i} className={`tr-hist-${e.kind}`}>
                  <span className="mono small">{fmt.stamp(e.at)}</span>
                  <span className="tr-hist-move mono">{e.from == null ? `start ${code(e.to)}` : `${code(e.from)}${e.to > e.from ? " ▲ " : " ▼ "}${code(e.to)}`}</span>
                  <span className="chip">{e.kind}</span>
                  <span className="small">{e.reason}{e.cause && e.cause.wo ? <span>{" "}<button type="button" className="chip entity-chip" onClick={() => openRecordRoute(e.cause!.wo!)}>{e.cause.wo}</button></span> : null}</span>
                  <span className="small muted">{who(e.by).name}</span>
                </li>
              ))}
            </ol>
          ) : <p className="small muted">No changes yet. A person sets the first level, or the system proposes one when the criteria are met.</p>}
          {cell.ceiling.ids.length ? <div className="small"><strong>Ceilings in force: </strong>{p.cells.length ? cell.ceiling.ids.join(", ") : ""}</div> : <div className="small muted">No ceiling applies to this cell.</div>}
        </section>
      </div>
    </section>
  );
}

function Projection({ p, rows }: { p: LadderProps; rows: LadderRow[] }) {
  const classes = flowOf(p.cat, p.project).classes;
  const eligible: Array<{ cell: CellOut; to: number; saved: number }> = [];
  let total = 0, cells = 0, sumPending = 0;
  for (const r of rows) for (const c of classes) {
    const { cell } = cellFor(p, r.agent, c.id);
    if (cell.virtual) continue;
    cells++;
    if (cell.meets.ok && cell.meets.next) { total += cell.projection; eligible.push({ cell, to: cell.meets.next, saved: cell.projection }); }
    const pr = p.proposals.find((x) => x.cell === cell.id && x.status === "pending");
    if (pr) sumPending += pr.savedPerWeek || 0;
  }
  return (
    <Panel title="Projection" cls="tr-proj-panel">
      <div className="tr-proj">
        <dl className="tr-kv">
          <KV k="Gate decisions under trust, 7d" v={<Rate value={p.coverage.total ? p.coverage.auto / p.coverage.total : 0} n={p.coverage.total} min={10} />} />
          <KV k="Saved by pending proposals" v={<span className="mono">{`${Math.round(sumPending * 10) / 10} / week`}</span>} />
          <KV k="Saved if every eligible cell moves up" v={<span className="mono">{`${Math.round(total * 10) / 10} / week`}</span>} extra={<span className="small muted">{` ${eligible.length} of ${cells} cells eligible`}</span>} />
        </dl>
        {eligible.length ? (
          <ul className="plain-list small tr-elig">
            {eligible.sort((a, b) => b.saved - a.saved).slice(0, 5).map((e) => (
              <li key={e.cell.id}><button type="button" className="linkish" id={`tr-elig-${e.cell.agent}-${e.cell.cls}`} onClick={() => { trustUi.sel = { agent: e.cell.agent, cls: e.cell.cls }; rerender(); }}>{`${p.agentName(e.cell.agent)} · ${p.clsName(e.cell.cls)}`}</button>{` ${code(e.cell.level)} → ${code(e.to)}, saves ${e.saved}/week`}</li>
            ))}
          </ul>
        ) : <p className="small muted">{`No cell on ${p.project.name} meets the criteria for its next level right now.`}</p>}
        <p className="small muted">{`Estimated from this week's work orders per class: L0 and L1 need a person at every gate, L2 one in ${p.sampleRate}, L3 and up none (release still needs a person: L4 is not grantable). ${MIN_RUNS} or more finished runs make a rate; fewer show as insufficient data.`}</p>
      </div>
    </Panel>
  );
}

export const dmy = (t: number): string => (t ? new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "—");
/** The prototype's level chip: plain L<n>, L2 blue, L3 and up green. */
export const LevelChip = ({ level }: { level: number }) => <Chip text={`L${level}`} cls={level >= 3 ? "ok" : level === 2 ? "info" : "plain"} />;

/** What the ladder, its detail and the policy tabs read: the catalog, projects, trust data, one project's cells. Null until loaded. */
export function useLadderProps(projectId: string | null): LadderProps | null {
  const cat = useCatalog();
  const projects = ((useProjects().data ?? []) as Project[]).filter((x) => x.status !== "archived");
  const agentsData = useAgents().data;
  const all = useTrustCells();
  const lad = useTrustCells(projectId);
  const tr = all.data;
  const proj = projects.find((x) => x.id === projectId) ?? projects[0];
  if (!tr || !cat || !proj) return null;
  const cells = (tr.cells ?? []) as CellOut[];
  const scoped = ((projectId ? lad.data?.cells : null) ?? cells.filter((c) => c.project === proj.id)) as CellOut[];
  return {
    cat, project: proj, projects, cells: scoped.filter((c) => c.project === proj.id), proposals: tr.proposals ?? [], switchOn: tr.levelsAboveL1 === true, criteria: tr.criteria, sampleRate: tr.sampleRate,
    coverage: tr.coverage?.[proj.id] ?? { total: 0, auto: 0 }, agentName: (id) => (agentsData ?? []).find((a) => a.id === id)?.name ?? id, clsName: (id) => cat.classes.find((c) => c.id === id)?.name ?? id,
  };
}

function DemoteBtn({ cell, name, cls }: { cell: CellOut; name: string; cls: string }) {
  const ui_ = useUI();
  const out = useOutcome();
  const perm = useCan("trust.grant", { project: cell.project });
  return (
    <Btn label="Demote" small id={`tr-demote-${cell.id.replace(/\W/g, "-")}`} aria={`Demote ${name}, ${cls}`} guard={perm}
      onClick={() => ui_.reasonDialog({ title: `Demote ${name} · ${cls}`, kicker: "Trust · demotion", label: "Reason (required)", ok: `Demote to L${Math.max(0, cell.level - 1)}`, kind: "danger", min: 8, guard: perm,
        onOk: async (t) => out(await ops.grantTrust(cell.id, Math.max(0, cell.level - 1), t, { ifMatch: cell.rev })) })} />
  );
}

/** One cell's page, in a drawer: the project's matrix, the cell's evidence, history, next-level criteria and Change level, and the projection. */
export function CellDrawer({ projectId, close }: { projectId: string; close: () => void }) {
  useTrustUi();
  const p = useLadderProps(projectId);
  const rs = useAllRepos().repos.filter((r) => r.project === projectId);
  if (trustUi.repo && !rs.some((r) => r.id === trustUi.repo)) trustUi.repo = "";
  return (
    <div className="drawer-inner tr-celldrawer" id="tr-cell-drawer">
      <div className="drawer-head">
        <div><div className="kicker">Trust cell</div><h2 className="drawer-title">{p ? p.project.name : "Cell"}</h2></div>
        <IconBtn icon="x" label="Close" className="drawer-close" id="tr-cell-close" onClick={close} />
      </div>
      <div className="drawer-scroll">
        {p ? (
          <>
            <div className="toolbar tr-toolbar">
              <Field label="Repo" htmlFor="tr-repo"><Select id="tr-repo" value={trustUi.repo} options={[{ value: "", label: "All repos (project cells)" }, ...rs.map((r) => ({ value: r.id, label: r.name }))]} onChange={(v) => { trustUi.repo = v; rerender(); }} /></Field>
              <p className="small muted tr-toolbar-note">{trustUi.repo ? "Showing repo cells where they exist; other cells fall back to the project cell (marked proj)." : "Cells are agent × class on this project. A repo cell overrides the project cell."}</p>
            </div>
            <Panel title={`Ladder · ${p.project.name}`} flush cls="tr-matrix-panel"><Matrix p={p} rows={ladderRows(p.cat, p.project, p.cells)} /><Legend /></Panel>
            <div className="tr-ladder-grid"><Detail p={p} rows={ladderRows(p.cat, p.project, p.cells)} /><Projection p={p} rows={ladderRows(p.cat, p.project, p.cells)} /></div>
          </>
        ) : <Empty title="Loading" text="Reading the cell." />}
      </div>
    </div>
  );
}

/** The prototype's Ladder: every cell across the projects (agent, class, project, level, clean runs, since) with search, Level, Project and Agent filters; Demote opens a reason dialog. */
export function LadderTab({ cells, projects, switchOn, agentName, clsName }: { cells: CellOut[]; projects: Project[]; switchOn: boolean; agentName: (id: string) => string; clsName: (id: string) => string }) {
  const ui_ = useUI();
  const projName = (id: string): string => projects.find((x) => x.id === id)?.name ?? id;
  const agentIds = [...new Set(cells.map((c) => c.agent))];
  const open = (c: CellOut): void => { trustUi.project = c.project; trustUi.sel = { agent: c.agent, cls: c.cls }; trustUi.repo = c.repo || ""; ui_.drawer.open(`tr-cell:${c.id}`, (close) => <CellDrawer projectId={c.project} close={close} />); };
  return (
    <Panel title="Where each agent stands" flush cls="tr-matrix-panel">
      <div style={{ padding: "14px 14px 0" }}>
        <div className="callout tr-levels"><b>How levels work</b>{`L0 proposes only, L1 needs every gate, L2 skips routine gates, L3 acts alone on routine work with sampling, L4 needs no review. Ceilings cap a level regardless of record.${switchOn ? "" : " Levels above L1 are switched off."}`}</div>
      </div>
      <DataView id="tr-cells" noun="cell" rows={cells} rowKey={(c) => c.id} rowId={(c) => `tr-row-${c.id.replace(/\W/g, "-")}`} onRow={open} pageSize={12} text={(c) => `${c.id} ${agentName(c.agent)} ${clsName(c.cls)} ${projName(c.project)}`}
        filters={[
          { k: "level", label: "Level", opts: [0, 1, 2, 3, 4].map((n) => [String(n), `L${n}`]), fn: (c, v) => String(c.level) === v },
          { k: "project", label: "Project", opts: projects.map((x) => [x.id, x.name]), fn: (c, v) => c.project === v },
          { k: "agent", label: "Agent", opts: agentIds.map((a) => [a, agentName(a)]), fn: (c, v) => c.agent === v },
        ]}
        empty={{ title: "No cells yet", text: "A person sets the first level, or the system proposes one when the criteria are met." }}
        columns={[
          { key: "a", label: "Agent", sort: (c) => agentName(c.agent), render: (c) => agentName(c.agent) },
          { key: "c", label: "Class", sort: (c) => clsName(c.cls), render: (c) => clsName(c.cls) },
          { key: "p", label: "Project", sort: (c) => projName(c.project), render: (c) => projName(c.project) },
          { key: "l", label: "Level", sort: (c) => c.level, render: (c) => <LevelChip level={c.level} /> },
          { key: "r", label: "Clean runs", align: "end", sort: (c) => c.evidence?.cleanRuns ?? c.cleanRuns, render: (c) => <span className="num">{c.evidence?.cleanRuns ?? c.cleanRuns}</span> },
          { key: "s", label: "Since", render: (c) => dmy(c.since) },
          { key: "x", label: "", align: "end", render: (c) => (c.level > 0 ? <DemoteBtn cell={c} name={agentName(c.agent)} cls={clsName(c.cls)} /> : null) },
        ]} />
    </Panel>
  );
}
