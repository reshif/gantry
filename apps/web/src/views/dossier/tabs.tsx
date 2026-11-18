/** The tabs of the work order page after Overview, in the prototype's markup: Journey, Gates, Attempts and runs, Conversation, Cost and Events. Every figure comes from the work order and record reads. */
import type { ReactNode } from "react";
import { fmt, type Catalog, type Project } from "@gantry/domain";
import { Btn, Who } from "../../ui/primitives";
import { DataTable, type Col } from "../../ui/DataTable";
import { Card } from "../../ui/cr";
import { Empty } from "../../ui/primitives";
import { useActors } from "../../ui/actors";
import { navigate } from "../../lib/router";
import { WoSessionPage } from "../conversations/Session";
import type { WoSession } from "../conversations/session-api";
import type { TWo } from "../traveler/model";
import { toRecEvent } from "../traveler/model";
import type { RecordData } from "../record/data";

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const Chip = ({ tone, children }: { tone: string; children: ReactNode }) => <span className={`chip ${tone}`}>{children}</span>;

const orderOf = (cat: Catalog, project: Project | null): string[] => (project?.flow?.order?.length ? project.flow.order : cat.stations.filter((s) => !s.custom).map((s) => s.id));

/** Journey: one timeline row per station up to where the work order is. */
export function JourneyTimeline({ wo, cat, project }: { wo: TWo; cat: Catalog; project: Project | null }) {
  const actor = useActors();
  const order = orderOf(cat, project);
  const rows = order
    .map((id) => ({ s: cat.stations.find((x) => x.id === id), idx: cat.stations.findIndex((x) => x.id === id) }))
    .filter((r): r is { s: NonNullable<typeof r.s>; idx: number } => !!r.s && (wo.state === "done" || r.idx <= wo.station));
  return (
    <Card title="Journey" id="dz-journey">
      <div className="tl">
        {rows.map(({ s, idx }) => {
          const visits = wo.history.filter((h) => h.station === s.id);
          const h = visits[visits.length - 1];
          const skipped = !visits.length && !wo.route.includes(s.id);
          const cur = idx === wo.station && wo.state !== "done";
          const tone = skipped ? "" : cur ? (wo.state === "waiting" ? "warn" : "info") : "ok";
          const dur = visits.reduce((t, v) => t + Math.max(0, (v.endedAt ?? v.startedAt) - v.startedAt), 0);
          return (
            <div key={s.id} className={tone}>
              <div><b>{s.name}</b> {skipped ? <Chip tone="idle">{`Skipped for ${wo.cls}`}</Chip> : cur ? (wo.state === "waiting" ? <Chip tone="warn">Gate</Chip> : <Chip tone="info">In progress</Chip>) : <Chip tone="ok">Done</Chip>}</div>
              {h ? <div className="dim">{`${actor(h.agent).name.replace(" (agent)", "")} · ${h.model} · ${fmt.dur(dur)}`}</div> : null}
              {h ? <div className="when">{fmt.stamp(h.startedAt)}</div> : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

type GateRow = { id: string; name: string; mode: string; status: "waiting" | "passed" | "todo"; by: string | null; at: number | null };

export function GatesTab({ wo, cat, project, rec, review }: { wo: TWo; cat: Catalog; project: Project | null; rec: RecordData; review: ReactNode }) {
  const order = orderOf(cat, project);
  const rows: GateRow[] = order
    .filter((sid) => wo.route.includes(sid))
    .map((sid) => cat.gates.find((g) => g.after === sid))
    .filter((g): g is NonNullable<typeof g> => !!g)
    .map((g) => {
      const inst = wo.gates[g.id];
      const rg = rec.gates.filter((x) => x.gate === g.id).at(-1);
      const by = rg?.decision?.decided_by ?? rg?.votes.at(-1)?.by ?? inst?.approvals?.at(-1)?.by ?? null;
      const at = rg?.decision?.at ? Date.parse(rg.decision.at) : rg?.closedAt ? Date.parse(rg.closedAt) : null;
      // a gate the work order has moved past counts as passed even when the read does not mark it
      const behind = cat.stations.findIndex((x) => x.id === g.after) < wo.station || wo.state === "done";
      const status: GateRow["status"] = inst?.status === "waiting" ? "waiting" : inst?.status === "passed" || (behind && inst?.status !== "failed") ? "passed" : "todo";
      return { id: g.id, name: g.name, mode: project?.flow?.gates?.[g.id]?.mode ?? g.kind, status, by: status === "passed" ? by : null, at: status === "passed" ? at : null };
    });
  const cols: Col<GateRow>[] = [
    { key: "gate", label: "Gate", render: (r) => <><b className="mono">{cat.gates.find((g) => g.id === r.id)?.label ?? r.id}</b>{` ${r.name}`}</> },
    { key: "mode", label: "Mode", render: (r) => cap(r.mode) },
    { key: "status", label: "Status", render: (r) => (r.status === "waiting" ? <Chip tone="warn">Waiting</Chip> : r.status === "passed" ? <Chip tone="ok">Approved</Chip> : <Chip tone="idle">Not reached</Chip>) },
    { key: "by", label: "Decided by", render: (r) => (r.by ? <Who id={r.by} /> : <span className="dim">{"—"}</span>) },
    { key: "when", label: "When", render: (r) => <span className="mono dim">{r.at ? fmt.stamp(r.at) : "—"}</span> },
  ];
  return (
    <Card title="Gates" flush acts={review} id="dz-gates">
      <DataTable id="dz-gates-table" caption={`Gates of ${wo.id}`} columns={cols} rows={rows} rowKey={(r) => r.id} empty={{ title: "No gates on this route" }} />
    </Card>
  );
}

type AttemptRow = { n: number; station: string; tone: string; outcome: string; dur: number; tokens: number; model: string };

export function AttemptsTab({ wo, cat }: { wo: TWo; cat: Catalog }) {
  const rows: AttemptRow[] = wo.history.map((h, i) => {
    const open = !h.endedAt && wo.state !== "done";
    const o = (h.outcome ?? "").toLowerCase();
    const rework = /back|rework|reject|fail|retry/.test(o);
    return { n: i + 1, station: cat.stations.find((s) => s.id === h.station)?.name ?? h.station, tone: open ? "info" : rework ? "warn" : "ok", outcome: open ? "Running" : rework ? "Reworked" : "Passed", dur: Math.max(0, (h.endedAt ?? h.startedAt) - h.startedAt), tokens: h.tokens, model: h.model };
  });
  const cols: Col<AttemptRow>[] = [
    { key: "n", label: "Attempt", render: (r) => <span className="mono">{`#${r.n}`}</span> },
    { key: "station", label: "Station" },
    { key: "outcome", label: "Outcome", render: (r) => <Chip tone={r.tone}>{r.outcome}</Chip> },
    { key: "dur", label: "Duration", align: "end", render: (r) => <span className="mono">{fmt.dur(r.dur)}</span> },
    { key: "tokens", label: "Tokens", align: "end", render: (r) => <span className="mono">{fmt.k(r.tokens)}</span> },
    { key: "model", label: "Model", render: (r) => <span className="mono">{r.model}</span> },
  ];
  return (
    <Card title="Attempts and runs" flush id="dz-attempts">
      <DataTable id="dz-attempts-table" caption={`Attempts of ${wo.id}`} columns={cols} rows={rows} rowKey={(r) => String(r.n)} empty={{ title: "No attempts yet", text: "An agent has not started on this work order." }} />
    </Card>
  );
}

export function ConversationTab({ wo, session, loading }: { wo: TWo; session: WoSession | undefined; loading: boolean }) {
  if (!session && !loading) {
    return (
      <div className="card">
        <Empty icon="chat" title="No conversation yet" text="Agents open a thread when they need an answer." action={<Btn label="All conversations" id="dz-all-conv" onClick={() => navigate("conversations", null, wo.project)} />} />
      </div>
    );
  }
  return (
    <Card title={`Conversation${session ? ` with ${session.agent.name}` : ""}`} id="dz-conversation" acts={<Btn label="Open thread" small id="dz-open-thread" onClick={() => navigate("conversations", wo.id, wo.project)} />}>
      <WoSessionPage woId={wo.id} bare back={() => navigate("record", wo.id, wo.project)} />
    </Card>
  );
}

export function CostTab({ wo, cat }: { wo: TWo; cat: Catalog }) {
  const by = new Map<string, number>();
  for (const h of wo.history) by.set(h.station, (by.get(h.station) ?? 0) + h.cost);
  const rows = [...by].map(([id, v]) => ({ id, n: cat.stations.find((s) => s.id === id)?.name ?? id, v }));
  const total = rows.reduce((t, r) => t + r.v, 0);
  const tokens = wo.history.reduce((t, h) => t + h.tokens, 0);
  const top = Math.max(...rows.map((r) => r.v), 0.01);
  return (
    <div className="grid g2" id="dz-cost">
      <Card title="Cost by station" hint={`Total ${fmt.money(total)}`}>
        {rows.length ? (
          <div className="stack" style={{ gap: 8 }}>
            {rows.map((r) => (
              <div key={r.id} className="row nowrap">
                <span style={{ width: 120, flex: "none" }}>{r.n}</span>
                <div className="meter ok" role="meter" aria-label={`${r.n} cost`} aria-valuemin={0} aria-valuemax={top} aria-valuenow={r.v}><i style={{ width: `${(r.v / top) * 100}%` }} /></div>
                <span className="mono" style={{ width: 64, textAlign: "right" }}>{fmt.money(r.v)}</span>
              </div>
            ))}
          </div>
        ) : <p className="muted small">No spend recorded yet.</p>}
      </Card>
      <Card title="Tokens">
        <div className="stack" style={{ gap: 6 }}>
          <span className="mono" style={{ fontSize: 22 }}>{fmt.k(tokens)}</span>
          <span className="dim mono">tokens in total</span>
          <span><span className="lamp info" /> Input: <span className="dim">not available</span></span>
          <span><span className="lamp agent" /> Output: <span className="dim">not available</span></span>
          <span><span className="lamp ok" /> Cached: <span className="dim">not available</span></span>
          <span className="dim small">The server records tokens per station, not split into input, output and cached.</span>
        </div>
      </Card>
    </div>
  );
}

const TONE: Record<string, string> = { ok: "ok", denied: "bad", error: "bad", failed: "bad", refused: "warn", gated: "warn" };

export function EventsTab({ rec }: { rec: RecordData }) {
  const actor = useActors();
  const events = [...rec.events].reverse().map(toRecEvent);
  return (
    <Card title="Events" id="dz-events">
      {events.length ? (
        <div className="tl">
          {events.map((e) => (
            <div key={e.seq} className={TONE[e.outcome] ?? "info"}>
              <div>{`${e.type}${e.station ? ` · ${e.station}` : e.gate ? ` · ${e.gate}` : ""}${e.text ? ` · ${e.text}` : ""}`}<span className="dim">{` · ${actor(e.by).name}`}</span></div>
              <div className="when">{e.at ? fmt.stamp(e.at) : ""}</div>
            </div>
          ))}
        </div>
      ) : <p className="muted small">No events recorded yet.</p>}
    </Card>
  );
}
