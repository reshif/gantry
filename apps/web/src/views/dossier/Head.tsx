/**
 * The top of a work order page: the way back, the title with its class, priority, station and agent, one line saying what is
 * happening, the route as a rail with its gates, banners for anything that stops the work, and the actions the viewer may take.
 * Everything shown comes from the work order read; locked actions say why.
 */
import { WO_STATES, fmt, type Catalog, type Project } from "@gantry/domain";
import { Btn, Chip, Who } from "../../ui/primitives";
import { reasonText } from "../../ui/primitives";
import { PipelineRow } from "../../ui/pipeline";
import { Icon } from "../../ui/Icon";
import { CrIcon } from "../../ui/cr";
import { useUI, type MenuItem } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { hashFor } from "../../lib/router";
import { useActionSpecs, type ActionSpec } from "../traveler/Actions";
import { bayLabel, stName, stNo, type TWo } from "../traveler/model";
import type { WoSession } from "../conversations/session-api";
import { railOf } from "./rail";


/** The prototype's "Review G5" dialog: the rule and what is still open, with Cancel, Reject and Approve (each locked with its reason when the viewer may not). */
export function openReview(ui: ReturnType<typeof useUI>, wo: TWo, specs: ActionSpec[]) {
  const approve = specs.find((a) => a.key === "approve");
  const reject = specs.find((a) => a.key === "reject");
  const gate = wo.allowed.approve?.gate ?? "";
  if (!approve) return;
  const gp = wo.gateProgress[gate];
  ui.dialog({
    title: approve.label.startsWith("Approve") ? `Review ${gate}` : approve.label,
    sub: `${wo.id} · ${wo.title}`,
    body: (
      <>
        {approve.guard && !approve.guard.allowed ? <div className="banner warn"><Icon name="lock" /><div className="grow">{reasonText(approve.guard)}</div></div> : null}
        {gp ? <dl className="kv"><dt>Rule</dt><dd>{`${gp.need} approver${gp.need > 1 ? "s, different people" : ""} (${gp.have} of ${gp.need} so far)`}</dd></dl> : null}
        {gp?.unmet.length ? <div><div className="label" style={{ marginBottom: 4 }}>Still open</div><ul className="list">{gp.unmet.map((u) => <li key={u.id} className="li">{u.text}</li>)}</ul></div> : null}
      </>
    ),
    actions: [
      { label: "Cancel" },
      ...(reject ? [{ label: "Reject", kind: "danger", guard: reject.guard, onClick: (close: () => void) => { close(); reject.onClick(); } }] : []),
      { label: approve.guard && !approve.guard.allowed ? "Approve (not allowed)" : "Approve", kind: "ok", id: "trv-approve", guard: approve.guard, onClick: (close: () => void) => { close(); approve.onClick(); } },
    ],
  });
}

/** The Review button of a work order page and the Changes page: opens the review dialog, and is absent when no gate waits for this viewer. */
export function ReviewBtn({ wo, id }: { wo: TWo; id: string }) {
  const ui = useUI();
  const specs = useActionSpecs(wo);
  const gate = wo.allowed.approve?.gate;
  if (!specs || !gate || !specs.some((a) => a.key === "approve")) return null;
  return <Btn label={`Review ${gate}`} kind="ok" id={id} onClick={() => openReview(ui, wo, specs)} />;
}

/** The Move and More menus plus the rest of the actions, as one toolbar. */
function ActionBar({ wo, lead, children }: { wo: TWo; lead?: React.ReactNode; children: (bar: React.ReactNode, notes: React.ReactNode) => React.ReactNode }) {
  const ui = useUI();
  const specs = useActionSpecs(wo);
  if (!specs) return <>{children(<div className="acts" role="toolbar" aria-label="Work order actions">{lead}</div>, null)}</>;
  const of = (g: ActionSpec["group"]) => specs.filter((s) => s.group === g);
  // the prototype's wording for the Actions menu; the stop item is last, set apart
  const PROTO: Record<string, string> = { reassign: "Reassign", park: "Park", sendback: "Send back a station", kill: "Stop this work order\u2026" };
  const menu = (title: string, items: ActionSpec[]) => (anchor: HTMLElement) => {
    const ordered = [...items.filter((a) => a.key !== "kill"), ...items.filter((a) => a.key === "kill")];
    ui.menu(anchor, title, ordered.flatMap((a): MenuItem[] => [...(a.key === "kill" && ordered.length > 1 ? [{ sep: true }] : []), { label: PROTO[a.key] ?? a.label, icon: a.icon, ...(a.kind ? { kind: a.kind } : {}), guard: a.guard, onClick: a.onClick }]));
  };
  const move = of("move");
  const more = of("more");
  const why = specs.find((s) => s.why);
  const approve = of("decide").find((a) => a.key === "approve");
  const gate = wo.allowed.approve?.gate ?? "";
  const review = () => openReview(ui, wo, specs);
  const bar = (
    <div className="acts dz-actions" role="toolbar" aria-label="Work order actions">
      {lead}
      {approve ? <Btn label={`Review ${gate}`} kind="ok" id="dz-review" onClick={review} /> : null}
      {[...move, ...of("main"), ...of("inline"), ...more].length ? (
        <Btn label="Actions" id="dz-more" aria="Move, reassign, line control and other actions" onClick={(e) => menu("Actions", [...of("main"), ...of("inline"), ...move, ...more])(e.currentTarget)}><CrIcon name="chevd" /></Btn>
      ) : null}
    </div>
  );
  const notes = (
    <>
      {why?.why ? <p className="small muted trv-why" id="trv-approve-why" role="note">{why.why}</p> : null}
    </>
  );
  return <>{children(bar, notes)}</>;
}

/** One line on what the work order is doing right now, from the work order read and, when there is one, its conversation. */
export function statusLine(wo: TWo, cat: Catalog, s: WoSession | undefined): string {
  if (wo.killed) return `Held in place by a ${wo.killed.scope} kill, ${fmt.stamp(wo.killed.at)}`;
  if (wo.state === "done") return wo.split ? "Split into child work orders" : `Shipped ${fmt.stamp(wo.doneAt ?? 0)}`;
  if (wo.bay) return `Off the belt in ${bayLabel(cat, wo.bay)}${wo.bayReason ? `: ${wo.bayReason}` : ""}`;
  if (s?.next.text) return s.next.text;
  const st = cat.stations[wo.station];
  return `At ${stNo(cat, st?.id)} ${stName(cat, st?.id)}`.trim();
}

export function DossierHead({ wo, cat, project, session }: { wo: TWo; cat: Catalog; project: Project; session: WoSession | undefined }) {
  const actor = useActors();
  const heldByKill = (wo as { heldByKill?: boolean | string }).heldByKill;
  const stop = wo.stop;
  const steps = railOf(wo, cat, project);
  const nobody = session?.next.actor === "nobody" || wo.state === "done";
  const stateLabel = (WO_STATES as Record<string, { label: string }>)[wo.state]?.label ?? wo.state;
  const repo = wo.repo;
  const age = fmt.dur(Date.now() - wo.createdAt);
  const sla = wo.slaDue ? (wo.slaDue > Date.now() ? `SLA in ${fmt.dur(wo.slaDue - Date.now())}` : `SLA missed by ${fmt.dur(Date.now() - wo.slaDue)}`) : "";
  const plainStation = !wo.killed && !wo.bay && wo.state !== "done";
  const tone = ({ running: "info", waiting: "warn", blocked: "bad", failed: "bad", done: "ok", killed: "bad" } as Record<string, string>)[wo.state] ?? "idle";
  const lead = (
    <>
      <a className="btn" id="rec-traveler" href={hashFor("traveler", wo.id, wo.project)}>Traveler</a>
      <a className="btn" id="rec-dossier" href={hashFor("dossier", wo.id, wo.project)}>Dossier</a>
      <a className="btn" id="rec-changes" href={hashFor("changes", wo.id, wo.project)}>Changes</a>
    </>
  );
  return (
    <div id="dz-head" className="dz-top">
      <ActionBar wo={wo} lead={lead}>
        {(bar, notes) => (
          <>
            <header className="ph dz-ph">
              <div>
                <div className="eyebrow">{`Work order · ${wo.id}`}</div>
                <h1>{wo.title}</h1>
                <p className="sub">{`${project.name} · ${repo} · requested by ${actor(wo.requestedBy).name}`}</p>
              </div>
              {bar}
            </header>
            {notes}
          </>
        )}
      </ActionBar>
      <section className="card dz-strip">
        <div className="card-b">
          <div className="row spread dz-stripline">
            <div className="row dz-chips">
              <span className={`chip ${tone}`} role="status">{wo.state === "waiting" && wo.allowed.approve ? `At gate ${wo.allowed.approve.gate}` : stateLabel}</span>
              <span className={`tag pri ${wo.priority.toLowerCase()}`} title={`Priority ${wo.priority}`}>{wo.priority}</span>
              <span className="tag">{wo.cls}</span>
              {heldByKill ? <Chip text={`Held by ${typeof heldByKill === "string" ? heldByKill : wo.stop?.scope ?? ""} kill`} cls="chip-block" /> : null}
              {plainStation ? <><span className="dim">at</span><b>{cat.stations[wo.station]?.name}</b>{cat.stations[wo.station] ? <><span className="dim">with</span><Who id={cat.stations[wo.station]?.agent} /></> : null}</> : <span className="dz-stline muted">{statusLine(wo, cat, session)}</span>}
            </div>
            <div className="row">
              <span className="mono dim dz-age">{`opened ${age} ago${sla ? ` · ${sla}` : ""}`}</span>
            </div>
          </div>
          {steps.length ? (
            <div className="dz-rail">
              <PipelineRow steps={steps} label={`Route of ${wo.id}: ${stateLabel}`} />
              <div className="dz-next">{nobody ? <span><b>Nobody is running it.</b>{wo.state === "done" ? " It has shipped." : ""}</span> : session ? <span><b>{{ agent: session.agent.name, you: "You", approver: "An approver", person: "Someone else", nobody: "Nobody" }[session.next.actor]}</b>{` is next. ${session.next.text}`}</span> : null}</div>
            </div>
          ) : null}
        </div>
      </section>
      {wo.killed ? (
        <div className="banner bad" role="alert">
          <Icon name="st-kill" />
          <div className="grow"><b>Killed</b>{` ${wo.killed.scope} kill by ${actor(wo.killed.by).name}, ${fmt.stamp(wo.killed.at)}: ${wo.killed.reason}${wo.pr ? `. PR #${wo.pr.number} left as ${wo.pr.state}.` : "."}`}</div>
        </div>
      ) : null}
      {!wo.killed && stop ? (
        <div className="banner warn" role="alert">
          <Icon name="halt" />
          <div className="grow"><b>Stopped</b>{` ${stop.reason}${heldByKill ? " It is held in place and resumes on restore." : ""}`}</div>
        </div>
      ) : null}
      {wo.blockReason ? <div className="banner bad"><Icon name="st-block" /><div className="grow"><b>Blocked</b>{` ${wo.blockReason}`}</div></div> : null}
      {wo.failReason ? <div className="banner bad"><Icon name="st-fail" /><div className="grow"><b>Failed</b>{` ${wo.failReason}`}</div></div> : null}
    </div>
  );
}
