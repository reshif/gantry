/**
 * The top of a work order page: the way back, the title with its class, priority, station and agent, one line saying what is
 * happening, the route as a rail with its gates, banners for anything that stops the work, and the actions the viewer may take.
 * Everything shown comes from the work order read; locked actions say why.
 */
import { WO_STATES, fmt, type Catalog, type Project } from "@gantry/domain";
import { Btn, Chip, StateChip, useCopy } from "../../ui/primitives";
import { reasonText } from "../../ui/primitives";
import { PipelineRow } from "../../ui/pipeline";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { navigate, hashFor } from "../../lib/router";
import { ClassChip, classOf } from "../projects/kit";
import { useActionSpecs, type ActionSpec } from "../traveler/Actions";
import { bayLabel, stName, stNo, type TWo } from "../traveler/model";
import type { WoSession } from "../conversations/session-api";
import { railOf } from "./rail";

const unique = <T,>(xs: T[]): T[] => [...new Set(xs)];

/** The Move and More menus plus the rest of the actions, as one toolbar. */
function ActionBar({ wo, onActivity }: { wo: TWo; onActivity: () => void }) {
  const ui = useUI();
  const specs = useActionSpecs(wo);
  if (!specs) return null;
  const of = (g: ActionSpec["group"]) => specs.filter((s) => s.group === g);
  const btn = (a: ActionSpec) => <Btn key={a.key} label={a.label} {...(a.kind ? { kind: a.kind } : {})} icon={a.icon} id={a.id} {...(a.aria ? { aria: a.aria } : {})} guard={a.guard} onClick={a.onClick} />;
  const menu = (title: string, items: ActionSpec[]) => (anchor: HTMLElement) =>
    ui.menu(anchor, title, items.map((a) => ({ label: a.label, icon: a.icon, guard: a.guard, onClick: a.onClick })));
  const move = of("move");
  const more = of("more");
  const locked = specs.filter((s) => s.guard && !s.guard.allowed);
  // one line per reason, so six locked buttons with the same cause read as one sentence
  const reasons = unique(locked.map((s) => reasonText(s.guard!))).filter(Boolean);
  const lines = reasons.map((r) => ({ r, items: locked.filter((s) => reasonText(s.guard!) === r).map((s) => s.label) }));
  const why = specs.find((s) => s.why);
  return (
    <>
      <div className="dz-actions" role="toolbar" aria-label="Work order actions">
        {of("decide").map(btn)}
        {of("main").map(btn)}
        <Btn label="Open conversation" icon="send" id="trv-open-conversation" onClick={onActivity} />
        {move.length ? <Btn label="Move" icon="swap" id="dz-move" aria="Move this work order" onClick={(e) => menu("Move", move)(e.currentTarget)}><Icon name="down" /></Btn> : null}
        {of("inline").map(btn)}
        {more.length ? <Btn label="More" icon="dots" id="dz-more" aria="More actions" onClick={(e) => menu("Line control", more)(e.currentTarget)} /> : null}
      </div>
      {why?.why ? <p className="small muted trv-why" id="trv-approve-why" role="note">{why.why}</p> : null}
      {lines.map((l) => (
        <div key={l.r} className="dz-lockline">
          <Icon name="lock" />
          <span><b>{`${l.items.join(", ")} locked.`}</b>{` ${l.r}`}</span>
        </div>
      ))}
    </>
  );
}

/** One line on what the work order is doing right now, from the work order read and, when there is one, its conversation. */
export function statusLine(wo: TWo, cat: Catalog, s: WoSession | undefined): string {
  if (wo.killed) return `Killed by ${wo.killed.by}: ${wo.killed.reason}`;
  if (wo.state === "done") return wo.split ? "Split into child work orders" : `Shipped ${fmt.stamp(wo.doneAt ?? 0)}`;
  if (wo.bay) return `Off the belt in ${bayLabel(cat, wo.bay)}${wo.bayReason ? `: ${wo.bayReason}` : ""}`;
  if (s?.next.text) return s.next.text;
  const st = cat.stations[wo.station];
  return `At ${stNo(cat, st?.id)} ${stName(cat, st?.id)}`.trim();
}

export function DossierHead({ wo, cat, project, session, onActivity }: { wo: TWo; cat: Catalog; project: Project; session: WoSession | undefined; onActivity: () => void }) {
  const copy = useCopy();
  const actor = useActors();
  const st = cat.stations[wo.state === "done" ? cat.stations.length - 1 : wo.station];
  const heldByKill = (wo as { heldByKill?: boolean | string }).heldByKill;
  const stop = wo.stop;
  const halt = stop?.mode === "halt" ? stop : null;
  const steps = railOf(wo, cat, project);
  const nobody = session?.next.actor === "nobody" || wo.state === "done";
  const stateLabel = (WO_STATES as Record<string, { label: string }>)[wo.state]?.label ?? wo.state;
  return (
    <header className="dz-head card" id="dz-head">
      <div className="body">
        <nav className="dz-back" aria-label="Work order navigation">
          <a href={hashFor("work-orders", null, wo.project)} onClick={(e) => { e.preventDefault(); navigate("work-orders", null, wo.project); }}><Icon name="back" />Work orders</a>
          <span className="grow" />
          <Btn label="Copy link" small kind="ghost" icon="copy" id="dz-link" onClick={() => copy(`${window.location.origin}${window.location.pathname}${hashFor("record", wo.id, wo.project)}`)} />
        </nav>
        <div className="dz-title">
          <div className="dz-chips">
            <span className="mono dz-id">{wo.id}</span>
            <ClassChip cls={classOf(cat, project, wo.cls)} />
            <span className={`chip prio-${wo.priority}`}>{wo.priority}</span>
            {wo.bay ? <Chip text={`${bayLabel(cat, wo.bay)} bay`} cls="chip-warn" /> : wo.state !== "done" && st ? <Chip text={`${st.no} ${st.name}`} /> : null}
            {heldByKill ? <Chip text={`Held by ${typeof heldByKill === "string" ? heldByKill : wo.stop?.scope ?? ""} kill`} cls="chip-block" /> : null}
          </div>
          <h1>{wo.title}</h1>
          <div className="dz-stline" role="status">
            <StateChip state={wo.state} />
            <span className="muted">{statusLine(wo, cat, session)}</span>
          </div>
        </div>
        {steps.length ? (
          <div className="dz-rail">
            <PipelineRow steps={steps} label={`Route of ${wo.id}: ${stateLabel}`} />
            <div className="dz-next">{nobody ? <span><b>Nobody is running it.</b>{wo.state === "done" ? " It has shipped." : ""}</span> : session ? <span><b>{{ agent: session.agent.name, you: "You", approver: "An approver", person: "Someone else", nobody: "Nobody" }[session.next.actor]}</b>{` is next. ${session.next.text}`}</span> : null}</div>
          </div>
        ) : null}
        {wo.killed ? (
          <div className="callout callout-block" role="alert">
            <Icon name="st-kill" />
            <div><b>Killed</b>{` ${wo.killed.scope} kill by ${actor(wo.killed.by).name}, ${fmt.stamp(wo.killed.at)}: ${wo.killed.reason}${wo.pr ? `. PR #${wo.pr.number} left as ${wo.pr.state}.` : "."}`}</div>
          </div>
        ) : null}
        {!wo.killed && stop ? (
          <div className="callout callout-warn" role="alert">
            <Icon name="halt" />
            <div><b>Stopped</b>{` ${stop.reason}${heldByKill ? " It is held in place and resumes on restore." : ""}`}</div>
          </div>
        ) : null}
        {halt && !stop ? null : null}
        {wo.blockReason ? <div className="callout callout-block"><Icon name="st-block" /><div><b>Blocked</b>{` ${wo.blockReason}`}</div></div> : null}
        {wo.failReason ? <div className="callout callout-fail"><Icon name="st-fail" /><div><b>Failed</b>{` ${wo.failReason}`}</div></div> : null}
        <ActionBar wo={wo} onActivity={onActivity} />
      </div>
    </header>
  );
}
