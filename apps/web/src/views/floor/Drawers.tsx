/** Station and gate detail drawers of the floor (legacy floor.js openStation / openGate). They always show the live floor. */
import { useState, type ReactNode } from "react";
import { gateDef, gateKind } from "@gantry/domain";
import { useAgents, useWorkOrder } from "../../api/queries";
import { ops } from "../../api/ops";
import type { WorkOrder } from "../../api/types";
import { Btn, Chip, Empty, type Decision } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { hashFor } from "../../lib/router";
import { classOf } from "../projects/kit";
import { FloorCtx, WoChip, isLive, stationIdx, useFloorCtx, useFloorValue, waitingGateId, type FWo } from "./kit";

/** Provides the live floor to a drawer, which renders outside the floor view. */
export function DrawerRoot({ projectId, children }: { projectId: string; children: ReactNode }) {
  const value = useFloorValue(projectId, null);
  if (!value) return <div className="drawer-inner"><p className="muted small">Loading…</p></div>;
  return <FloorCtx.Provider value={value}>{children}</FloorCtx.Provider>;
}

/** Prototype drawer frame: eyebrow, title, sub-line, close; the body scrolls; an optional footer of links. */
const Frame = ({ kicker, title, sub, close, label, children, footer }: { kicker: string; title: string; sub?: ReactNode; close: () => void; label: string; children: ReactNode; footer?: ReactNode }) => (
  <div className="drawer-inner fl-drawer">
    <div className="drawer-head">
      <div>
        <div className="kicker">{kicker}</div>
        <h2 className="drawer-title">{title}</h2>
        {sub ? <p className="drawer-desc">{sub}</p> : null}
      </div>
      <button type="button" className="icon-btn drawer-close" aria-label={label} onClick={close}>
        <Icon name="x" />
      </button>
    </div>
    <div className="drawer-scroll">{children}</div>
    {footer ? <div className="drawer-foot fl-drawer-foot">{footer}</div> : null}
  </div>
);

/** A work order as a row of the prototype list: record link, title, state chip. */
const WoRow = ({ w, project, extra }: { w: FWo; project: string; extra?: ReactNode }) => (
  <li data-wo={w.id}>
    <a className="pri mono" href={hashFor("record", w.id, project)}>{w.id}</a>
    <span className="grow trunc">{w.title}</span>
    {extra ?? <WoChip w={w} />}
  </li>
);

/** Work orders, filtered: the filter rides in the hash query (`#/p/payments/work-orders?station=build`), as the prototype's links do. */
function WorkOrdersLink({ label, params, project, close }: { label: string; params: Record<string, string>; project: string; close: () => void }) {
  const q = new URLSearchParams(params).toString();
  return (
    <a className="btn" id="floor-drawer-wos" href={`${hashFor("work-orders", null, project)}?${q}`} onClick={close}>
      {label}
    </a>
  );
}

/** The prototype's fmtDate: day, month, hour and minute in UTC ("13 Nov 10:13"). */
const createdText = (t: number): string => (t ? new Date(t).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).replace(",", "") : "—");

type Traveler = WorkOrder & { allowed?: { approve: (Decision & { gate: string; instance: string }) | null } };

/** Approve one waiting work order at a gate. The decision comes from the server for this person (separation of duties and approver rules included). */
function ApproveBtn({ w, gid, label, primary, id, after }: { w: WorkOrder; gid: string; label: string; primary?: boolean; id: string; after?: () => void }) {
  const ui = useUI();
  const ctx = useFloorCtx();
  const t = useWorkOrder(w.id).data as Traveler | undefined;
  const lock: Decision | null = ctx.replay ? { allowed: false, reason: "Replay is showing the past. Go back to live to act.", needs: "" } : null;
  const dec: Decision | null = lock ?? (!t ? { allowed: false, reason: "Checking what you may decide here.", needs: "" } : t.allowed?.approve && t.allowed.approve.gate === gid ? { allowed: t.allowed.approve.allowed, reason: t.allowed.approve.reason, needs: t.allowed.approve.needs } : null);
  return (
    <Btn
      label={label}
      small={!primary}
      kind="primary"
      id={id}
      guard={dec}
      onClick={async () => {
        const r = await ops.approveGate(w.id, gid, t?.allowed?.approve?.instance);
        ui.toast(r.ok ? `${w.id} approved` : r.msg, r.ok ? "ok" : "error");
        if (r.ok) after?.();
      }}
    />
  );
}

export function GateDrawer({ gid, close }: { gid: string; close: () => void }) {
  const ctx = useFloorCtx();
  const g = gateDef(ctx.cat, gid);
  if (!g) return null;
  const p = ctx.project;
  const after = ctx.cat.stations.find((s) => s.id === g.after);
  const waiting = ctx.wos.filter((w) => isLive(w) && !w.bay && w.state === "waiting" && waitingGateId(ctx, w) === gid);
  const kind = gateKind(ctx.cat, p, gid);
  const checks = g.checks?.length ? g.checks.join(", ") : "Person decides";
  return (
    <Frame kicker={`${g.label} · GATE`} title={g.name} sub={g.purpose} close={close} label="Close gate details">
      <div className="fl-drawer-body">
        <dl className="kv" id="floor-gate-kv">
          <dt>Kind</dt>
          <dd><Chip text={kind === "auto" ? "auto" : kind === "mixed" ? "mixed" : "human"} cls={kind === "auto" ? "info" : "warn"} /></dd>
          <dt>After station</dt>
          <dd>{after?.name ?? g.after}</dd>
          <dt>Checks</dt>
          <dd>{checks}</dd>
        </dl>
        <h3 className="sub-h">Waiting now</h3>
        {waiting.length ? (
          <ul className="list fl-bordered" id="floor-gate-waiting">
            {waiting.map((w) => (
              <li key={w.id} data-wo={w.id}>
                <a className="pri mono" href={hashFor("record", w.id, p.id)}>{w.id}</a>
                <span className="grow trunc">{w.title}</span>
                <ApproveBtn w={w} gid={gid} label="Approve" id={`floor-gapp-${w.id}`} after={close} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="Gate is open" text="No work orders are waiting here." />
        )}
      </div>
    </Frame>
  );
}

export function StationDrawer({ sid, close }: { sid: string; close: () => void }) {
  const ctx = useFloorCtx();
  const agents = useAgents().data;
  const st = ctx.cat.stations.find((s) => s.id === sid);
  if (!st) return null;
  const p = ctx.project;
  const i = stationIdx(ctx.cat, sid);
  const ag = agents?.find((a) => a.id === st.agent);
  const here = ctx.wos.filter((w) => w.station === i && isLive(w) && !w.bay);
  const model = p.regulated && sid !== "intake" ? "bedrock-claude-sonnet-5-5" : (ag?.overrides?.[p.id]?.model ?? ag?.model ?? "none");
  return (
    <Frame
      kicker={`${st.no} · STATION`}
      title={st.name}
      sub={st.purpose}
      close={close}
      label="Close station details"
      footer={<WorkOrdersLink label="Work orders here" params={{ station: sid }} project={p.id} close={close} />}
    >
      <div className="fl-drawer-body">
        {ctx.replay ? (
          <div className="callout callout-warn">
            <Icon name="replay" />
            <span>Replay is on. This drawer shows the station as it is now.</span>
          </div>
        ) : null}
        <dl className="kv" id="floor-station-kv">
          <dt>Agent</dt>
          <dd>{ag ? <a href={hashFor("agents", ag.id, p.id)}>{ag.name}</a> : st.agent}</dd>
          <dt>Model</dt>
          <dd>{model}</dd>
          <dt>Autonomy</dt>
          <dd>{ag?.autonomy ?? "gate"}</dd>
          <dt>In station</dt>
          <dd>{`${here.length} work order${here.length === 1 ? "" : "s"}`}</dd>
        </dl>
        {here.length ? (
          <ul className="list fl-bordered" id="floor-station-wos">
            {here.map((w) => <WoRow key={w.id} w={w} project={p.id} />)}
          </ul>
        ) : (
          <Empty title="Nothing in this station" text="Work orders appear here as they arrive." />
        )}
      </div>
    </Frame>
  );
}

/** A work order tag opened from the line: the prototype's compact drawer (chips, facts, progress, diff, PR) with Approve, Open record and Traveler. */
export function WoDrawer({ woId, close }: { woId: string; close: () => void }) {
  const ctx = useFloorCtx();
  const actor = useActors();
  const w: FWo | undefined = ctx.wos.find((x) => x.id === woId);
  if (!w) return null;
  const p = ctx.project;
  const gid = isLive(w) && !w.bay && w.state === "waiting" ? waitingGateId(ctx, w) : null;
  const repoName = ctx.repos.find((r) => r.id === w.repo)?.name ?? "";
  return (
    <Frame kicker={w.id} title={w.title} sub={`${p.name} · ${repoName}`} close={close} label="Close work order details"
      footer={
        <>
          {gid ? <ApproveBtn w={w} gid={gid} label={`Approve ${gid}`} primary id="floor-wo-approve" after={close} /> : null}
          <a className="btn" id="floor-wo-record" href={hashFor("record", w.id, p.id)} onClick={close}>Open record</a>
          <a className="btn" id="floor-wo-traveler" href={hashFor("traveler", w.id, p.id)} onClick={close}>Traveler</a>
        </>
      }
    >
      <div className="fl-drawer-body">
        <div className="row">
          <WoChip w={w} />
          <Chip text={classOf(ctx.cat, p, w.cls).name} cls="ghost" />
          <Chip text={w.priority} cls="plain" />
        </div>
        <dl className="kv" id="floor-wo-kv">
          <dt>Station</dt>
          <dd>{w.bay ? ctx.cat.bays.find((b) => b.id === w.bay)?.name ?? w.bay : ctx.cat.stations[w.station]?.name ?? ""}</dd>
          <dt>Requested by</dt>
          <dd>{actor(w.requestedBy).name}</dd>
          <dt>Created</dt>
          <dd>{createdText(w.createdAt)}</dd>
          <dt>Progress</dt>
          <dd><div style={{ width: 160 }}><div className="meter" role="meter" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w.progress)}><i style={{ width: `${Math.max(0, Math.min(1, w.progress / 100)) * 100}%` }} /></div></div></dd>
          <dt>Diff</dt>
          <dd>{w.diff ? `+${w.diff.plus} −${w.diff.minus} in ${w.diff.files} file${w.diff.files === 1 ? "" : "s"}` : "—"}</dd>
          <dt>PR</dt>
          <dd>{w.pr ? `#${w.pr.number} ${w.pr.state}` : "—"}</dd>
        </dl>
        {w.blockReason ? <div className="callout bad"><b>Blocked</b>{w.blockReason}</div> : null}
        {w.failReason ? <div className="callout bad"><b>Failed</b>{w.failReason}</div> : null}
      </div>
    </Frame>
  );
}

/** OUT: the work orders that cleared the last gate (prototype "Released" drawer). */
export function ReleasedDrawer({ close }: { close: () => void }) {
  const ctx = useFloorCtx();
  const done = ctx.wos.filter((w) => w.state === "done" && !w.split).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  return (
    <Frame
      kicker="OUT · TERMINUS"
      title="Released"
      sub="Work orders that cleared the last gate."
      close={close}
      label="Close released work orders"
      footer={<WorkOrdersLink label="Work orders" params={{ state: "done" }} project={ctx.project.id} close={close} />}
    >
      {done.length ? (
        <ul className="list fl-bordered" id="floor-released">
          {done.slice(0, 12).map((w) => <WoRow key={w.id} w={w} project={ctx.project.id} extra={<span className="chip ok">done</span>} />)}
        </ul>
      ) : (
        <Empty title="Nothing released yet" text="Released work orders collect here." />
      )}
    </Frame>
  );
}

/** Keeps the two drawers hopping between each other without a stale closure. */
export function useDrawers(projectId: string | null) {
  const ui = useUI();
  const [, force] = useState(0);
  void force;
  const api = {
    station: (sid: string): void => {
      if (!projectId) return;
      ui.drawer.open(`station:${sid}`, (close) => (
        <DrawerRoot projectId={projectId}>
          <StationDrawer sid={sid} close={close} />
        </DrawerRoot>
      ));
    },
    out: (): void => {
      if (!projectId) return;
      ui.drawer.open("out", (close) => (
        <DrawerRoot projectId={projectId}>
          <ReleasedDrawer close={close} />
        </DrawerRoot>
      ));
    },
    wo: (woId: string): void => {
      if (!projectId) return;
      ui.drawer.open(`floorwo:${woId}`, (close) => (
        <DrawerRoot projectId={projectId}>
          <WoDrawer woId={woId} close={close} />
        </DrawerRoot>
      ));
    },
    gate: (gid: string): void => {
      if (!projectId) return;
      ui.drawer.open(`gate:${gid}`, (close) => (
        <DrawerRoot projectId={projectId}>
          <GateDrawer gid={gid} close={close} />
        </DrawerRoot>
      ));
    },
  };
  return api;
}

