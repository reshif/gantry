/**
 * The top of a work order page: the way back, the title with its class, priority, station and agent, one line saying what is
 * happening, the route as a rail with its gates, banners for anything that stops the work, and the actions the viewer may take.
 * Everything shown comes from the work order read; locked actions say why.
 */
import { WO_STATES, fmt, type Catalog, type Project } from "@gantry/domain";
import { WoStatus } from "./stateTone";
import { Btn, Chip, ViewHead, useCopy } from "../../ui/primitives";
import { useRepoName } from "../traveler/repo";
import { reasonText } from "../../ui/primitives";
import { PipelineRow } from "../../ui/pipeline";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { navigate, hashFor } from "../../lib/router";
import { updatePrefs } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { ClassChip, classOf } from "../projects/kit";
import { useActionSpecs, type ActionSpec } from "../traveler/Actions";
import { bayLabel, stName, stNo, type TWo } from "../traveler/model";
import type { WoSession } from "../conversations/session-api";
import { railOf } from "./rail";

const unique = <T,>(xs: T[]): T[] => [...new Set(xs)];

/** The toolbar of a work order: the gate decision, Traveler, Changes and one Actions menu (prototype). Locked items say why, in the menu and as one line each. */
function useBar(wo: TWo, onActivity: () => void) {
  const ui = useUI();
  const copy = useCopy();
  const copyLink = () => copy(`${window.location.origin}${window.location.pathname}${hashFor("record", wo.id, wo.project)}`);
  const specs = useActionSpecs(wo);
  const openTraveler = useOpenTraveler();
  if (!specs) return { actions: null, notes: null };
  const of = (g: ActionSpec["group"]) => specs.filter((s) => s.group === g);
  const btn = (a: ActionSpec) => <Btn key={a.key} label={a.label} {...(a.kind ? { kind: a.kind } : {})} icon={a.icon} id={a.id} {...(a.aria ? { aria: a.aria } : {})} guard={a.guard} onClick={a.onClick} />;
  const rest = [...of("main"), ...of("move"), ...of("inline"), ...of("more")];
  const locked = specs.filter((s) => s.guard && !s.guard.allowed);
  // one line per reason, so six locked buttons with the same cause read as one sentence
  const reasons = unique(locked.map((s) => reasonText(s.guard!))).filter(Boolean);
  const lines = reasons.map((r) => ({ r, items: locked.filter((s) => reasonText(s.guard!) === r).map((s) => s.label) }));
  const why = specs.find((s) => s.why);
  const actions = (
    <div className="row dz-actions" role="toolbar" aria-label="Work order actions">
      {of("decide").map(btn)}
      <Btn label="Traveler" icon="list" id="rec-traveler" onClick={() => openTraveler(wo.id)} />
      <Btn label="Changes" icon="branch" id="rec-changes" onClick={() => navigate("changes", wo.id)} />
      <Btn label="Actions" icon="down" id="dz-actions" aria="Work order actions" aria-haspopup="menu" onClick={(e) => ui.menu(e.currentTarget, "Work order actions", [
        { label: "Open conversation", icon: "send", onClick: onActivity },
        { label: "Copy link", icon: "copy", onClick: () => copyLink() },
        ...rest.map((a) => ({ label: a.label, icon: a.icon, ...(a.kind ? { kind: a.kind } : {}), guard: a.guard, onClick: a.onClick })),
      ])} />
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
  return { actions, notes };
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
  const actor = useActors();
  const repo = useRepoName(wo.project, wo.repo);
  const bar = useBar(wo, onActivity);
  const st = cat.stations[wo.state === "done" ? cat.stations.length - 1 : wo.station];
  const heldByKill = (wo as { heldByKill?: boolean | string }).heldByKill;
  const stop = wo.stop;
  const steps = railOf(wo, cat, project);
  const nobody = session?.next.actor === "nobody" || wo.state === "done";
  const stateLabel = (WO_STATES as Record<string, { label: string }>)[wo.state]?.label ?? wo.state;
  return (
    <div className="dz-head" id="dz-head">
      <ViewHead
        kicker={
          <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
            <a href={hashFor("work-orders", null, wo.project)} onClick={(e) => { e.preventDefault(); navigate("work-orders", null, wo.project); }}>Work orders</a>
            <span aria-hidden="true">/</span>
            <span>{wo.id}</span>
            <a href={hashFor("record", null, wo.project)} onClick={(e) => { e.preventDefault(); updatePrefs({ record: null }); navigate("record"); }} id="rec-all">All records</a>
          </span>
        }
        title={wo.title}
        sub={`${project.name} · ${repo} · requested by ${actor(wo.requestedBy).name} ${fmt.dur(Date.now() - wo.createdAt)} ago`}
        actions={bar.actions}
      />
      <div className="row dz-chips" style={{ margin: "-6px 0 14px" }}>
        <WoStatus state={wo.state} />
        <ClassChip cls={classOf(cat, project, wo.cls)} />
        <span className={`chip prio-${wo.priority}`}>{wo.priority}</span>
        {wo.bay ? <Chip text={`${bayLabel(cat, wo.bay)} bay`} cls="chip-warn" /> : wo.state !== "done" && st ? <Chip text={`${st.no} ${st.name}`} /> : null}
        {heldByKill ? <Chip text={`Held by ${typeof heldByKill === "string" ? heldByKill : wo.stop?.scope ?? ""} kill`} cls="chip-block" /> : null}
        <span className="muted small" role="status">{statusLine(wo, cat, session)}</span>
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
      {wo.blockReason ? <div className="callout callout-block"><Icon name="st-block" /><div><b>Blocked</b>{` ${wo.blockReason}`}</div></div> : null}
      {wo.failReason ? <div className="callout callout-fail"><Icon name="st-fail" /><div><b>Failed</b>{` ${wo.failReason}`}</div></div> : null}
      {bar.notes}
    </div>
  );
}
