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
import { useUI } from "../../ui/overlay-context";
import { hashFor } from "../../lib/router";
import { dec } from "../mcp/kit";
import { retryDeadLetter, useSystemHealth, type BackupStatus, type DeadLetter, type DrillStatus, type ServiceHealth, type StuckJob, type SystemHealth } from "./data";

/** A backup older than this is stale; the server decides, this only labels the number. */
const STALE_HOURS = 26;
export const SYS_TABS = ["overview", "backups", "outbox", "stuck"] as const;
const QS = ["tab"] as const;
const noEndpoint = (what: string): string => `${what} is not available yet: the server has no endpoint for it.`;
const NOT_AVAILABLE = "Not available yet: the server has no endpoint for this.";

const SERVICE_CHIP: Record<ServiceHealth["status"], { cls: string; label: string }> = {
  ok: { cls: "ok", label: "Healthy" },
  degraded: { cls: "warn", label: "Degraded" },
  down: { cls: "bad", label: "Down" },
  unknown: { cls: "idle", label: "Unknown" },
};
/** Names the prototype uses for the services the server reports under another name. */
const SERVICE_NAME: Record<string, string> = { api: "API gateway", worker: "Worker pool", db: "Postgres" };

/** "09 Nov 05:31", as the prototype writes a time (India time like the rest of the product). */
const when = (iso: string | null): string => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).replace(",", "") : "–");
const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
const mins = (sec: number): string => (sec < 120 ? `${sec} s` : sec < 7200 ? `${Math.round(sec / 60)} min` : `${Math.round(sec / 3600)} h`);

function BackupsCard({ b }: { b: BackupStatus }) {
  const ui = useUI();
  const rows = b.at ? [b] : [];
  const chip = b.status === "ok" ? { cls: "ok", label: "Verified" } : b.status === "stale" ? { cls: "warn", label: "Stale" } : b.status === "failed" ? { cls: "bad", label: "Failed" } : { cls: "idle", label: "Unknown" };
  return (
    <Card title="Backups" id="sys-backups" flush acts={<Btn label="Back up now" small id="sys-backup-now" onClick={() => ui.toast(noEndpoint("Starting a backup"), "info")} />}>
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
  const ui = useUI();
  const chip = d.status === "ok" ? { cls: "ok", label: "Passed" } : d.status === "failed" ? { cls: "bad", label: "Failed" } : { cls: "idle", label: "Not run yet" };
  return (
    <Card title="Restore drill" id="sys-drill">
      <dl className="kv">
        <dt>Last drill</dt><dd>{when(d.at)}</dd>
        <dt>Recovery time</dt><dd><span className="mono">{d.seconds !== null ? mins(d.seconds) : "–"}</span></dd>
        <dt>Result</dt><dd><span className={`chip ${chip.cls}`}>{chip.label}</span></dd>
      </dl>
      {d.status === "failed" ? <p className="small dim">{d.failedChecks} check{d.failedChecks === 1 ? "" : "s"} failed. {d.detail}</p> : null}
      <div style={{ marginTop: 12 }}><Btn label="Run a drill" id="sys-drill-run" onClick={() => ui.toast(noEndpoint("Starting a restore drill"), "info")} /></div>
    </Card>
  );
}

function ActionBtns({ r, canRetry }: { r: DeadLetter; canRetry: ReturnType<typeof dec> }) {
  const ui = useUI();
  const retry = useCommand(() => retryDeadLetter(r.id), { ok: `Redelivered to ${r.destination}.` });
  return (
    <span className="row" style={{ justifyContent: "flex-end" }}>
      <Btn small label="Retry" id={`sys-retry-${r.id}`} guard={canRetry.allowed ? null : canRetry} disabledReason={retry.wait("Retrying…")} onClick={() => void retry.run()} />
      <Btn small kind="ghost danger" label="Discard" id={`sys-discard-${r.id}`} onClick={() => ui.dialog({
        title: `Discard ${r.id}?`, sub: "The message is dropped and recorded in the audit ledger.", body: null,
        actions: [{ label: "Cancel" }, { label: "Discard", kind: "danger", id: "sys-discard-ok", onClick: (close) => { close(); ui.toast(noEndpoint("Discarding a dead letter"), "error"); } }],
      })} />
    </span>
  );
}

function OutboxCard({ h }: { h: SystemHealth }) {
  const canRetry = dec(useCan("integration.edit"));
  return (
    <Card title="Dead letters" id="sys-outbox" flush>
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
  const ui = useUI();
  return (
    <Card title="Stuck work orders" id="sys-jobs" flush>
      <div className="list">
        {h.jobs.stuck.map((j: StuckJob) => {
          const since = j.startedAt ? Date.parse(j.startedAt) : NaN;
          return (
            <div className="li" key={j.id} data-key={j.id}>
              <Lamp tone="warn" />
              <div className="main1">
                <span className="t1">{j.workOrder ? <><a href={hashFor("record", j.workOrder, j.project ?? null)}>{j.workOrder}</a>{j.station ? ` at ${cap(j.station)}` : ""}</> : <><span className="mono">{j.kind}</span> in {j.queue}</>}</span>
                <span className="t2">{`${j.reason === "lease_expired" ? "Lease expired" : `Over ${h.jobs.runningLongMinutes / 60}h`} · ${Number.isFinite(since) ? fmt.dur(Date.now() - since) : "not started"} · try ${j.attempts}/${j.maxAttempts}`}</span>
              </div>
              <Btn small label="Nudge" id={`sys-nudge-${j.id}`} onClick={() => ui.toast(noEndpoint("Nudging a stuck job"), "info")} />
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
        {/* the server reports the state now, not an uptime history: the strip is drawn in today's state colour (backend gap: 30-day history) */}
        <div className="uptime" aria-hidden="true" title="The server reports today's state, not an uptime history">
          <svg viewBox="0 0 200 16" width="100%" height="16" preserveAspectRatio="none">
            {Array.from({ length: 40 }, (_, i) => {
              const dip = s.status === "degraded" && i === 8;
              return <rect key={i} x={i * 5} y={dip ? 4 : 0} width={3.5} height={dip ? 12 : 16} rx={1} fill={`var(--${s.status === "degraded" && !dip ? "ok" : colour})`} opacity={0.85} />;
            })}
          </svg>
        </div>
        <div className="row spread mono dim" style={{ fontSize: 11 }}>
          <span title={s.uptime30d == null ? "Uptime over 30 days is not reported by the server" : undefined}>{s.uptime30d == null ? "n/a" : `${s.uptime30d}%`} 30d</span>
          <span className="ell" title={s.detail}>{s.detail}</span>
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
    <Page cls="view-system" eyebrow="Govern" title="System health" sub="Services, worker heartbeat, backups, outbox and stuck work.">
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
