/** The tabs of the work order page after Overview, in the prototype's markup: Journey, Gates, Attempts and runs, Conversation, Cost and Events. Every figure comes from the work order and record reads. */
import type { ReactNode } from "react";
import { fmt, type Catalog, type Project } from "@gantry/domain";
import { Btn, Who } from "../../ui/primitives";
import { DataTable, type Col } from "../../ui/DataTable";
import { Card } from "../../ui/cr";
import { Empty } from "../../ui/primitives";
import { useActors } from "../../ui/actors";
import { navigate } from "../../lib/router";
import type { WoSession } from "../conversations/session-api";
import type { TWo } from "../traveler/model";
import { toRecEvent, type RecEvent } from "../traveler/model";
import { ago, attemptsOf, type AttemptRow as AttemptRowT, protoStation, when } from "./kit";
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
  const now = Date.now();
  return (
    <Card title="Journey" id="dz-journey">
      <div className="tl">
        {rows.map(({ s, idx }) => {
          const visits = wo.history.filter((h) => h.station === s.id);
          const h = visits[visits.length - 1];
          const skipped = !visits.length && !wo.route.includes(s.id);
          const cur = idx === wo.station && wo.state !== "done";
          const tone = skipped ? "" : cur ? "info" : "ok"; // the dot is blue for the current station even at a gate (the chip says Gate)
          const dur = visits.reduce((t, v) => t + Math.max(0, (v.endedAt ?? now) - v.startedAt), 0);
          const who = actor(h?.agent ?? s.agent).name.replace(" (agent)", "");
          return (
            <div key={s.id} className={tone}>
              <div><b>{protoStation(s)}</b> {skipped ? <Chip tone="idle">{`Skipped for ${wo.cls}`}</Chip> : cur ? (wo.state === "waiting" ? <Chip tone="warn">Gate</Chip> : <Chip tone="info">In progress</Chip>) : <Chip tone="ok">Done</Chip>}</div>
              {skipped ? null : <div className="dim">{[who, h?.model, visits.length ? fmt.dur(dur) : ""].filter(Boolean).join(" · ")}</div>}
              {h ? <div className="when">{when(h.startedAt)}</div> : null}
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
    // a gate that passes by itself has nobody to decide it: the table lists the gates a person decides
    .filter((g) => (project?.flow?.gates?.[g.id]?.mode ?? g.kind) !== "auto")
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
    { key: "by", label: "Decided by", cardLabel: "By", render: (r) => (r.by ? <Who id={r.by} /> : <span className="dim">{"—"}</span>) },
    { key: "when", label: "When", render: (r) => <span className="mono dim">{r.at ? when(r.at) : "—"}</span> },
  ];
  return (
    <Card title="Gates" flush acts={review} id="dz-gates">
      <DataTable id="dz-gates-table" caption={`Gates of ${wo.id}`} columns={cols} rows={rows} rowKey={(r) => r.id} empty={{ title: "No gates on this route" }} />
    </Card>
  );
}

export function AttemptsTab({ wo, cat }: { wo: TWo; cat: Catalog; rec?: RecordData }) {
  const rows = attemptsOf(wo, cat);
  const cols: Col<AttemptRowT>[] = [
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
  const actor = useActors();
  const msgs = (session?.messages ?? []).filter((m) => m.text.trim());
  if (!loading && !msgs.length) {
    return (
      <div className="card">
        <Empty icon="chat" title="No conversation yet" text="Agents open a thread when they need an answer." action={<Btn label="All conversations" id="dz-all-conv" onClick={() => navigate("conversations", null, wo.project)} />} />
      </div>
    );
  }
  return (
    <Card title={`Conversation${session ? ` with ${session.agent.name.replace(" (agent)", "")}` : ""}`} id="dz-conversation" acts={<Btn label="Open thread" small id="dz-open-thread" onClick={() => navigate("conversations", wo.id, wo.project)} />}>
      <div className="stack">
        {msgs.map((m) => (
          <div key={m.id} className={`msg ${m.author.startsWith("ag-") ? "" : "me"}`}>
            <div className="who">{actor(m.author).name.replace(" (agent)", "")} <span className="mono dim">{ago(m.at)}</span></div>
            <div className="bub">{m.text}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** The ring of the Tokens card: the whole total, since the server does not split it. */
function Donut({ label, size = 112 }: { label: string; size?: number }) {
  const r = size / 2 - 8;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} tokens in total`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth="12" />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill="var(--text)" fontFamily="var(--mono)" fontWeight="600" fontSize="16">{label}</text>
    </svg>
  );
}

export function CostTab({ wo, cat, project }: { wo: TWo; cat: Catalog; project: Project | null }) {
  const by = new Map<string, number>();
  for (const h of wo.history) by.set(h.station, (by.get(h.station) ?? 0) + h.cost);
  // every station the work order reached, including the one it is at now and those with no spend yet
  const rows = orderOf(cat, project)
    .map((id) => ({ s: cat.stations.find((x) => x.id === id), idx: cat.stations.findIndex((x) => x.id === id) }))
    .filter((r): r is { s: NonNullable<typeof r.s>; idx: number } => !!r.s && (wo.state === "done" || r.idx <= wo.station) && (wo.route.includes(r.s.id) || by.has(r.s.id)))
    .map(({ s }) => ({ id: s.id, n: protoStation(s), v: by.get(s.id) ?? 0 }));
  const total = rows.reduce((t, r) => t + r.v, 0);
  const tokens = wo.history.reduce((t, h) => t + h.tokens, 0);
  const scale = Math.max(3, ...rows.map((r) => r.v));
  return (
    <div className="grid g2" id="dz-cost">
      <Card title="Cost by station" hint={`Total ${fmt.money(total)}`}>
        {rows.length ? (
          <div className="stack" style={{ gap: 8 }}>
            {rows.map((r) => (
              <div key={r.id} className="row nowrap">
                <span style={{ width: 120, flex: "none" }}>{r.n}</span>
                <div className="meter ok" role="meter" aria-label={`${r.n} cost`} aria-valuemin={0} aria-valuemax={scale} aria-valuenow={r.v}><i style={{ width: `${(r.v / scale) * 100}%` }} /></div>
                <span className="mono" style={{ width: 64, textAlign: "right" }}>{fmt.money(r.v)}</span>
              </div>
            ))}
          </div>
        ) : <p className="muted small">No spend recorded yet.</p>}
      </Card>
      <Card title="Tokens">
        <div className="row nowrap" style={{ gap: 24 }}>
          <Donut label={fmt.k(tokens)} />
          <div className="stack" style={{ gap: 6 }}>
            <span><span className="lamp info" /> Input <span className="dim">not available</span></span>
            <span><span className="lamp agent" /> Output <span className="dim">not available</span></span>
            <span><span className="lamp ok" /> Cached <span className="dim">not available</span></span>
            </div>
        </div>
        <p className="dim small" style={{ marginTop: 12 }}>The server records tokens per station, not split into input, output and cached.</p>
      </Card>
    </div>
  );
}

const TONE: Record<string, string> = { ok: "ok", denied: "bad", error: "bad", failed: "bad", refused: "warn", gated: "warn" };
const named = (cat: Catalog, id: string | undefined): string => {
  const st = cat.stations.find((x) => x.id === id);
  return st ? protoStation(st) : (id ?? "");
};
/** The prototype's sentence for an event: "WO-1004 moved to Build". Types the catalogue below does not know read as their own words. */
export function eventText(e: RecEvent, wo: TWo, cat: Catalog): string {
  const id = wo.id;
  switch (e.type) {
    case "wo.submit": return `${id} submitted`;
    case "wo.enter": return `${id} moved to ${named(cat, e.station)}`;
    case "gate.decision": return `${id} ${String((e.detail as { decision?: string }).decision ?? "decided")} at ${cat.gates.find((g) => g.id === e.gate)?.label ?? e.gate ?? "a gate"}`;
    case "wo.sendback": return `${id} sent back from ${named(cat, e.station)}`;
    case "wo.bay": case "wo.park": return `${id} moved to ${cat.bays.find((b) => b.id === e.bay)?.name ?? e.bay ?? "a bay"}`;
    default: return `${id} ${e.type.replace(/^wo\./, "").replace(/[._]/g, " ")}${e.station ? ` ${named(cat, e.station)}` : ""}`;
  }
}

export function EventsTab({ rec, wo, cat }: { rec: RecordData; wo: TWo; cat: Catalog }) {
  const all = [...rec.events].map(toRecEvent).sort((a, b) => b.at - a.at);
  const events = all.slice(0, 10);
  return (
    <Card title="Events" id="dz-events">
      {events.length ? (
        <div className="tl">
          {events.map((e) => (
            <div key={e.seq} className={TONE[e.outcome] ?? "info"}>
              <div>{eventText(e, wo, cat)}</div>
              <div className="when">{e.at ? when(e.at) : ""}</div>
            </div>
          ))}
        </div>
      ) : <p className="muted small">No events recorded yet.</p>}
    </Card>
  );
}
