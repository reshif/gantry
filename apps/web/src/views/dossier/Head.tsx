/**
 * The top of a work order page: the way back, the title with its class, priority, station and agent, one line saying what is
 * happening, the route as a rail with its gates, banners for anything that stops the work, and the actions the viewer may take.
 * Everything shown comes from the work order read; locked actions say why.
 */
import { fmt, type Catalog, type Project } from "@gantry/domain";
import { WoStatus } from "./stateTone";
import { ago } from "./time";
import { Btn, Chip, ViewHead } from "../../ui/primitives";
import { useRepoName } from "../traveler/repo";
import { Icon } from "../../ui/Icon";
import { WoActions } from "../work/WoActions";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { navigate, hashFor } from "../../lib/router";
import { classOf } from "../projects/kit";
import { useActionSpecs, type ActionSpec } from "../traveler/Actions";
import { EditTitleDialog, PriorityDialog } from "../record/GateDialogs";
import { bayLabel, stName, stNo, wipWaitText, type TWo } from "../traveler/model";
import type { WoSession } from "../conversations/session-api";

/** The toolbar of a work order (prototype): the gate decision, Traveler, Changes and one Actions menu. Locked items say why, in their tooltip. */
function useBar(wo: TWo) {
  const ui = useUI();
  const specs = useActionSpecs(wo, true);
  if (!specs) return { actions: null, notes: null };
  const by = (k: string) => specs.find((s) => s.key === k);
  const item = (a: ActionSpec | undefined, label?: string) => (a ? [{ label: label ?? a.label, icon: a.icon, ...(a.kind ? { kind: a.kind } : {}), guard: a.guard, onClick: a.onClick }] : []);
  const btn = (a: ActionSpec) => <Btn key={a.key} label={a.label} small={a.group === "decide"} {...(a.kind ? { kind: a.kind } : {})} icon={a.icon} id={a.id} {...(a.aria ? { aria: a.aria } : {})} guard={a.guard} onClick={a.onClick} />;
  const why = specs.find((s) => s.why);
  const actions = (
    <div className="row dz-actions" role="toolbar" aria-label="Work order actions">
      {specs.filter((s) => s.group === "decide" || s.key === "retry" || s.key === "wipOverride").map(btn)}
      <WoActions wo={wo.id} project={wo.project} repo={wo.repo} idPrefix="rec" omit={["primary", "record"]} small={false} />
      <Btn label="Traveler" icon="list" id="rec-traveler" onClick={() => navigate("traveler", wo.id, wo.project)} />
      <Btn label="Changes" icon="branch" id="rec-changes" onClick={() => navigate("changes", wo.id, wo.project)} />
      <Btn label="Actions" icon="down" id="dz-actions" aria="Work order actions" aria-haspopup="menu" onClick={(e) => ui.menu(e.currentTarget, null, [
        { label: "Edit title", icon: "edit", guard: wo.allowed?.can?.["edit"], onClick: () => void ui.open((close) => <EditTitleDialog wo={wo} onClose={close} />) },
        { label: "Change priority", icon: "filter", guard: wo.allowed?.can?.["edit"], onClick: () => void ui.open((close) => <PriorityDialog wo={wo} onClose={close} />) },
        ...item(by("sendback"), "Send back to a station"),
        ...item(by("redo")),
        ...item(by("reassign")),
        ...item(by("unpark") ?? by("park")),
        { sep: true },
        ...item(by("kill")),
      ])} />
    </div>
  );
  const notes = why?.why ? <p className="small muted trv-why" id="trv-approve-why" role="note">{why.why}</p> : null;
  return { actions, notes };
}

/** One line on what the work order is doing right now, from the work order read and, when there is one, its conversation. */
export function statusLine(wo: TWo, cat: Catalog, s: WoSession | undefined): string {
  if (wo.killed) return `Held in place by a ${wo.killed.scope} kill, ${fmt.stamp(wo.killed.at)}`;
  if (wo.state === "done") return wo.split ? "Split into child work orders" : `Shipped ${fmt.stamp(wo.doneAt ?? 0)}`;
  if (wo.bay) return `Off the belt in ${bayLabel(cat, wo.bay)}${wo.bayReason ? `: ${wo.bayReason}` : ""}`;
  if (wo.wipWait && wo.state === "waiting") return wipWaitText(cat, wo);
  if (s?.next.text) return s.next.text;
  const st = cat.stations[wo.station];
  return `At ${stNo(cat, st?.id)} ${stName(cat, st?.id)}`.trim();
}

export function DossierHead({ wo, cat, project }: { wo: TWo; cat: Catalog; project: Project; session: WoSession | undefined; onActivity?: () => void }) {
  const actor = useActors();
  const repo = useRepoName(wo.project, wo.repo);
  const bar = useBar(wo);
  const st = cat.stations[wo.state === "done" ? cat.stations.length - 1 : wo.station];
  const heldByKill = (wo as { heldByKill?: boolean | string }).heldByKill;
  const stop = wo.stop;
  const gate = Object.entries(wo.gates ?? {}).find(([, g]) => g.status === "waiting")?.[0] ?? null;
  const cls = classOf(cat, project, wo.cls);
  return (
    <div className="dz-head" id="dz-head">
      <ViewHead
        plain
        kicker={
          <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
            <a href={hashFor("work-orders", null, wo.project)} onClick={(e) => { e.preventDefault(); navigate("work-orders", null, wo.project); }}>Work orders</a>
            <span aria-hidden="true">/</span>
            <span>{wo.id}</span>
          </span>
        }
        title={wo.title}
        sub={`${project.name} · ${repo} · requested by ${actor(wo.requestedBy).name} ${ago(wo.createdAt)}`}
        actions={bar.actions}
      />
      <div className="row dz-chips" style={{ margin: "-6px 0 16px" }}>
        <WoStatus state={wo.state} gate={gate} bay={wo.bay ? bayLabel(cat, wo.bay) : null} />
        <Chip text={cls.name} cls="ghost plain" />
        <Chip text={wo.priority} cls={wo.priority === "P0" || wo.priority === "P1" ? "bad" : wo.priority === "P2" ? "info" : "plain"} />
        {wo.state !== "done" && st ? <Chip text={`${st.no} ${st.name}`} cls="plain" /> : null}
        {wo.risk && wo.risk !== "normal" ? <Chip text={`risk ${wo.risk}`} cls="warn" /> : null}
        {heldByKill ? <Chip text={`Held by ${typeof heldByKill === "string" ? heldByKill : wo.stop?.scope ?? ""} kill`} cls="chip-block" /> : null}
      </div>
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
      {wo.wipWait && wo.state === "waiting" && !wo.bay ? (
        <div className="callout callout-warn" id="dz-wip-wait" role="note">
          <Icon name="st-wait" />
          <div><b>{wipWaitText(cat, wo)}</b>{` ${stName(cat, cat.stations[wo.station]?.id)} is done; it goes in when a place frees, highest priority first, then the one that has waited longest.`}</div>
        </div>
      ) : null}
      {wo.blockReason && !wo.wipWait ? <div className="callout callout-block"><Icon name="st-block" /><div><b>Blocked</b>{` ${wo.blockReason}`}</div></div> : null}
      {wo.failReason ? <div className="callout callout-fail"><Icon name="st-fail" /><div><b>Failed</b>{` ${wo.failReason}`}</div></div> : null}
      {wo.state === "parked" || wo.bay ? (
        <div className="callout callout-warn" id="dz-parked">
          <Icon name="st-park" />
          <div><b>{`Parked in ${bayLabel(cat, wo.bay) || "a bay"}`}</b>{` ${wo.bayReason || "No reason recorded."}`}</div>
        </div>
      ) : null}
      {bar.notes}
    </div>
  );
}
