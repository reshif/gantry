/**
 * The top of a work order page, as the prototype draws it: eyebrow, title and sub-line; Traveler, Dossier and Changes as pages, a green
 * "Review G5" when a gate waits on the viewer, and one Actions menu. Below, a card with the state chip, priority, class, where the work
 * is and who has it, and the route as a numbered strip. Banners for anything that stops the work. Locked actions say why.
 */
import { WO_STATES, fmt, type Catalog, type Project } from "@gantry/domain";
import { Btn, Who, reasonText, useCopy } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { navigate, hashFor } from "../../lib/router";
import { classOf } from "../projects/kit";
import { useActionSpecs, type ActionSpec } from "../traveler/Actions";
import { bayLabel, no, stName, stNo, type TWo } from "../traveler/model";
import type { WoSession } from "../conversations/session-api";
import { useCopyMarkdown, useExportRecord } from "../record/Lifecycle";
import type { RecordData } from "../record/data";
import { ReviewDialog } from "./ReviewDialog";
import { ProtoPipe } from "./kit";

const unique = <T,>(xs: T[]): T[] => [...new Set(xs)];
const NO_EDIT = no("The server cannot change a work order's title, priority or owner yet.");

/** One line on what the work order is doing right now, from the work order read and, when there is one, its conversation. */
export function statusLine(wo: TWo, cat: Catalog, s: WoSession | undefined): string {
  if (wo.killed) return `Held in place by a ${wo.killed.scope} kill, ${fmt.stamp(wo.killed.at)}`;
  if (wo.state === "done") return wo.split ? "Split into child work orders" : `Shipped ${fmt.stamp(wo.doneAt ?? 0)}`;
  if (wo.bay) return `Off the belt in ${bayLabel(cat, wo.bay)}${wo.bayReason ? `: ${wo.bayReason}` : ""}`;
  if (s?.next.text) return s.next.text;
  const st = cat.stations[wo.station];
  return `At ${stNo(cat, st?.id)} ${stName(cat, st?.id)}`.trim();
}

/** The gate this work order waits at for the viewer, if any (the Review button and the dialog use it). */
export function reviewGate(wo: TWo, cat: Catalog) {
  const ap = wo.allowed.approve;
  const g = ap ? cat.gates.find((x) => x.id === ap.gate) : undefined;
  return !wo.bay && wo.state === "waiting" && ap && g ? { ap, g } : null;
}

export function DossierHead({ wo, cat, project, session, rec }: { wo: TWo; cat: Catalog; project: Project; session: WoSession | undefined; rec: RecordData | undefined }) {
  const ui = useUI();
  const copy = useCopy();
  const copyMd = useCopyMarkdown();
  const exportRec = useExportRecord();
  const actor = useActors();
  const specs = useActionSpecs(wo);
  const heldByKill = (wo as { heldByKill?: boolean | string }).heldByKill;
  const stateLabel = (WO_STATES as Record<string, { label: string }>)[wo.state]?.label ?? wo.state;
  const sla = wo.slaDue ? (wo.slaDue > Date.now() ? `SLA in ${fmt.dur(wo.slaDue - Date.now())}` : `SLA missed by ${fmt.dur(Date.now() - wo.slaDue)}`) : "";
  const tone = ({ running: "info", waiting: "warn", blocked: "bad", failed: "bad", done: "ok", killed: "bad" } as Record<string, string>)[wo.state] ?? "idle";
  const rg = reviewGate(wo, cat);
  const chipText = wo.state === "waiting" && rg ? `At gate ${rg.g.label}` : stateLabel;
  const st = cat.stations[wo.state === "done" ? cat.stations.length - 1 : wo.station];
  const agent = wo.history[wo.history.length - 1]?.agent ?? st?.agent;
  const special = !!(wo.killed || wo.bay || wo.state === "done");

  const of = (g: ActionSpec["group"]) => (specs ?? []).filter((s) => s.group === g);
  const item = (a: ActionSpec) => ({ label: a.menuLabel ?? a.label, icon: a.icon, ...(a.kind ? { kind: a.kind } : {}), guard: a.guard, onClick: a.onClick });
  const by = (k: string) => (specs ?? []).find((s) => s.key === k);
  const menu = (anchor: HTMLElement) => {
    const first = [
      { label: "Edit title and priority", icon: "tag", guard: NO_EDIT, onClick: () => undefined },
      { label: "Reassign", icon: "people", guard: NO_EDIT, onClick: () => undefined },
      ...[by("park"), by("sendback")].filter((a): a is ActionSpec => !!a).map(item),
    ];
    const stop = by("kill");
    const rest = [...of("main").filter((a) => a.key !== "park"), ...of("inline"), ...of("more").filter((a) => a.key !== "kill")].map(item);
    ui.menu(anchor, "Actions", [
      ...first,
      ...(stop ? [{ sep: true }, item(stop)] : []),
      { sep: true },
      ...rest,
      { label: "Copy link", icon: "copy", onClick: () => copy(`${window.location.origin}${window.location.pathname}${hashFor("record", wo.id, wo.project)}`) },
      { label: "Copy as Markdown", icon: "copy", onClick: () => void copyMd(wo.id) },
      { label: "Export record", icon: "page", onClick: () => void exportRec(wo.id) },
    ]);
  };
  const approve = by("approve");
  const retry = of("main").filter((a) => a.key === "retry" || a.key === "unpark");
  const locked = (specs ?? []).filter((s) => s.guard && !s.guard.allowed && s.group !== "decide");
  const reasons = unique(locked.map((s) => reasonText(s.guard!))).filter(Boolean);
  const lines = reasons.map((r) => ({ r, items: locked.filter((s) => reasonText(s.guard!) === r).map((s) => s.label) }));
  const why = specs?.find((s) => s.why);

  return (
    <div id="dz-head" className="dz-top">
      <header className="ph dz-ph">
        <div>
          <div className="eyebrow">{`Work order · ${wo.id}`}</div>
          <h1>{wo.title}</h1>
          <p className="sub">{`${project.name} · ${wo.repo} · requested by ${actor(wo.requestedBy).name}`}</p>
        </div>
        <div className="acts dz-actions" role="toolbar" aria-label="Work order actions">
          <Btn label="Traveler" id="rec-traveler" onClick={() => navigate("traveler", wo.id, wo.project)} />
          <Btn label="Dossier" id="rec-dossier" onClick={() => navigate("dossier", wo.id, wo.project)} />
          <Btn label="Changes" id="rec-changes" onClick={() => navigate("changes", wo.id, wo.project)} />
          {retry.map((a) => <Btn key={a.key} label={a.label} kind="primary" icon={a.icon} id={a.id} guard={a.guard} onClick={a.onClick} />)}
          {rg && approve ? <Btn label={rg.g.id === "G0G1" ? "Confirm brief" : `Review ${rg.g.label}`} kind="ok" id="trv-approve" guard={approve.guard} onClick={() => void ui.open((close) => <ReviewDialog wo={wo} gate={rg.g} rec={rec} onClose={close} />)} /> : null}
          {specs ? <Btn label="Actions" id="dz-more" aria="Move, reassign, line control and other actions" onClick={(e) => menu(e.currentTarget)}><Icon name="down" /></Btn> : null}
        </div>
      </header>
      {why?.why ? <p className="small muted trv-why" id="trv-approve-why" role="note">{why.why}</p> : null}
      {lines.map((l) => (
        <div key={l.r} className="dz-lockline">
          <Icon name="lock" />
          <span><b>{`${l.items.join(", ")} locked.`}</b>{` ${l.r}`}</span>
        </div>
      ))}
      <section className="card wo-strip" style={{ marginBottom: 4 }}>
        <div className="card-b row spread">
          <div className="row dz-chips">
            <span className={`chip ${tone}`} role="status">{chipText}</span>
            <span className={`tag pri ${wo.priority.toLowerCase()}`} title={`Priority ${wo.priority}`}>{wo.priority}</span>
            <span className="tag">{classOf(cat, project, wo.cls).name.toLowerCase()}</span>
            {heldByKill ? <span className="chip bad">{`Held by ${typeof heldByKill === "string" ? heldByKill : wo.stop?.scope ?? ""} kill`}</span> : null}
            {special ? <span className="dz-stline dim">{statusLine(wo, cat, session)}</span> : (
              <>
                <span className="dim">at</span><b>{st?.name ?? ""}</b>
                {agent ? <><span className="dim">with</span><Who id={agent} /></> : null}
              </>
            )}
          </div>
          <div className="mono dim dz-age">{`opened ${fmt.dur(Date.now() - wo.createdAt)} ago${sla ? ` · ${sla}` : ""}`}</div>
        </div>
        <div className="card-b" style={{ paddingTop: 0 }}>
          <ProtoPipe wo={wo} cat={cat} project={project} />
        </div>
      </section>
      {wo.killed ? (
        <div className="banner bad" role="alert">
          <Icon name="kill" />
          <div className="grow"><b>Killed</b>{` ${wo.killed.scope} kill by ${actor(wo.killed.by).name}, ${fmt.stamp(wo.killed.at)}: ${wo.killed.reason}${wo.pr ? `. PR #${wo.pr.number} left as ${wo.pr.state}.` : "."}`}</div>
        </div>
      ) : null}
      {!wo.killed && wo.stop ? (
        <div className="banner warn" role="alert">
          <Icon name="halt" />
          <div className="grow"><b>Stopped</b>{` ${wo.stop.reason}${heldByKill ? " It is held in place and resumes on restore." : ""}`}</div>
        </div>
      ) : null}
      {wo.blockReason ? <div className="banner bad"><Icon name="alert" /><div className="grow"><b>Blocked</b>{` ${wo.blockReason}`}</div></div> : null}
      {wo.failReason ? <div className="banner bad"><Icon name="alert" /><div className="grow"><b>Failed</b>{` ${wo.failReason}`}</div></div> : null}
    </div>
  );
}
