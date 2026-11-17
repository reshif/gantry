/**
 * Traveler: the routing sheet that rides with every work order (right-hand drawer), ported from legacy/js/views/traveler.js.
 * Open it with useOpenTraveler(). Position, gates with progress, approve and reject, moves, send back, park, reassign, retry, history.
 */
import { Fragment, useEffect } from "react";
import { fmt } from "@gantry/domain";
import { Btn, Empty, StateChip, Tabs } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useProject } from "../../api/queries";
import { ClassChip, classOf, useCatalog } from "../projects/kit";
import { Lifecycle } from "../record/Lifecycle";
import { useOpenRecordRoute } from "../record/nav";
import { Actions } from "./Actions";
import { Journey } from "./Journey";
import { ArtefactsTab, BriefTab, HistoryTab } from "./Tabs";
import { bayLabel, stName, stNo, useTravelerWo } from "./model";
import { setTravelerTab, useTravelerTab } from "./state";
import { DocViewer } from "../documents/DocViewer";
import { RunTimelineView } from "../documents/Timeline";
import { useRepoName } from "./repo";
import { ApproversPanel } from "./Approvers";
import { navigate } from "../../lib/router";
import { clearTravelerUrl, writeTravelerUrl } from "../../shell/travelerUrl";
import { setProject } from "../../lib/prefs";
import { useWoSessions } from "../conversations/session-api";
import { useWoDialogue } from "../documents/api";
import { GateNotes } from "../documents/Swarm";

/** What is still open before this gate is decided; the links open the work-order conversation, where the items live. Quiet when nothing is open or the read fails. */
function TravelerGateNotes({ woId, project, onNavigate }: { woId: string; project: string; onNavigate: () => void }) {
  const q = useWoDialogue(woId);
  if (!q.data) return null;
  return <GateNotes assumptions={q.data.assumptions ?? []} objections={q.data.objections ?? []} jump={() => { onNavigate(); setProject(project); navigate("conversations", woId, project); }} />;
}

const tb = (k: string, v: string) => (
  <Fragment key={k}>
    <dt>{k}</dt>
    <dd>{v}</dd>
  </Fragment>
);

export default function TravelerDrawer({ woId, onClose }: { woId: string; onClose?: () => void }) {
  const q = useTravelerWo(woId);
  const wo = q.data;
  const project = useProject(wo?.project).data ?? null;
  const cat = useCatalog();
  const tab = useTravelerTab();
  const actor = useActors();
  const openRecord = useOpenRecordRoute();
  const repoName = useRepoName(wo?.project, wo?.repo);
  const close = () => onClose?.();
  const sessions = useWoSessions(wo?.project);
  const row = sessions.data?.items.find((x) => x.id === woId);
  // The open traveler (and its tab) is in the URL; closing it, by any route, takes it out again.
  useEffect(() => {
    writeTravelerUrl(woId, tab);
    return () => clearTravelerUrl(woId);
  }, [woId, tab]);
  if (!wo || !project || !cat) {
    return (
      <div className="drawer-inner trv-drawer">
        <div className="drawer-head">
          <div className="trv-headmain">
            <div className="kicker">Traveler · routing sheet</div>
            <div className="drawer-id"><span className="mono big-id">{woId}</span></div>
          </div>
          <div className="trv-headtools">
            <button type="button" className="icon-btn drawer-close" id="trv-close" aria-label="Close traveler" onClick={close}><Icon name="x" /></button>
          </div>
        </div>
        <div className="drawer-scroll">
          {!(q.isError && (q.error as { status?: number } | null)?.status === 404) && (q.isError || q.isPending) ? <Async query={q} what={`work order ${woId}`} id="trv">{() => null}</Async> : <Empty title={`No work order ${woId}`} text="It may have been removed, or it belongs to a project you cannot see." />}
        </div>
      </div>
    );
  }
  const st = cat.stations[wo.state === "done" ? cat.stations.length - 1 : wo.station];
  const stop = wo.stop;
  const halt = stop?.mode === "halt" ? stop : null;
  const tot = wo.history.reduce((t, e) => ({ tokens: t.tokens + e.tokens, cost: t.cost + e.cost }), { tokens: 0, cost: 0 });
  const where = wo.state === "done" ? (wo.split ? "Split into children" : `Shipped ${fmt.stamp(wo.doneAt ?? 0)}`) : wo.bay ? bayLabel(cat, wo.bay) : `${stNo(cat, st?.id)} ${stName(cat, st?.id)}`;
  const tabs = [
    { id: "journey", label: "Journey" },
    { id: "lifecycle", label: "Lifecycle" },
    { id: "brief", label: "Brief" },
    { id: "documents", label: "Documents" },
    { id: "run", label: "Run" },
    { id: "artefacts", label: "Artefacts" },
    { id: "history", label: "History" },
  ];
  const body =
    tab === "lifecycle" ? <Lifecycle woId={wo.id} compact /> : tab === "brief" ? <BriefTab wo={wo} cat={cat} /> : tab === "documents" ? <DocViewer woId={wo.id} project={wo.project} /> : tab === "run" ? <RunTimelineView woId={wo.id} /> : tab === "artefacts" ? <ArtefactsTab wo={wo} project={project} /> : tab === "history" ? <HistoryTab wo={wo} /> : <Journey wo={wo} project={project} cat={cat} />;
  /** The gate the viewer may approve right now (not the intake gate); the approvers panel and the open-items card share it. */
  const gateG = wo.allowed.approve && !wo.bay && wo.state === "waiting" && wo.allowed.approve.gate !== "G0G1" ? wo.allowed.approve.gate : null;
  const heldByKill = (wo as { heldByKill?: boolean | string }).heldByKill;
  return (
    <div className={`drawer-inner trv-drawer${wo.state === "killed" ? " is-killed" : ""}`}>
      <div className="drawer-head">
        <div className="trv-headmain">
          <div className="kicker">{`Traveler · routing sheet · ${project.name}`}</div>
          <div className="drawer-id">
            <span className="mono big-id">{wo.id}</span>
            <StateChip state={wo.state} />
            <ClassChip cls={classOf(cat, project, wo.cls)} />
            <span className={`chip prio-${wo.priority}`}>{wo.priority}</span>
            {heldByKill ? <span className="chip chip-block">{`held by ${typeof heldByKill === "string" ? heldByKill : wo.stop?.scope ?? ""} kill`}</span> : null}
          </div>
          <h2 className="drawer-title">{wo.title}</h2>
        </div>
        <div className="trv-headtools">
          <Btn label="Open full record" small icon="record" id="trv-open-record" onClick={() => { close(); openRecord(wo.id, wo.project); }} />
          <button type="button" className="icon-btn drawer-close" id="trv-close" aria-label="Close traveler" onClick={close}>
            <Icon name="x" />
          </button>
        </div>
      </div>
      <div className="drawer-scroll">
        {wo.killed ? (
          <div className="trv-killed" role="alert">
            <Icon name="st-kill" />
            <div>
              <strong>KILLED</strong>
              <span>{` · ${wo.killed.scope} kill by ${actor(wo.killed.by).name}, ${fmt.stamp(wo.killed.at)}: ${wo.killed.reason}${wo.pr ? `. PR #${wo.pr.number} left as ${wo.pr.state}.` : "."}`}</span>
            </div>
          </div>
        ) : null}
        {!wo.killed && stop ? (
          <div className="trv-killed" role="alert">
            <Icon name="st-kill" />
            <div>
              <strong>STOPPED</strong>
              <span>{` · ${stop.reason}${heldByKill ? " This work order is held in place and resumes on restore." : ""}`}</span>
            </div>
          </div>
        ) : null}
        {halt ? (
          <div className="halt-banner">
            <Icon name="halt" />
            <span>{halt.reason}</span>
          </div>
        ) : null}
        {wo.blockReason ? <div className="callout callout-block"><Icon name="st-block" /><span>{wo.blockReason}</span></div> : null}
        {wo.failReason ? <div className="callout callout-fail"><Icon name="st-fail" /><span>{wo.failReason}</span></div> : null}
        <dl className="kv tb-drawer">
          {tb("Repo", repoName)}
          {tb("Where", where)}
          {tb("Class", `${cat.classes.find((c) => c.id === wo.cls)?.name ?? wo.cls} · ${Math.round(wo.clsConfidence * 100)}%${wo.clsOverridden ? " (overridden)" : ""}`)}
          {tb("Source", wo.source)}
          {tb("Requested by", actor(wo.requestedBy).name)}
          {tb("Created", fmt.stamp(wo.createdAt))}
          {tb("SLA due", wo.slaDue ? fmt.stamp(wo.slaDue) : "none")}
          {tb("PR", wo.pr ? `#${wo.pr.number} ${wo.pr.state}` : "not yet")}
          {tb("Coding slot", wo.slot ? `${wo.slot} of ${project.flow.slots}` : "none")}
          {tb("Tokens", fmt.k(tot.tokens))}
          {tb("Spend", fmt.money(tot.cost))}
          {tb("Risk", wo.risk || "normal")}
        </dl>
        {wo.description ? <p className="drawer-desc">{wo.description}</p> : null}
        <div className={`wos-open-conv${row?.waitingOn === "you" ? " is-you" : ""}`} id="trv-conversation">
          <Btn label="Open conversation" kind="primary" icon="chat" id="trv-open-conversation" onClick={() => { close(); setProject(wo.project); navigate("conversations", wo.id, wo.project); }} />
          <span className="small" role="status">
            {!row ? "Talk to the agent at this station about this work order."
              : row.closed ? "Closed."
              : wo.state === "failed" || wo.state === "blocked" ? <strong>{`${wo.state === "blocked" ? "Blocked" : "Stopped"}: a person has to retry it or assign another agent`}</strong>
              : row.waitingOn === "you" ? <strong>{`${row.agentName ?? "The agent"} is waiting for you`}</strong>
              : row.waitingOn === "approver" ? "Waiting for an approver"
              : row.waitingOn === "person" ? "Waiting for someone else's answer"
              : `${row.agentName ?? "The agent"} is working`}
            {row?.unread ? <span className="wos-unread" role="img" aria-label="Unread messages" /> : null}
          </span>
        </div>
        {gateG ? <ApproversPanel woId={wo.id} gate={gateG} project={wo.project} onNavigate={close} /> : null}
        {gateG ? <TravelerGateNotes woId={wo.id} project={wo.project} onNavigate={close} /> : null}
        <Actions wo={wo} />
        <Tabs idPrefix="trv-tab" items={tabs} active={tab} onChange={(t) => { setTravelerTab(t as typeof tab); setTimeout(() => document.getElementById(`trv-tab-${t}`)?.focus(), 0); }} />
        <div className="drawer-tabbody" id="trv-tab-panel" role="tabpanel" aria-labelledby={`trv-tab-${tab}`}>
          {body}
        </div>
      </div>
    </div>
  );
}

