/**
 * System health (Govern). What is running, whether backups and the restore drill are current, deliveries that gave up (dead letters, with a retry),
 * and jobs that look stuck. Read from GET /api/v1/system/health; the one command is requeueing a dead delivery (audited on the server).
 */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import { Btn, Empty, Panel, Stat, StatRow, Status, Table, Tabs, ViewHead, type Tone } from "../../ui/primitives";
import { Async, qState, useCommand } from "../../ui/async";
import { dec } from "../mcp/kit";
import { retryDeadLetter, useSystemHealth, type BackupStatus, type DeadLetter, type DrillStatus, type ServiceHealth, type StuckJob, type SystemHealth } from "./data";

/** A backup older than this is stale; the server decides, this only labels the number. */
const STALE_HOURS = 26;

const SERVICE_TONE: Record<ServiceHealth["status"], { tone: Tone; label: string }> = {
  ok: { tone: "done", label: "Up" },
  degraded: { tone: "wait", label: "Degraded" },
  down: { tone: "fail", label: "Down" },
  unknown: { tone: "neutral", label: "Unknown" },
};
const BACKUP_TONE: Record<BackupStatus["status"], { tone: Tone; label: string }> = {
  ok: { tone: "done", label: "Current" },
  stale: { tone: "wait", label: "Stale" },
  failed: { tone: "fail", label: "Failed" },
  unknown: { tone: "neutral", label: "Unknown" },
};
const DRILL_TONE: Record<DrillStatus["status"], { tone: Tone; label: string }> = {
  ok: { tone: "done", label: "Passed" },
  failed: { tone: "fail", label: "Failed" },
  unknown: { tone: "neutral", label: "Not run yet" },
};

const when = (iso: string | null): string => (iso && Number.isFinite(Date.parse(iso)) ? fmt.iso(Date.parse(iso)) : "–");
const ageText = (h: number | null): string => (h === null ? "–" : h < 1 ? "<1h ago" : h < 48 ? `${Math.round(h)}h ago` : `${Math.floor(h / 24)}d ago`);

const ageShort = (sec: number): string => (sec < 120 ? `${sec} s` : sec < 7200 ? `${Math.round(sec / 60)} min` : `${Math.round(sec / 3600)} h`);

function BackupPanel({ b, d }: { b: BackupStatus; d: DrillStatus }) {
  const bt = BACKUP_TONE[b.status];
  const dt = DRILL_TONE[d.status];
  return (
    <Panel title="Backups and restore drill" cls="sys-backups">
      {b.status === "stale" ? (
        <p className="sys-warn" id="sys-stale" role="alert">The newest backup is over {STALE_HOURS} hours old. Check the backup service before you rely on it.</p>
      ) : null}
      <dl className="sys-facts">
        <div className="sys-fact" id="sys-backup">
          <dt>Last backup</dt>
          <dd><Status tone={bt.tone}>{bt.label}</Status></dd>
          <dd className="muted small">{b.at ? `${when(b.at)} (${ageText(b.ageHours)})` : b.detail}</dd>
          {b.at && b.status !== "ok" ? <dd className="muted small">{b.detail}</dd> : null}
        </div>
        <div className="sys-fact" id="sys-drill">
          <dt>Last restore drill</dt>
          <dd><Status tone={dt.tone}>{dt.label}</Status></dd>
          <dd className="muted small">{d.at ? `${when(d.at)} (${ageText(d.ageHours)})${d.seconds !== null ? `, ${d.seconds}s` : ""}` : d.detail}</dd>
          {d.status === "failed" ? <dd className="muted small">{d.failedChecks} check{d.failedChecks === 1 ? "" : "s"} failed. {d.detail}</dd> : null}
        </div>
      </dl>
    </Panel>
  );
}

function DeadRow({ r, canRetry }: { r: DeadLetter; canRetry: ReturnType<typeof dec> }) {
  const retry = useCommand(() => retryDeadLetter(r.id), { ok: `Requeued the delivery to ${r.destination}.` });
  return (
    <tr data-key={r.id}>
      <td className="sys-dest c-dest" title={r.scope === "project" ? "Belongs to a project's notifications" : undefined}>{r.destination}</td>
      <td className="mono small nowrap c-tries">{r.attempts}/{r.maxAttempts}</td>
      <td className="mono small nowrap c-when">{when(r.failedAt)}</td>
      <td className="sys-err small c-err" title={r.lastError ?? undefined}>{r.lastError ?? "No error recorded."}</td>
      <td className="sys-act c-act"><Btn small label="Retry" id={`sys-retry-${r.id}`} guard={canRetry.allowed ? null : canRetry} disabledReason={retry.wait("Retrying…")} onClick={() => void retry.run()} /></td>
    </tr>
  );
}

function OutboxPanel({ h }: { h: SystemHealth }) {
  const canRetry = dec(useCan("integration.edit"));
  const c = h.outbox.counts;
  const oldest = h.outbox.oldestPendingSeconds;
  return (
    <Panel title="Outbox and dead letters" cls="sys-outbox">
      <ul className="sys-counts" aria-label="Outbox counts">
        {([["Pending", c.pending, false], ["Sending", c.sending, false], ["Delivered", c.delivered, false], ["Dead", c.dead, c.dead > 0]] as const).map(([k, n, bad]) => (
          <li key={k} className={bad ? "is-bad" : ""}><span className="sys-count-k">{k}</span><span className="sys-count-v mono">{fmt.num(n)}</span></li>
        ))}
        <li><span className="sys-count-k">Oldest pending</span><span className="sys-count-v mono">{oldest === null ? "–" : fmt.dur(oldest * 1000)}</span></li>
      </ul>
      {h.outbox.dead.length === 0 ? (
        <Empty id="sys-dead-empty" title="No dead letters" text="Every delivery has either gone out or is still being retried." />
      ) : (
        <>
          <p className="muted small sys-note">The {h.outbox.dead.length} newest of {fmt.num(c.dead)} that gave up. Retry sends the original message again; it is recorded in the audit log.</p>
          <Table compact className="sys-table sys-dead">
            <thead><tr><th>Destination</th><th>Tries</th><th>Gave up</th><th>Last error</th><th><span className="sr-only">Action</span></th></tr></thead>
            <tbody>{h.outbox.dead.map((r) => <DeadRow key={r.id} r={r} canRetry={canRetry} />)}</tbody>
          </Table>
        </>
      )}
    </Panel>
  );
}

function JobsPanel({ h }: { h: SystemHealth }) {
  const c = h.jobs.counts;
  return (
    <Panel title="Stuck jobs" cls="sys-jobs">
      <ul className="sys-counts" aria-label="Job counts">
        {([["Queued", c.queued, false], ["Running", c.running, false], ["Done", c.done, false], ["Dead", c.dead, c.dead > 0]] as const).map(([k, n, bad]) => (
          <li key={k} className={bad ? "is-bad" : ""}><span className="sys-count-k">{k}</span><span className="sys-count-v mono">{fmt.num(n)}</span></li>
        ))}
      </ul>
      {h.jobs.stuck.length === 0 ? (
        <Empty id="sys-stuck-empty" title="Nothing looks stuck" text={`No running job has lost its lease or run longer than ${h.jobs.runningLongMinutes / 60} hours.`} />
      ) : (
        <Table compact className="sys-table sys-stuck">
          <thead><tr><th>Job</th><th>Queue</th><th>Why flagged</th><th>Started</th><th>Tries</th></tr></thead>
          <tbody>
            {h.jobs.stuck.map((j: StuckJob) => (
              <tr key={j.id} data-key={j.id}>
                <td className="mono small nowrap c-job">{j.kind}</td>
                <td className="nowrap c-queue">{j.queue}</td>
                <td className="c-why"><Status tone={j.reason === "lease_expired" ? "fail" : "wait"}>{j.reason === "lease_expired" ? "Lease expired" : `Over ${h.jobs.runningLongMinutes / 60}h`}</Status></td>
                <td className="mono small nowrap c-when">{when(j.startedAt)}</td>
                <td className="mono small nowrap c-tries">{j.attempts}/{j.maxAttempts}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function ServiceCard({ s }: { s: ServiceHealth }) {
  const t = SERVICE_TONE[s.status];
  return (
    <section className="card" data-service={s.id}>
      <div className="card-b stack" style={{ gap: 10 }}>
        <div className="row spread">
          <h3 className="ell">{s.name}</h3>
          <Status tone={t.tone}>{t.label}</Status>
        </div>
        <div className="uptime" aria-hidden="true">
          <svg viewBox="0 0 200 16" width="100%" height="16" preserveAspectRatio="none">
            {Array.from({ length: 40 }, (_, i) => <rect key={i} x={i * 5} y={0} width={3.5} height={16} rx={1} fill={`var(--${s.status === "ok" ? "ok" : s.status === "degraded" ? "warn" : s.status === "down" ? "bad" : "idle"})`} opacity={0.85} />)}
          </svg>
        </div>
        <div className="row spread small">
          <span className="dim ell">{s.detail}</span>
          <span className="mono dim" title={s.heartbeatAgeSeconds != null ? "Time since the last heartbeat" : undefined}>{s.heartbeatAgeSeconds != null ? ageShort(s.heartbeatAgeSeconds) : s.latencyMs === null ? "" : `${s.latencyMs} ms`}</span>
        </div>
      </div>
    </section>
  );
}

export default function SystemView() {
  const q = useSystemHealth();
  const h = q.data;
  const [tab, setTab] = useState("services");
  const up = h ? h.services.filter((s) => s.status === "ok").length : 0;
  const worker = h?.services.find((s) => s.id === "worker");
  return (
    <div className="view view-system">
      <ViewHead
        kicker="Govern"
        title="System health"
        sub="Services, worker heartbeat, backups, outbox and stuck work."
        actions={<Btn small icon="refresh" label="Refresh" id="sys-refresh" onClick={() => void q.refetch()} />}
      />
      <StatRow id="sys-stats">
        <Stat label="Worker heartbeat" value={qState(q, () => (worker?.heartbeatAgeSeconds != null ? ageShort(worker.heartbeatAgeSeconds) : "–"))} sub="last tick" />
        <Stat label="Services up" value={qState(q, (d) => `${up} of ${d.services.length}`)} sub={h ? `backup ${ageText(h.backup.ageHours)}` : undefined} tone={h && up < h.services.length ? "wait" : "done"} />
        <Stat label="Dead letters" value={qState(q, (d) => fmt.num(d.outbox.counts.dead))} tone={h && h.outbox.counts.dead ? "wait" : undefined} />
        <Stat label="Stuck jobs" value={qState(q, (d) => fmt.num(d.jobs.stuck.length))} tone={h && h.jobs.stuck.length ? "wait" : undefined} />
      </StatRow>
      <Tabs idPrefix="sys-tab" active={tab} onChange={setTab} items={[{ id: "services", label: "Services" }, { id: "backups", label: "Backups and drill" }, { id: "outbox", label: "Outbox", count: h?.outbox.counts.dead ?? 0 }, { id: "jobs", label: "Stuck jobs", count: h?.jobs.stuck.length ?? 0 }]} />
      <Async query={q} what="system health" id="sys">
        {(d) => (tab === "backups" ? <BackupPanel b={d.backup} d={d.drill} /> : tab === "outbox" ? <OutboxPanel h={d} /> : tab === "jobs" ? <JobsPanel h={d} /> : (
          <div className="grid g4 rows" aria-label="Services">{d.services.map((s) => <ServiceCard key={s.id} s={s} />)}</div>
        ))}
      </Async>
    </div>
  );
}
