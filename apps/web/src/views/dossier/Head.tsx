/**
 * The top of a work order page: the way back, the title with its class, priority, station and agent, one line saying what is
 * happening, the route as a rail with its gates, banners for anything that stops the work, and the actions the viewer may take.
 * Everything shown comes from the work order read; locked actions say why.
 */
import { WO_STATES, fmt, type Catalog, type Project } from "@gantry/domain";
import { Btn, Chip, useCopy } from "../../ui/primitives";
import { reasonText } from "../../ui/primitives";
import { PipelineRow } from "../../ui/pipeline";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { navigate, hashFor } from "../../lib/router";
import { updatePrefs } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { classOf } from "../projects/kit";
import { useActionSpecs, type ActionSpec } from "../traveler/Actions";
import { bayLabel, stName, stNo, type TWo } from "../traveler/model";
import type { WoSession } from "../conversations/session-api";
import { railOf } from "./rail";

const unique = <T,>(xs: T[]): T[] => [...new Set(xs)];

/** The Move and More menus plus the rest of the actions, as one toolbar. */
function ActionBar({ wo, onActivity, lead, children }: { wo: TWo; onActivity: () => void; lead?: React.ReactNode; children: (bar: React.ReactNode, notes: React.ReactNode) => React.ReactNode }) {
  const ui = useUI();
  const specs = useActionSpecs(wo);
  if (!specs) return <>{children(<div className="acts" role="toolbar" aria-label="Work order actions">{lead}</div>, null)}</>;
  const of = (g: ActionSpec["group"]) => specs.filter((s) => s.group === g);
  const btn = (a: ActionSpec) => <Btn key={a.key} label={a.label} {...(a.kind ? { kind: a.kind } : {})} icon={a.icon} id={a.id} {...(a.aria ? { aria: a.aria } : {})} guard={a.guard} onClick={a.onClick} />;
  const menu = (title: string, items: ActionSpec[]) => (anchor: HTMLElement) =>
    ui.menu(anchor, title, items.map((a) => ({ label: a.label, icon: a.icon, ...(a.kind ? { kind: a.kind } : {}), guard: a.guard, onClick: a.onClick })));
  const move = of("move");
  const more = of("more");
  const locked = specs.filter((s) => s.guard && !s.guard.allowed);
  // one line per reason, so six locked buttons with the same cause read as one sentence
  const reasons = unique(locked.map((s) => reasonText(s.guard!))).filter(Boolean);
  const lines = reasons.map((r) => ({ r, items: locked.filter((s) => reasonText(s.guard!) === r).map((s) => s.label) }));
  const why = specs.find((s) => s.why);
  const bar = (
    <div className="acts dz-actions" role="toolbar" aria-label="Work order actions">
      {lead}
      {of("decide").map(btn)}
      <Btn label="Open conversation" icon="send" id="trv-open-conversation" onClick={onActivity} />
      {[...move, ...of("main"), ...of("inline"), ...more].length ? (
        <Btn label="Actions" icon="down" id="dz-more" aria="Move, reassign, line control and other actions" onClick={(e) => menu("Actions", [...of("main"), ...of("inline"), ...move, ...more])(e.currentTarget)}><Icon name="down" /></Btn>
      ) : null}
    </div>
  );
  const notes = (
    <>
      {why?.why ? <p className="small muted trv-why" id="trv-approve-why" role="note">{why.why}</p> : null}
      {lines.map((l) => (
        <div key={l.r} className="dz-lockline">
          <Icon name="lock" />
          <span><b>{`${l.items.join(", ")} locked.`}</b>{` ${l.r}`}</span>
        </div>
      ))}
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

export function DossierHead({ wo, cat, project, session, onActivity }: { wo: TWo; cat: Catalog; project: Project; session: WoSession | undefined; onActivity: () => void }) {
  const copy = useCopy();
  const openTraveler = useOpenTraveler();
  const actor = useActors();
  const heldByKill = (wo as { heldByKill?: boolean | string }).heldByKill;
  const stop = wo.stop;
  const steps = railOf(wo, cat, project);
  const nobody = session?.next.actor === "nobody" || wo.state === "done";
  const stateLabel = (WO_STATES as Record<string, { label: string }>)[wo.state]?.label ?? wo.state;
  const repo = wo.repo;
  const age = fmt.dur(Date.now() - wo.createdAt);
  const sla = wo.slaDue ? (wo.slaDue > Date.now() ? `SLA in ${fmt.dur(wo.slaDue - Date.now())}` : `SLA missed by ${fmt.dur(Date.now() - wo.slaDue)}`) : "";
  const tone = ({ running: "info", waiting: "warn", blocked: "bad", failed: "bad", done: "ok", killed: "bad" } as Record<string, string>)[wo.state] ?? "idle";
  const lead = (
    <>
      <Btn label="Traveler" id="rec-traveler" onClick={() => openTraveler(wo.id)} />
      <Btn label="Changes" id="rec-changes" onClick={() => navigate("changes", wo.id, wo.project)} />
    </>
  );
  return (
    <div id="dz-head" className="dz-top">
      <ActionBar wo={wo} onActivity={onActivity} lead={lead}>
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
              <span className={`chip ${tone}`} role="status">{stateLabel}</span>
              <span className={`tag pri ${wo.priority.toLowerCase()}`} title={`Priority ${wo.priority}`}>{wo.priority}</span>
              <span className="tag">{classOf(cat, project, wo.cls).name}</span>
              {heldByKill ? <Chip text={`Held by ${typeof heldByKill === "string" ? heldByKill : wo.stop?.scope ?? ""} kill`} cls="chip-block" /> : null}
              <span className="dz-stline muted">{statusLine(wo, cat, session)}</span>
            </div>
            <div className="row">
              <span className="mono dim dz-age">{`opened ${age} ago${sla ? ` · ${sla}` : ""}`}</span>
              <Btn label="All records" small kind="ghost" id="rec-all" onClick={() => { updatePrefs({ record: null }); navigate("record"); }} />
              <Btn label="Copy link" small kind="ghost" icon="copy" id="dz-link" onClick={() => copy(`${window.location.origin}${window.location.pathname}${hashFor("record", wo.id, wo.project)}`)} />
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
