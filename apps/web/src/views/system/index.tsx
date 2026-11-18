/**
 * System health (Govern), in the Control Room prototype's layout: stat tiles, then Services, Backups and drill, Outbox (dead letters) and Stuck jobs.
 * Read from GET /api/v1/system/health; the one command is requeueing a dead delivery (audited on the server). What the server has no
 * endpoint for (a backup on demand, a drill, discarding a dead letter, nudging a stuck job) is shown disabled with the reason, never faked.
 */
import { fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import { useQueryState } from "../../lib/queryState";
import { Btn, Tabs } from "../../ui/primitives";
import { Card, CrEmpty, Lamp, Page, Stats } from "../../ui/cr";
import { DataTable } from "../../ui/DataTable";
import { Async, useCommand } from "../../ui/async";
import { dec } from "../mcp/kit";
import { retryDeadLetter, useSystemHealth, type BackupStatus, type DeadLetter, type DrillStatus, type ServiceHealth, type StuckJob, type SystemHealth } from "./data";

/** A backup older than this is stale; the server decides, this only labels the number. */
const STALE_HOURS = 26;
export const SYS_TABS = ["overview", "backups", "outbox", "stuck"] as const;
const QS = ["tab"] as const;
const NOT_AVAILABLE = "Not available yet: the server has no endpoint for this.";

const SERVICE_CHIP: Record<ServiceHealth["status"], { cls: string; label: string }> = {
  ok: { cls: "ok", label: "Healthy" },
  degraded: { cls: "warn", label: "Degraded" },
  down: { cls: "bad", label: "Down" },
  unknown: { cls: "idle", label: "Unknown" },
};
/** Names the prototype uses for the services the server reports under another name. */
const SERVICE_NAME: Record<string, string> = { api: "API gateway", worker: "Worker pool", db: "Postgres" };

const when = (iso: string | null): string => (iso && Number.isFinite(Date.parse(iso)) ? fmt.iso(Date.parse(iso)) : "–");
const ageShort = (sec: number): string => (sec < 120 ? `${sec}s` : sec < 7200 ? `${Math.round(sec / 60)} min` : `${Math.round(sec / 3600)} h`);

function BackupsCard({ b }: { b: BackupStatus }) {
  const rows = b.at ? [b] : [];
  const chip = b.status === "ok" ? { cls: "ok", label: "Verified" } : b.status === "stale" ? { cls: "warn", label: "Stale" } : b.status === "failed" ? { cls: "bad", label: "Failed" } : { cls: "idle", label: "Unknown" };
  return (
    <Card title="Backups" id="sys-backups" flush acts={<Btn label="Back up now" small id="sys-backup-now" disabledReason={NOT_AVAILABLE} />}>
      <div id="sys-backup">
        <DataTable
          id="sys-backups-table"
          caption="Backups"
          rows={rows}
          rowKey={(r) => r.set ?? r.at ?? "latest"}
          empty={{ title: "No backups recorded", text: b.detail }}
          columns={[
            { key: "at", label: "When", render: (r) => <span className="mono">{when(r.at)}</span> },
            { key: "size", label: "Size", render: () => <span className="mono dim" title={NOT_AVAILABLE}>not available</span> },
            { key: "status", label: "Status", render: () => <span className={`chip ${chip.cls}`} title={b.detail}>{chip.label}</span> },
          ]}
        />
      </div>
    </Card>
  );
}

function DrillCard({ d }: { d: DrillStatus }) {
  const chip = d.status === "ok" ? { cls: "ok", label: "Passed" } : d.status === "failed" ? { cls: "bad", label: "Failed" } : { cls: "idle", label: "Not run yet" };
  return (
    <Card title="Restore drill" id="sys-drill">
      <dl className="kv">
        <dt>Last drill</dt><dd>{when(d.at)}</dd>
        <dt>Recovery time</dt><dd><span className="mono">{d.seconds !== null ? fmt.dur(d.seconds * 1000) : "–"}</span></dd>
        <dt>Result</dt><dd><span className={`chip ${chip.cls}`}>{chip.label}</span></dd>
      </dl>
      {d.status === "failed" ? <p className="small dim">{d.failedChecks} check{d.failedChecks === 1 ? "" : "s"} failed. {d.detail}</p> : null}
      <div style={{ marginTop: 12 }}><Btn label="Run a drill" id="sys-drill-run" disabledReason={NOT_AVAILABLE} /></div>
    </Card>
  );
}

function ActionBtns({ r, canRetry }: { r: DeadLetter; canRetry: ReturnType<typeof dec> }) {
  const retry = useCommand(() => retryDeadLetter(r.id), { ok: `Redelivered to ${r.destination}.` });
  return (
    <span className="row" style={{ justifyContent: "flex-end" }}>
      <Btn small label="Retry" id={`sys-retry-${r.id}`} guard={canRetry.allowed ? null : canRetry} disabledReason={retry.wait("Retrying…")} onClick={() => void retry.run()} />
      <Btn small kind="ghost danger" label="Discard" id={`sys-discard-${r.id}`} disabledReason={NOT_AVAILABLE} />
    </span>
  );
}

function OutboxCard({ h }: { h: SystemHealth }) {
  const canRetry = dec(useCan("integration.edit"));
  const c = h.outbox.counts;
  const oldest = h.outbox.oldestPendingSeconds;
  return (
    <Card title="Dead letters" id="sys-outbox" flush hint={<span className="mono" id="sys-counts">{`pending ${fmt.num(c.pending)} · sending ${fmt.num(c.sending)} · delivered ${fmt.num(c.delivered)} · dead ${fmt.num(c.dead)} · oldest pending ${oldest === null ? "–" : fmt.dur(oldest * 1000)}`}</span>}>
      <DataTable
        id="sys-dead"
        caption="Dead letters"
        rows={h.outbox.dead}
        rowKey={(r) => r.id}
        empty={{ title: "No dead letters", text: "Everything was delivered." }}
        columns={[
          { key: "id", label: "ID", render: (r) => <span className="mono">{r.id}</span> },
          { key: "destination", label: "Topic", sort: true, render: (r) => <span className="mono" title={r.scope === "project" ? "Belongs to a project's notifications" : undefined}>{r.destination}</span> },
          { key: "lastError", label: "Error", render: (r) => <span title={r.lastError ?? undefined}>{r.lastError ?? "No error recorded."}</span> },
          { key: "attempts", label: "Attempts", sort: true, render: (r) => <span className="mono">{r.attempts}</span> },
          { key: "act", label: "", align: "end", render: (r) => <ActionBtns r={r} canRetry={canRetry} /> },
        ]}
      />
    </Card>
  );
}

function StuckCard({ h }: { h: SystemHealth }) {
  return (
    <Card title="Stuck work orders" id="sys-jobs" flush hint={`Flagged by the worker: a lost lease, or a run over ${h.jobs.runningLongMinutes / 60} hours.`}>
      <div className="list">
        {h.jobs.stuck.map((j: StuckJob) => {
          const since = j.startedAt ? Date.parse(j.startedAt) : NaN;
          return (
            <div className="li" key={j.id} data-key={j.id}>
              <Lamp tone="warn" />
              <div className="main1">
                <span className="t1"><span className="mono">{j.kind}</span> in {j.queue}</span>
                <span className="t2">{`${j.reason === "lease_expired" ? "Lease expired" : `Over ${h.jobs.runningLongMinutes / 60}h`} · ${Number.isFinite(since) ? fmt.dur(Date.now() - since) : "not started"} · try ${j.attempts}/${j.maxAttempts}`}</span>
              </div>
              <Btn small label="Nudge" id={`sys-nudge-${j.id}`} disabledReason={NOT_AVAILABLE} />
            </div>
          );
        })}
        {h.jobs.stuck.length === 0 ? <CrEmpty icon="check" title="Nothing stuck" text="All work orders are moving." /> : null}
      </div>
    </Card>
  );
}

function ServiceCard({ s }: { s: ServiceHealth }) {
  const t = SERVICE_CHIP[s.status];
  const colour = s.status === "ok" ? "ok" : s.status === "degraded" ? "warn" : s.status === "down" ? "bad" : "idle";
  return (
    <section className="card" data-service={s.id}>
      <div className="card-b stack" style={{ gap: 8 }}>
        <div className="row spread">
          <b className="ell">{SERVICE_NAME[s.id] ?? s.name}</b>
          <span className={`chip ${t.cls}`}>{t.label}</span>
        </div>
        {/* the server reports the state now, not an uptime history: one bar in today's colour */}
        <div className="uptime" aria-hidden="true">
          <svg viewBox="0 0 200 16" width="100%" height="16" preserveAspectRatio="none"><rect x={0} y={0} width={200} height={16} rx={2} fill={`var(--${colour})`} opacity={0.85} /></svg>
        </div>
        <div className="row spread mono dim" style={{ fontSize: 11 }}>
          <span title="Uptime over 30 days is not reported by the server">30d n/a</span>
          <span className="ell" title={s.detail}>{s.heartbeatAgeSeconds != null ? ageShort(s.heartbeatAgeSeconds) : s.latencyMs === null ? s.detail : `${s.latencyMs} ms`}</span>
        </div>
      </div>
    </section>
  );
}

export default function SystemView() {
  const q = useSystemHealth();
  const h = q.data;
  const qs = useQueryState(QS);
  const tab = (SYS_TABS as readonly string[]).includes(qs.values.tab) ? qs.values.tab : "overview";
  const setTab = (t: string) => qs.set({ tab: t === "overview" ? null : t });
  const up = h ? h.services.filter((s) => s.status === "ok").length : 0;
  const worker = h?.services.find((s) => s.id === "worker");
  const hb = worker?.heartbeatAgeSeconds;
  return (
    <Page cls="view-system" eyebrow="Govern" title="System health" sub="Services, worker heartbeat, backups, outbox and stuck work." acts={<Btn small icon="refresh" label="Refresh" id="sys-refresh" onClick={() => void q.refetch()} />}>
      <Stats id="sys-stats" items={[
        { l: "Worker heartbeat", v: hb != null ? `${hb}s` : "–", d: "last tick", tone: hb != null && hb >= 30 ? "bad" : "ok" },
        { l: "Services healthy", v: h ? `${up}/${h.services.length}` : "–", tone: h && up < h.services.length ? "warn" : "ok" },
        { l: "Dead letters", v: h ? fmt.num(h.outbox.counts.dead) : "–", tone: h && h.outbox.counts.dead ? "warn" : "ok" },
        { l: "Stuck work orders", v: h ? fmt.num(h.jobs.stuck.length) : "–", d: "flagged jobs", tone: h && h.jobs.stuck.length ? "warn" : "ok" },
      ]} />
      <Tabs idPrefix="sys-tab" active={tab} onChange={setTab} items={[{ id: "overview", label: "Services" }, { id: "backups", label: "Backups and drill" }, { id: "outbox", label: "Outbox", count: h?.outbox.counts.dead ?? 0 }, { id: "stuck", label: "Stuck jobs", count: h?.jobs.stuck.length ?? 0 }]} />
      <Async query={q} what="system health" id="sys">
        {(d) => tab === "backups" ? (
          <>
            {d.backup.status === "stale" ? <div className="banner warn" id="sys-stale" role="alert"><div className="grow">The newest backup is over {STALE_HOURS} hours old. Check the backup service before you rely on it.</div></div> : null}
            <div className="grid g-main2"><BackupsCard b={d.backup} /><DrillCard d={d.drill} /></div>
          </>
        ) : tab === "outbox" ? <OutboxCard h={d} /> : tab === "stuck" ? <StuckCard h={d} /> : (
          <div className="grid g4" aria-label="Services">{d.services.map((s) => <ServiceCard key={s.id} s={s} />)}</div>
        )}
      </Async>
    </Page>
  );
}
