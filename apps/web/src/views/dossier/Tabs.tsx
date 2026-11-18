/**
 * The prototype's work order tabs, built from the real reads: Journey (every station, skipped ones marked), Gates (every gate with who
 * decided), Attempts and runs, Cost and Events. Presentation only; nothing here writes.
 */
import type { ReactNode } from "react";
import { fmt, type Catalog } from "@gantry/domain";
import { Card, CrEmpty } from "../../ui/cr";
import { DataTable } from "../../ui/DataTable";
import { Meter, Who } from "../../ui/primitives";
import { useActors } from "../../ui/actors";
import type { RecordData } from "../record/data";
import { stName, toRecEvent, type TWo } from "../traveler/model";

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const when = (at: number | null | undefined): string => (at ? fmt.stamp(at) : "");

export function JourneyTab({ wo, cat }: { wo: TWo; cat: Catalog }) {
  const actor = useActors();
  type JRow = { key: string; tone: string; s: Catalog["stations"][number]; visit: TWo["history"][number] | null; skipped: boolean };
  const rows = cat.stations.flatMap((s, i): JRow[] => {
    const visits = wo.history.filter((h) => h.station === s.id);
    if (visits.length) return visits.map((v, n) => ({ key: `${s.id}-${n}`, tone: v.endedAt ? "ok" : "info", s, visit: v, skipped: false }));
    // a station inside the route that the work order will never visit is shown as skipped; stations still ahead are not part of the journey yet
    const ahead = wo.state !== "done" && i > wo.station;
    return !wo.route.includes(s.id) && !ahead ? [{ key: s.id, tone: "", s, visit: null, skipped: true }] : [];
  });
  return (
    <Card title="Journey" id="dz-journey">
      {rows.length ? (
        <div className="tl">
          {rows.map((r) => {
            const v = r.visit;
            const cur = !!v && !v.endedAt;
            const chip = r.skipped ? <span className="chip idle">{`Skipped for ${wo.cls}`}</span> : cur ? <span className={`chip ${wo.state === "waiting" ? "warn" : "info"}`}>{wo.state === "waiting" ? "Gate" : "In progress"}</span> : <span className="chip ok">Done</span>;
            return (
              <div key={r.key} className={r.tone}>
                <div><b>{r.s.name}</b> {chip}</div>
                {v ? <div className="dim">{`${actor(v.agent).name.replace(" (agent)", "")} · ${v.model} · ${fmt.dur(Math.max(0, (v.endedAt ?? Date.now()) - v.startedAt))}`}</div> : null}
                {v ? <div className="when">{when(v.startedAt)}</div> : null}
              </div>
            );
          })}
        </div>
      ) : <CrEmpty title="No journey yet" text="The work order has not entered a station." icon="floor" />}
    </Card>
  );
}

interface GateRow { id: string; label: string; name: string; mode: string; status: "waiting" | "approved" | "not reached" | "rejected"; by: string | null; at: number | null }

export function GatesTab({ wo, rec, cat, acts }: { wo: TWo; rec: RecordData; cat: Catalog; acts?: ReactNode }) {
  const rows: GateRow[] = cat.gates.map((g) => {
    const gi = wo.gates[g.id];
    const r = [...rec.gates].reverse().find((x) => x.gate === g.id);
    const decided = r?.decision ?? null;
    const status: GateRow["status"] = gi?.status === "waiting" ? "waiting" : gi?.status === "passed" ? "approved" : (gi?.status as string) === "rejected" ? "rejected" : "not reached";
    const by = decided?.decided_by ?? r?.votes[r.votes.length - 1]?.by ?? gi?.approvals[gi.approvals.length - 1]?.by ?? null;
    const at = decided?.at ? Date.parse(decided.at) : r?.closedAt ? Date.parse(r.closedAt) : null;
    return { id: g.id, label: g.label, name: g.name, mode: cap(decided?.detail?.mode ?? g.kind ?? ""), status, by, at };
  });
  return (
    <Card title="Gates" flush acts={acts} id="dz-gates">
      <DataTable<GateRow>
        id="dz-gates-table"
        caption="Gates on this work order"
        rows={rows}
        rowKey={(g) => g.id}
        columns={[
          { key: "gate", label: "Gate", render: (g) => <span><b className="mono">{g.label}</b> {g.name}</span> },
          { key: "mode", label: "Mode", render: (g) => g.mode },
          { key: "status", label: "Status", render: (g) => <span className={`chip ${g.status === "waiting" ? "warn" : g.status === "approved" ? "ok" : g.status === "rejected" ? "bad" : "idle"}`}>{cap(g.status)}</span> },
          { key: "by", label: "Decided by", render: (g) => (g.by ? <Who id={g.by} /> : <span className="dim">—</span>) },
          { key: "when", label: "When", render: (g) => <span className="mono dim">{g.at ? when(g.at) : "—"}</span> },
        ]}
      />
    </Card>
  );
}

interface AttemptRow { n: number; station: string; ok: boolean; dur: number; tokens: number; model: string }

export function AttemptsTab({ wo, cat }: { wo: TWo; cat: Catalog }) {
  const rows: AttemptRow[] = wo.history.map((h, i) => ({ n: i + 1, station: stName(cat, h.station), ok: h.outcome ? ["pass", "passed", "ok", "done", "approved"].includes(h.outcome) : !!h.endedAt, dur: Math.max(0, (h.endedAt ?? Date.now()) - h.startedAt), tokens: h.tokens, model: h.model }));
  return (
    <Card title="Attempts and runs" flush id="dz-attempts">
      <DataTable<AttemptRow>
        id="dz-attempts-table"
        caption="Attempts and runs"
        rows={rows}
        rowKey={(a) => String(a.n)}
        empty={{ title: "No attempts yet", text: "An attempt is recorded each time an agent works a station." }}
        columns={[
          { key: "n", label: "Attempt", render: (a) => <span className="mono">{`#${a.n}`}</span> },
          { key: "station", label: "Station", render: (a) => a.station },
          { key: "ok", label: "Outcome", render: (a) => <span className={`chip ${a.ok ? "ok" : "warn"}`}>{a.ok ? "Passed" : "Reworked"}</span> },
          { key: "dur", label: "Duration", align: "end", render: (a) => <span className="mono">{fmt.dur(a.dur)}</span> },
          { key: "tokens", label: "Tokens", align: "end", render: (a) => <span className="mono">{fmt.k(a.tokens)}</span> },
          { key: "model", label: "Model", render: (a) => <span className="mono">{a.model}</span> },
        ]}
      />
    </Card>
  );
}

const SEGMENT_TONES = ["info", "agent", "ok", "warn", "bad", "idle"] as const;

function Donut({ parts, size = 112 }: { parts: Array<{ l: string; v: number; c: string }>; size?: number }) {
  const r = size / 2 - 8;
  const C = 2 * Math.PI * r;
  const tot = parts.reduce((s, p) => s + p.v, 0) || 1;
  let off = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={parts.map((p) => `${p.l} ${p.v}`).join(", ")}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={12} />
      {parts.map((p) => {
        const len = (p.v / tot) * C;
        const o = off;
        off += len;
        return <circle key={p.l} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`var(--${p.c})`} strokeWidth={12} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-o} transform={`rotate(-90 ${size / 2} ${size / 2})`} />;
      })}
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill="var(--text)" fontFamily="var(--mono)" fontWeight={600} fontSize={18}>{Math.round(tot)}</text>
    </svg>
  );
}

export function CostTab({ wo, cat }: { wo: TWo; cat: Catalog }) {
  const byStation = cat.stations
    .map((s) => {
      const v = wo.history.filter((h) => h.station === s.id);
      return { id: s.id, name: s.name, cost: v.reduce((t, h) => t + h.cost, 0), tokens: v.reduce((t, h) => t + h.tokens, 0), seen: v.length > 0 };
    })
    .filter((r) => r.seen);
  const total = byStation.reduce((t, r) => t + r.cost, 0);
  const max = Math.max(0.01, ...byStation.map((r) => r.cost));
  const parts = byStation.map((r, i) => ({ l: r.name, v: Math.round(r.tokens / 1000), c: SEGMENT_TONES[i % SEGMENT_TONES.length] as string })).filter((p) => p.v > 0);
  return (
    <div className="grid g2" id="dz-cost">
      <Card title="Cost by station" hint={`Total ${fmt.money(total)}`}>
        {byStation.length ? (
          <div className="stack" style={{ gap: 8 }}>
            {byStation.map((r) => (
              <div className="row nowrap" key={r.id}>
                <span style={{ width: 120, flex: "none" }}>{r.name}</span>
                <Meter value={r.cost} max={max} label={`${r.name} cost`} />
                <span className="mono" style={{ width: 64, textAlign: "right" }}>{fmt.money(r.cost)}</span>
              </div>
            ))}
          </div>
        ) : <CrEmpty title="No cost yet" text="Cost appears once an agent has run." icon="inbox" />}
      </Card>
      <Card title="Tokens" hint="Thousand tokens by station">
        {parts.length ? (
          <div className="row" style={{ gap: 24 }}>
            <Donut parts={parts} />
            <div className="stack" style={{ gap: 6 }}>
              {parts.map((p) => <span key={p.l}><span className={`lamp ${p.c}`} />{` ${p.l} ${p.v}k`}</span>)}
              <span className="dim mono">The split into input, output and cached is not recorded.</span>
            </div>
          </div>
        ) : <CrEmpty title="No tokens yet" icon="inbox" />}
      </Card>
    </div>
  );
}

export function EventsTab({ rec, cat }: { rec: RecordData; cat: Catalog }) {
  const actor = useActors();
  const events = rec.events.map(toRecEvent).sort((a, b) => b.at - a.at).slice(0, 40);
  const tone = (t: string): string => (t.startsWith("kill") || t.includes("fail") ? "bad" : t.includes("gate") || t.includes("bay") ? "warn" : t === "release" || t === "wo.done" ? "ok" : "info");
  const text = (e: (typeof events)[number]): string => `${e.text ?? e.type}${e.station ? ` ${stName(cat, e.station)}` : ""}${e.by ? ` by ${actor(e.by).name}` : ""}`.trim();
  return (
    <Card title="Events" id="dz-events">
      {events.length ? (
        <div className="tl">
          {events.map((e) => (
            <div key={e.seq} className={tone(e.type)}>
              <div>{text(e)}</div>
              <div className="when">{when(e.at)}</div>
            </div>
          ))}
        </div>
      ) : <CrEmpty title="No events yet" icon="inbox" />}
    </Card>
  );
}
