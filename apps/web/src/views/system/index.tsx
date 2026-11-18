/**
 * System health (Govern), laid out as the Blueprint draws it: four tiles, then Services (1) beside Worker heartbeat (2) and Backups (3),
 * Outbox dead letters (4) and Stuck jobs (5). Read from GET /api/v1/system/health; the one write the server has is requeueing a dead delivery
 * (audited). What the server cannot supply is shown as such: heartbeat history, backup size, discarding a dead letter, requeueing a stuck job.
 */
import { fmt } from "@gantry/domain";
import { hashFor } from "../../lib/router";
import { useCan } from "../../api/can";
import { Btn, Chip, Empty, Panel, Stat, StatRow, ViewHead } from "../../ui/primitives";
import { Async, qState, useCommand } from "../../ui/async";
import { useUI } from "../../ui/overlay-context";
import { dec } from "../mcp/kit";
import { retryDeadLetter, useSystemHealth, type BackupStatus, type DeadLetter, type DrillStatus, type ServiceHealth, type StuckJob, type SystemHealth } from "./data";

/** The server's words, in the prototype's: healthy, degraded, offline. */
const SERVICE: Record<ServiceHealth["status"], { label: string; tone: string }> = {
  ok: { label: "healthy", tone: "ok" },
  degraded: { label: "degraded", tone: "warn" },
  down: { label: "offline", tone: "bad" },
  unknown: { label: "unknown", tone: "plain" },
};
const BACKUP: Record<BackupStatus["status"], { label: string; tone: string }> = {
  ok: { label: "verified", tone: "ok" },
  stale: { label: "stale", tone: "warn" },
  failed: { label: "failed", tone: "bad" },
  unknown: { label: "unknown", tone: "plain" },
};
const NA = "not available";

const ageText = (h: number | null): string => (h === null ? "–" : h < 1 ? "<1h ago" : h < 48 ? `${Math.round(h)}h ago` : `${Math.floor(h / 24)}d ago`);
const ageShort = (sec: number): string => (sec < 45 ? "just now" : `${fmt.dur(sec * 1000)} ago`);
const STALE_HOURS = 26;
/** "14 min", the prototype's recovery time; seconds only when under a minute. */
const recovery = (sec: number): string => (sec < 60 ? `${sec} s` : `${Math.round(sec / 60)} min`);

function ServiceRow({ s }: { s: ServiceHealth }) {
  const t = SERVICE[s.status];
  const detail = [s.detail, s.heartbeatAgeSeconds != null ? `heartbeat ${ageShort(s.heartbeatAgeSeconds)}` : s.latencyMs !== null ? `${s.latencyMs} ms` : ""].filter(Boolean).join(" · ");
  return (
    <li data-service={s.id}>
      <div className="grow"><b>{s.name}</b><div className="small muted">{detail}</div></div>
      <Chip text={t.label} cls={t.tone} />
    </li>
  );
}

/** The newest beat is all the server reports: only that bar is drawn as a beat (green when fresh, red when late), the other nineteen stay empty and the caption says so. */
function HeartbeatPanel({ h }: { h: SystemHealth }) {
  const beat = h.services.find((s) => s.heartbeatAgeSeconds != null);
  const age = beat?.heartbeatAgeSeconds ?? null;
  const fresh = age !== null && age <= 60;
  return (
    <Panel title="Worker heartbeat, last 20 minutes" id="sys-heartbeat">
      <svg className="chart" viewBox="0 0 400 50" width="100%" role="img" aria-label={age === null ? "Heartbeat history is not available" : `Heartbeat: the latest beat was ${ageShort(age)}`}>
        {Array.from({ length: 20 }, (_, i) => {
          const latest = i === 19 && age !== null;
          return <rect key={i} x={i * 20 + 2} y={latest && !fresh ? 30 : 10} width={15} height={latest && !fresh ? 10 : 30} fill={latest ? (fresh ? "var(--ok)" : "var(--bad)") : "var(--line)"} />;
        })}
      </svg>
      <div className="small muted" id="sys-heartbeat-note">{age !== null ? `Beat history ${NA}: the server reports only the latest beat, ${ageShort(age)}.` : `Beat history ${NA}: no worker has reported a heartbeat.`}</div>
    </Panel>
  );
}

function BackupPanel({ b, d }: { b: BackupStatus; d: DrillStatus }) {
  const bt = BACKUP[b.status];
  return (
    <Panel title="Backups" flush id="sys-backups">
      {b.status === "stale" ? <p className="small" id="sys-stale" role="alert" style={{ padding: "12px 14px 0" }}>The newest backup is over {STALE_HOURS} hours old. Check the backup service before you rely on it.</p> : null}
      <ul className="list" id="sys-backup">
        <li>
          <span className="mono">{b.set ?? "latest"}</span>
          <span className="grow">{b.at ? `nightly · size ${NA}` : b.detail}</span>
          <Chip text={bt.label} cls={bt.tone} />
          <span className="small muted">{b.at ? ageText(b.ageHours) : ""}</span>
        </li>
      </ul>
      <div id="sys-drill" className={`callout ${d.status === "ok" ? "ok" : d.status === "failed" ? "bad" : ""}`} style={{ margin: 12 }}>
        <b>{d.status === "ok" ? "Restore drill passed" : d.status === "failed" ? "Restore drill failed" : "No restore drill yet"}</b>
        {d.at ? `Last drill ${ageText(d.ageHours)}${d.seconds !== null ? `, recovery time ${recovery(d.seconds)}` : ""}.${d.status === "failed" ? ` ${d.failedChecks} check${d.failedChecks === 1 ? "" : "s"} failed. ${d.detail}` : ""}` : d.detail}
      </div>
    </Panel>
  );
}

function DeadRow({ r, canRetry }: { r: DeadLetter; canRetry: ReturnType<typeof dec> }) {
  const retry = useCommand(() => retryDeadLetter(r.id), { ok: `${r.id} re-queued` });
  const discard = { allowed: false, reason: "The server has no way to discard a dead letter yet.", needs: "" };
  return (
    <li data-key={r.id}>
      <span className="mono">{r.id}</span>
      <div className="grow">
        <b title={r.scope === "project" ? "Belongs to a project's notifications" : undefined}>{r.destination}</b>
        <div className="small muted" title={r.lastError ?? undefined}>{[r.workOrder, r.lastError ?? "No error recorded.", `${r.attempts} attempts`].filter(Boolean).join(" · ")}</div>
      </div>
      <Btn small label="Retry" id={`sys-retry-${r.id}`} guard={canRetry.allowed ? null : canRetry} disabledReason={retry.wait("Retrying…")} onClick={() => void retry.run()} />
      <Btn small kind="danger" label="Discard" id={`sys-discard-${r.id}`} guard={canRetry.allowed ? discard : canRetry} />
    </li>
  );
}

function OutboxPanel({ h }: { h: SystemHealth }) {
  const canRetry = dec(useCan("integration.edit"));
  return (
    <Panel title="Outbox dead letters" flush id="sys-outbox">
      {h.outbox.dead.length === 0 ? (
        <Empty id="sys-dead-empty" title="Outbox is clear" text="Nothing failed to deliver." />
      ) : (
        <ul className="list" aria-label="Dead letters">{h.outbox.dead.map((r) => <DeadRow key={r.id} r={r} canRetry={canRetry} />)}</ul>
      )}
    </Panel>
  );
}

function JobsPanel({ h }: { h: SystemHealth }) {
  const canEdit = dec(useCan("integration.edit"));
  const requeue = { allowed: false, reason: "The server has no way to requeue a stuck job yet.", needs: "" };
  return (
    <Panel title="Stuck jobs" flush id="sys-jobs">
      {h.jobs.stuck.length === 0 ? (
        <Empty id="sys-stuck-empty" title="No stuck jobs" text="Every running job is making progress." />
      ) : (
        <ul className="list" aria-label="Stuck jobs">
          {h.jobs.stuck.map((j: StuckJob) => (
            <li key={j.id} data-key={j.id}>
              {j.workOrder ? <a className="pri mono" href={hashFor("record", j.workOrder.id, j.workOrder.project)} id={`sys-wo-${j.workOrder.id}`}>{j.workOrder.id}</a> : <span className="mono">{j.id}</span>}
              <div className="grow">
                <div className="trunc">{j.workOrder?.title ?? `${j.kind} on ${j.queue}`}</div>
                <div className="small muted">{j.workOrder?.reason ?? (j.reason === "lease_expired" ? "Lease expired" : `Running over ${h.jobs.runningLongMinutes / 60} hours with little progress`)}</div>
              </div>
              <Btn small label="Requeue" id={`sys-requeue-${j.id}`} guard={canEdit.allowed ? requeue : canEdit} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function SystemView() {
  const q = useSystemHealth();
  const ui = useUI();
  const h = q.data;
  const up = h ? h.services.filter((s) => s.status === "ok").length : 0;
  return (
    <div className="view view-system">
      <ViewHead
        title="System health"
        kicker="All lines"
        sub="Is the factory itself running well? Services, workers, backups and stuck work."
        actions={<Btn icon="refresh" label="Refresh" id="sys-refresh" onClick={() => void q.refetch().then((r) => { if (!r.isError) ui.toast("Checked all services", "ok"); })} />}
      />
      <StatRow id="sys-stats">
        <Stat label="Services" value={qState(q, (d) => `${up}/${d.services.length}`)} sub="healthy" tone={h && up < h.services.length ? "wait" : "done"} />
        <Stat label="Dead letters" value={qState(q, (d) => fmt.num(d.outbox.counts.dead))} sub="outbox" tone={h && h.outbox.counts.dead ? "block" : "done"} />
        <Stat label="Stuck jobs" value={qState(q, (d) => fmt.num(d.jobs.stuck.length))} tone={h && h.jobs.stuck.length ? "wait" : "done"} />
        <Stat label="Last backup" value={qState(q, (d) => ageText(d.backup.ageHours))} sub={h ? `size ${NA}` : undefined} tone={h && h.backup.status !== "ok" ? "wait" : "done"} />
      </StatRow>
      <Async query={q} what="system health" id="sys">
        {(d) => (
          <>
            <div className="cols">
              <Panel title="Services" flush id="sys-services">
                <ul className="list" aria-label="Services">{d.services.map((s) => <ServiceRow key={s.id} s={s} />)}</ul>
              </Panel>
              <div className="stack">
                <HeartbeatPanel h={d} />
                <BackupPanel b={d.backup} d={d.drill} />
              </div>
            </div>
            <div style={{ height: 16 }} />
            <OutboxPanel h={d} />
            <JobsPanel h={d} />
          </>
        )}
      </Async>
    </div>
  );
}
