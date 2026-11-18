/** Station and gate detail drawers of the floor (legacy floor.js openStation / openGate). They always show the live floor. */
import { useState, type ReactNode } from "react";
import { COMBINED_GATES, approvalText, fmt, gateDef, gateKind, gateKindText, gateLock, type Gate } from "@gantry/domain";
import { useAgents, useMcpServers, useSkills, useWorkOrder } from "../../api/queries";
import { ops } from "../../api/ops";
import type { WorkOrder } from "../../api/types";
import { Btn, Chip, Empty, StateChip, Who, type Decision } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { hashFor, navigate } from "../../lib/router";
import { canSeeRoute } from "../../lib/routes";
import { useMe } from "../../api/queries";
import { FloorCtx, WoToken, gateOfStation, isLive, mcpFor, stationIdx, useFloorCtx, useFloorValue } from "./kit";

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
const WoRow = ({ w, project, extra }: { w: WorkOrder; project: string; extra?: ReactNode }) => (
  <li data-wo={w.id}>
    <a className="pri mono" href={hashFor("record", w.id, project)}>{w.id}</a>
    <span className="grow trunc">{w.title}</span>
    {extra ?? <StateChip state={w.state} />}
  </li>
);

/** Work orders, filtered. The Work orders screen reads the filter from the URL query; the route itself always opens. */
function WorkOrdersLink({ label, params, project, close }: { label: string; params: Record<string, string>; project: string; close: () => void }) {
  const q = new URLSearchParams(params).toString();
  return (
    <a
      className="btn"
      id="floor-drawer-wos"
      href={hashFor("work-orders", null, project)}
      onClick={(e) => {
        e.preventDefault();
        close();
        navigate("work-orders", null, project);
        try {
          window.history.replaceState(window.history.state, "", `${window.location.pathname}?${q}${window.location.hash}`);
        } catch {
          /* no history access */
        }
      }}
    >
      {label}
    </a>
  );
}

function ApproverSummary({ gid }: { gid: string }) {
  const ctx = useFloorCtx();
  const actor = useActors();
  const g = gateDef(ctx.cat, gid) as Gate;
  const rule = ctx.project.approvers[gid];
  const kind = gateKind(ctx.cat, ctx.project, gid);
  const roleName = (r: string): string => ctx.cat.roles.find((x) => x.id === r)?.name ?? r;
  const perClass = rule?.classRequired ? Object.entries(rule.classRequired).map(([c, n]) => `${ctx.project.flow.classes.find((x) => x.id === c)?.name ?? c} needs ${n}`).join("; ") : "";
  const line = <><p className="small"><strong>{approvalText(g, kind, rule, roleName, (id) => actor(id).name)}</strong></p>{perClass && kind !== "auto" && gid !== "G0G1" ? <p className="small muted">{`By class: ${perClass}.`}</p> : null}</>;
  if (kind === "auto") return <>{line}<p className="small">{`Passes when its checks pass: ${g.checks.join(", ")}.`}</p></>;
  if (gid === "G0G1") return <>{line}<p className="small">The submitter confirms the brief. Line Leads and Project Admins may confirm any brief.</p></>;
  if (!rule) return <p className="small muted">No approver rule set. Factory Admins can approve (break-glass).</p>;
  const names = [...rule.roles.map((r) => ctx.cat.roles.find((x) => x.id === r)?.name ?? r), ...rule.people.map((p) => actor(p).name)];
  return (
    <div className="fl-rule">
      <p className="small">
        <strong>{`${rule.required} approval${rule.required > 1 ? "s" : ""} from: `}</strong>
        {names.join(", ") || "nobody listed"}
      </p>
      {kind === "mixed" ? <p className="small">{`Automatic checks first: ${g.checks.join(", ")}.`}</p> : null}
      {rule.sod ? <p className="small">Separation of duties: the author cannot approve.</p> : null}
      {rule.conditions.length ? (
        <ul className="plain-list small">
          {rule.conditions.map((c) => (
            <li key={c.id}>
              <Icon name="tag" /> {c.text}
            </li>
          ))}
        </ul>
      ) : null}
      {rule.escalateH ? <p className="small muted">{`Escalates after ${rule.escalateH}h${rule.fallback ? ` to ${actor(rule.fallback).name}` : " to the Project Admins"}.`}</p> : null}
    </div>
  );
}

type Traveler = WorkOrder & { allowed?: { approve: (Decision & { gate: string; instance: string }) | null } };

/** Approve and reject for one waiting work order. The decision comes from the server for this person (separation of duties and approver rules included). */
function GateRowActions({ w, gid }: { w: WorkOrder; gid: string }) {
  const ui = useUI();
  const ctx = useFloorCtx();
  const t = useWorkOrder(w.id).data as Traveler | undefined;
  const lock: Decision | null = ctx.replay ? { allowed: false, reason: "Replay is showing the past. Go back to live to act.", needs: "" } : null;
  const dec: Decision | null = lock ?? (!t ? { allowed: false, reason: "Checking what you may decide here.", needs: "" } : t.allowed?.approve && t.allowed.approve.gate === gid ? { allowed: t.allowed.approve.allowed, reason: t.allowed.approve.reason, needs: t.allowed.approve.needs } : null);
  const g = gateDef(ctx.cat, gid) as Gate;
  const brief = gid === "G0G1";
  const done = (r: { ok: boolean; msg: string }) => ui.toast(r.msg, r.ok ? "ok" : "error");
  return (
    <span className="fl-gate-acts">
      <Btn label={brief ? "Confirm brief" : gid === "G6" ? "Confirm release" : "Approve"} small kind="primary" icon="check" id={`floor-gapp-${w.id}`} guard={dec} onClick={async () => done(await ops.approveGate(w.id, gid, t?.allowed?.approve?.instance))} />
      <Btn
        label={brief ? "Decline" : "Reject"}
        small
        icon="x"
        id={`floor-grej-${w.id}`}
        guard={dec}
        onClick={() =>
          ui.reasonDialog({
            title: brief ? `Decline ${w.id}` : `Reject ${g.label} on ${w.id}`,
            kicker: "Gate decision",
            ok: brief ? "Decline" : "Reject",
            kind: "danger",
            min: 5,
            placeholder: brief ? "Why will the factory not do this?" : "What must change before this passes?",
            sub: brief ? "The work order moves to Declined." : "The station's agent reworks the step with your reason.",
            onOk: async (v) => {
              const r = await ops.rejectGate(w.id, gid, t?.allowed?.approve?.instance, v);
              if (r.ok) ui.toast(r.msg, "ok");
              return r;
            },
          })
        }
      />
    </span>
  );
}

function TrustLink({ id }: { id: string }) {
  const me = useMe();
  const ui = useUI();
  const blocked = me && !canSeeRoute("trust", me, {});
  return <Btn label="Open the trust ladder" small icon="trust" id={id} disabledReason={blocked ? "Your role cannot open the trust ladder." : null} onClick={() => { ui.drawer.close(); navigate("trust"); }} />;
}

export function GateDrawer({ gid, close, onStation }: { gid: string; close: () => void; onStation: (sid: string) => void }) {
  const ctx = useFloorCtx();
  const ui = useUI();
  const g = gateDef(ctx.cat, gid);
  if (!g) return null;
  const p = ctx.project;
  const after = ctx.cat.stations.find((s) => s.id === g.after);
  const atIdx = stationIdx(ctx.cat, g.after);
  const here = ctx.wos.filter((w) => isLive(w) && w.gates?.[gid] && w.station === atIdx);
  const waiting = here.filter((w) => w.gates[gid]?.status === "waiting" && !w.bay);
  const failing = here.filter((w) => w.gates[gid]?.status === "failed");
  const kind = gateKind(ctx.cat, p, gid);
  const recent: Array<{ w: WorkOrder; at: number; by?: string | undefined; text: string; via?: string | undefined; mode: string }> = [];
  for (const w of ctx.wos) {
    const gs = w.gates?.[gid];
    if (!gs) continue;
    for (const a of gs.approvals) recent.push({ w, at: a.at, by: a.by, text: "approved", via: a.via, mode: "human" });
    for (const a of gs.rejections) recent.push({ w, at: a.at, by: a.by, text: `rejected: ${a.reason}`, mode: "human" });
    if (gs.decision?.mode === "trust") recent.push({ w, at: gs.decision.at, text: gs.decision.reason || `passed under trust at L${gs.decision.trust}`, mode: "trust" });
  }
  recent.sort((a, b) => b.at - a.at);
  const checks = g.checks?.length ? g.checks.join(", ") : "Person decides";
  return (
    <Frame kicker={`${g.label} · GATE`} title={g.name} sub={g.purpose} close={close} label="Close gate details">
      <div className="fl-drawer-body">
        <dl className="kv" id="floor-gate-kv">
          <dt>Kind</dt>
          <dd><Chip text={gateKindText(kind)} cls={kind === "auto" ? "info" : "warn"} /></dd>
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
                {kind === "auto" ? <span className="small muted">Checks running</span> : <GateRowActions w={w} gid={gid} />}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="Gate is open" text="No work orders are waiting here." />
        )}
        {COMBINED_GATES[gid] ? <p className="small muted">{`${g.label}: ${COMBINED_GATES[gid]}`}</p> : null}
        {gateLock(g, p).locked ? <p className="small muted"><Icon name="lock" />{` Always on. ${gateLock(g, p).reason}`}</p> : null}
        <h3 className="sub-h">Approvals needed</h3>
        <ApproverSummary gid={gid} />
        {kind !== "auto" && gid !== "G0G1" ? (
          <div className="fl-trust">
            <h3 className="sub-h">{`Trust in force at ${g.name}`}</h3>
            <p className="small muted">Trust levels per work class decide whether a person approves here or the gate passes on its checks. They are set on the Trust ladder.</p>
            <TrustLink id="floor-gate-trust-link" />
          </div>
        ) : null}
        {failing.length ? <h3 className="sub-h">{`Failing (${failing.length})`}</h3> : null}
        {failing.length ? (
          <ul className="fl-gate-list">
            {failing.map((w) => (
              <li key={w.id}>
                <WoToken w={w} compact idPrefix="floor-gftok-" />
                <div className="small">{w.failReason || w.bayReason || "Check failed"}</div>
                {w.state === "failed" ? (
                  <Btn
                    label={`Retry ${ctx.cat.stations[w.station]?.name ?? ""}`}
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
              </li>
            ))}
          </ul>
        ) : null}
        <h3 className="sub-h">Recent decisions</h3>
        {recent.length ? (
          <ol className="history">
            {recent.slice(0, 8).map((x, i) => (
              <li key={`${x.w.id}-${x.at}-${i}`} className={x.mode === "trust" ? "fl-dec-trust" : undefined}>
                <span className="mono muted">{fmt.iso(x.at)}</span>
                {x.by ? (
                  <Who id={x.by} />
                ) : (
                  <span className="fl-trust-tag">
                    <Icon name="trust" />
                    trust
                  </span>
                )}
                <span className="mono">{x.w.id}</span>
                <span>{x.text + (x.via && x.via !== "web" ? ` via ${x.via}` : "")}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted small">No decisions recorded yet.</p>
        )}
        <p className="footnote">
          <button type="button" className="linkish" onClick={() => onStation(g.after)}>
            {`Open ${after?.name ?? g.after}`}
          </button>
        </p>
      </div>
    </Frame>
  );
}

export function StationDrawer({ sid, close, onGate }: { sid: string; close: () => void; onGate: (gid: string) => void }) {
  const ctx = useFloorCtx();
  const agents = useAgents().data;
  const skills = useSkills().data;
  const servers = useMcpServers().data;
  const st = ctx.cat.stations.find((s) => s.id === sid);
  if (!st) return null;
  const p = ctx.project;
  const i = stationIdx(ctx.cat, sid);
  const ag = agents?.find((a) => a.id === st.agent);
  const here = ctx.wos.filter((w) => w.station === i && isLive(w) && !w.bay);
  const g = gateOfStation(ctx.cat, p, sid);
  const sk = (ag?.skills ?? []).map((id) => {
    const x = skills?.find((s) => s.id === id);
    return x ? `${x.name} ${x.version}` : id;
  });
  const model = p.regulated && sid !== "intake" ? "bedrock-claude-sonnet-5-5" : (ag?.overrides?.[p.id]?.model ?? ag?.model ?? "none");
  const mcps = mcpFor(p, sid, servers);
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
        <div className="fl-trust">
          <h3 className="sub-h">{`Trust for ${ag?.name ?? "the agent"} in this project`}</h3>
          <p className="small muted">{g && gateKind(ctx.cat, p, g.id) !== "auto" && g.id !== "G0G1" ? `Applies at ${g.label}, the gate that judges this station's work.` : "No human gate judges this station's work, so trust does not change who approves here."}</p>
          <TrustLink id="floor-st-trust-link" />
        </div>
        <h3 className="sub-h">Skills</h3>
        {sk.length ? (
          <ul className="plain-list mono small">
            {sk.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No skills attached.</p>
        )}
        <h3 className="sub-h">Instructions</h3>
        <p className="small">{ag?.instructions ?? ""}</p>
        {p.overlay ? <p className="small muted">{`Project overlay: ${p.overlay}`}</p> : null}
        {mcps.length ? <p className="small">{`Tools: ${mcps.map((m) => m.name).join(", ")}.`}</p> : null}
        {g ? <h3 className="sub-h">{`Gate after: ${g.label} ${g.name}`}</h3> : null}
        {g ? <ApproverSummary gid={g.id} /> : null}
        {g ? <Btn label={`Open ${g.label} details`} small icon="diamond" id={`floor-st-gate-${g.id}`} onClick={() => onGate(g.id)} /> : null}
        <p className="footnote">Change agents, skills and instructions on the Agents screen; WIP limits and gates in Project config.</p>
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
          <StationDrawer sid={sid} close={close} onGate={api.gate} />
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
    gate: (gid: string): void => {
      if (!projectId) return;
      ui.drawer.open(`gate:${gid}`, (close) => (
        <DrawerRoot projectId={projectId}>
          <GateDrawer gid={gid} close={close} onStation={api.station} />
        </DrawerRoot>
      ));
    },
  };
  return api;
}

