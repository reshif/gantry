/** Station and gate detail drawers of the floor (legacy floor.js openStation / openGate). They always show the live floor. */
import { useState, type ReactNode } from "react";
import { fmt, gateDef, gateKind, gateOffNote } from "@gantry/domain";
import { useAgents } from "../../api/queries";
import { ops } from "../../api/ops";
import { Btn } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { hashFor, navigate } from "../../lib/router";
import { openApproval } from "./Approval";
import { Dr, TokenDrawer } from "./TokenDrawer";
import { setProject } from "../../lib/prefs";
import { beltGateLabels, tokenState } from "./conveyor";
import { FloorCtx, isLive, since, stationIdx, useFloorCtx, useFloorValue } from "./kit";

/** Provides the live floor to a drawer, which renders outside the floor view. */
export function DrawerRoot({ projectId, children }: { projectId: string; children: ReactNode }) {
  const value = useFloorValue(projectId, null);
  if (!value) return <div className="drawer-inner"><p className="muted small">Loading…</p></div>;
  return <FloorCtx.Provider value={value}>{children}</FloorCtx.Provider>;
}

export function GateDrawer({ gid, close }: { gid: string; close: () => void }) {
  const ctx = useFloorCtx();
  const ui = useUI();
  const g = gateDef(ctx.cat, gid);
  if (!g) return null;
  const p = ctx.project;
  const label = beltGateLabels(ctx).get(gid) ?? g.label;
  const after = ctx.cat.stations.find((s) => s.id === g.after);
  const atIdx = stationIdx(ctx.cat, g.after);
  const here = ctx.wos.filter((w) => isLive(w) && w.gates?.[gid] && w.station === atIdx);
  const waiting = here.filter((w) => w.gates[gid]?.status === "waiting" && !w.bay);
  const failing = here.filter((w) => w.gates[gid]?.status === "failed");
  const off = !p.flow.gates[gid]?.enabled && gid !== "G0G1";
  const kind = gateKind(ctx.cat, p, gid);
  const mode = kind === "human" ? "Human" : kind === "auto" ? "Automatic" : "Mixed";
  return (
    <Dr
      eyebrow={`Gate ${label}`}
      title={g.name}
      close={close}
      label="Close gate details"
      foot={<Btn label="Configure gates" id="floor-gate-config" onClick={() => { close(); navigate("project-config", null, p.id); }} />}
    >
      {off ? (
        <div className="callout">
          <Icon name="alert" />
          <span>{`${g.name} is off in ${p.name}. ${gateOffNote}`}</span>
        </div>
      ) : null}
      <dl className="kv" style={{ margin: 0 }}>
        <dt>Mode</dt><dd>{mode}</dd>
        <dt>After station</dt><dd>{after?.name ?? g.after}</dd>
        <dt>Waiting</dt><dd>{waiting.length}</dd>
      </dl>
      <div className="card">
        <div className="card-b flush">
          {waiting.length ? (
            waiting.map((w) => {
              const open = ctx.floor.gates.some((x) => x.wo === w.id && x.gate === gid);
              return (
                <div key={w.id} className="li">
                  <div className="main1">
                    <span className="t1">{w.title}</span>
                    <span className="t2 mono">{`${w.id} · waiting ${fmt.dur(Math.max(0, ctx.now - since(w)))}`}</span>
                  </div>
                  {open && kind !== "auto" ? <Btn label="Review" small kind="primary" id={`floor-greview-${w.id}`} onClick={() => openApproval(ui, p.id, w.id, gid, label, g.name)} /> : null}
                </div>
              );
            })
          ) : (
            <div className="empty"><b>Gate is clear</b><span>Nothing is waiting here.</span></div>
          )}
        </div>
      </div>
      {failing.length ? (
        <div className="card">
          <div className="card-h"><h3>{`Failing its checks (${failing.length})`}</h3></div>
          <div className="card-b flush">
            {failing.map((w) => (
              <div key={w.id} className="li">
                <div className="main1">
                  <span className="t1">{w.title}</span>
                  <span className="t2 mono">{`${w.id} · ${w.failReason || w.bayReason || "Check failed"}`}</span>
                </div>
                {w.state === "failed" ? (
                  <Btn
                    label="Retry"
                    small
                    icon="refresh"
                    id={`floor-gretry-${w.id}`}
                    disabledReason={ctx.replay ? "Replay is showing the past. Go back to live to act." : null}
                    onClick={async () => {
                      const r = await ops.retry(w.id);
                      ui.toast(r.msg, r.ok ? "ok" : "error");
                    }}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Dr>
  );
}

export function StationDrawer({ sid, close }: { sid: string; close: () => void }) {
  const ctx = useFloorCtx();
  const agents = useAgents().data;
  const st = ctx.cat.stations.find((s) => s.id === sid);
  if (!st) return null;
  const p = ctx.project;
  const conf = p.flow.stations[sid];
  const i = stationIdx(ctx.cat, sid);
  const ag = agents?.find((a) => a.id === st.agent);
  const here = ctx.wos.filter((w) => w.station === i && isLive(w) && !w.bay);
  const model = p.regulated && sid !== "intake" ? "bedrock-claude-sonnet-5-5" : (ag?.overrides?.[p.id]?.model ?? ag?.model ?? "none");
  const slotsN = sid === "build" ? Math.max(1, p.flow.slots) : Math.max(1, conf?.wip ?? 1);
  const act = here.filter((w) => tokenState(ctx, w) !== "queued").length;
  return (
    <Dr eyebrow="Station" title={st.name} close={close} label="Close station details">
      {ctx.replay ? (
        <div className="callout callout-warn">
          <Icon name="replay" />
          <span>Replay is on. This drawer shows the station as it is now.</span>
        </div>
      ) : null}
      <dl className="kv" style={{ margin: 0 }}>
        <dt>Agent</dt><dd>{ag ? <a href={hashFor("agents", ag.id)} onClick={() => close()}>{ag.name}</a> : st.agent}</dd>
        <dt>Model</dt><dd><span className="m">{model}</span></dd>
        <dt>Capacity</dt><dd>{`${Math.min(act, slotsN)} of ${slotsN} slots in use${act > slotsN ? `, ${act - slotsN} over` : ""}`}</dd>
        <dt>Autonomy</dt><dd>{ag ? ({ suggest: "L1", gate: "L2", auto: "L3" } as Record<string, string>)[ag.autonomy] ?? ag.autonomy : "not available"}</dd>
        <dt>Eval score</dt><dd>{ag ? ag.evalScore.toFixed(2) : "not available"}</dd>
      </dl>
      <div className="card">
        <div className="card-h"><h3>Work here</h3></div>
        <div className="card-b flush">
          {here.length ? (
            here.map((w) => (
              <div key={w.id} className="li click" role="link" tabIndex={0} id={`floor-stok-${w.id}`} onClick={() => { close(); setProject(w.project); navigate("record", w.id); }} onKeyDown={(e) => { if (e.key === "Enter") { close(); setProject(w.project); navigate("record", w.id); } }}>
                <div className="main1">
                  <span className="t1">{w.title}</span>
                  <span className="t2 mono">{w.id}</span>
                </div>
                <span className={`chip ${{ running: "info", queued: "idle", gate: "warn", blocked: "bad" }[tokenState(ctx, w)]}`}>{{ running: "Running", queued: "Queued", gate: "At a gate", blocked: "Blocked" }[tokenState(ctx, w)]}</span>
              </div>
            ))
          ) : (
            <div className="empty"><b>Nothing here</b><span>This station is idle.</span></div>
          )}
        </div>
      </div>
    </Dr>
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
    token: (woId: string): void => {
      if (!projectId) return;
      ui.drawer.open(`token:${woId}`, (close) => <TokenDrawer projectId={projectId} woId={woId} close={close} />);
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

