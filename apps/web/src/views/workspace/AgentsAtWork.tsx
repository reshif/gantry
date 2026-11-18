/**
 * Agents at work: the Control Room prototype's "workspace" screen. One card per station agent: what it is running right now (the work order,
 * its time at the station, tokens and cost so far), its slot use, and where to talk to it. Read from the floor read of the chosen project
 * (stations, work orders and their open history entry); nothing here is invented. The conversations hub lives at `#workspace/chats`.
 */
import { useMemo } from "react";
import { fmt } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useActivity, useAgents, useHome } from "../../api/queries";
import { scopeToken, useScope } from "../../lib/scope";
import { invalidateSlices } from "../../api/keys";
import { hashFor } from "../../lib/router";
import { eventRows, eventText } from "../../lib/eventText";
import { setRouteState, useClearRouteStateOnLeave, useRouteState } from "../../lib/queryState";
import { useOpenTraveler } from "../../shell/useTraveler";
import { Async, useCommand } from "../../ui/async";
import { useUI } from "../../ui/overlay-context";
import { useTravelerWo } from "../traveler/model";
import { useActors } from "../../ui/actors";
import { Avatar, Btn, Chip, FilterBar, SearchBox, Select } from "../../ui/primitives";
import { Page, Stats } from "../../ui/cr";
import { StateBody, useStateOverride } from "../ops1/stateOverride";
import { buildBelt, NO_FILTER } from "../floor/conveyor";
import { useCatalog } from "../projects/kit";
import { type HomeFull } from "../home/data";
import { openEntry, projectOf, useScopedFloorState, type FWo } from "../floor/kit";

const short = (m: string) => m.replace(/^claude-/, "");
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

export function AgentsAtWork() {
  const scope = useScope();
  const projectId = scope.projectId;
  const projectIds = useMemo(() => scope.projects.map((p) => p.id), [scope.projects]);
  // One project, or every visible project merged (each station's agent works across all of them)
  const { value: ctx, error: floorErr } = useScopedFloorState(scope.all ? { all: true, projectIds } : { all: false, projectId }, null);
  const floorQ = { data: ctx ?? undefined, error: floorErr instanceof Error ? floorErr : null, isPending: !ctx && !floorErr, isError: !ctx && !!floorErr, refetch: () => invalidateSlices(["workOrders"]) };
  const actors = useActors();
  const open = useOpenTraveler();
  const [q, setQ] = useRouteState("q", "");
  const [act, setAct] = useRouteState("st", "all");
  useClearRouteStateOnLeave(["q", "st"]);
  const agents = useAgents().data;
  const modelOf = (id: string): string | null => agents?.find((a) => a.id === id)?.model ?? null;
  const activity = useActivity().data;
  const override = useStateOverride();
  const cat = useCatalog();

  const cards = useMemo(() => {
    if (!ctx) return [];
    const belt = buildBelt(ctx, (id) => actors(id).name.replace(" (agent)", ""), NO_FILTER);
    const byId = new Map<string, FWo>(ctx.wos.map((w) => [w.id, w]));
    return belt.stations.map((s) => {
      const st = ctx.cat.stations.find((x) => x.id === s.id)!;
      const running = s.lane.filter((t) => t.state === "running").map((t) => byId.get(t.id)).filter((w): w is FWo => !!w);
      const next = s.queue[0] ? byId.get(s.queue[0].id) : undefined;
      return { s, agentId: st.agent, running, next, over: Math.max(0, running.length - s.slots) };
    });
  }, [ctx, actors]);

  const needle = q.trim().toLowerCase();
  const list = cards.filter((c) => {
    if (act === "busy" ? !c.running.length : act === "idle" ? c.running.length : false) return false;
    return !needle || `${c.s.agent} ${c.s.name} ${c.running.map((w) => `${w.id} ${w.title}`).join(" ")}`.toLowerCase().includes(needle);
  });
  const busy = list.filter((c) => c.running.length).length;
  // Runs in flight is factory-wide and unfiltered in the prototype: the server's running count, else this project's.
  const factoryRuns = (useHome().data as HomeFull | undefined)?.sections?.motion?.running;
  const runs = list.reduce((n, c) => n + c.running.length, 0);
  /* Tokens in the last hour and cost per hour, from the open runs' own totals: a run older than an hour contributes its last hour pro rata (an estimate, said so on the tile);
     the hourly cost is what the runs have spent over the time they have been running. */
  const now = ctx?.now ?? Date.now();
  const HOUR = 3_600_000;
  let tokens = 0, cost = 0, hours = 0;
  for (const c of list) for (const w of c.running) {
    const e = openEntry(w);
    if (!e) continue;
    const el = Math.max(60_000, now - (e.startedAt ?? w.createdAt));
    tokens += (e.tokens ?? 0) * Math.min(1, HOUR / el);
    cost += e.cost ?? 0;
    hours += el / HOUR;
  }
  const perHour = hours > 0 ? cost / hours : 0;
  const woEvents = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of eventRows(activity)) if (e.wo) m.set(e.wo, [...(m.get(e.wo) ?? []), eventText(e, cat, (id) => actors(id).name.replace(" (agent)", ""))]);
    return m;
  }, [activity, cat, actors]);

  return (
    <Page
      eyebrow="Operate" title="Agents at work" cls="ws-agents"
      sub="What each station's agent is doing right now. You can open a conversation or stop a run."
    >
      {override ? <StateBody state={override} /> : <Async query={floorQ} what={scope.all ? "the agents across all projects" : "the agents on this project"} id="ws-agents" isEmpty={() => false}>{() => (
        <>
          <Stats items={[
            { l: "Agents busy", v: `${busy} / ${cards.length}`, tone: "info" },
            { l: "Runs in flight", v: factoryRuns ?? runs, tone: "agent" },
            { l: "Tokens in flight", v: compact(tokens), d: "last hour, est." },
            { l: "Cost per hour", v: `$${perHour.toFixed(2)}` },
          ]} />
          <FilterBar label="Filter agents" count={`${list.length} of ${cards.length}`} actions={needle || act !== "all" ? <Btn small kind="ghost" label="Clear" id="ws-clear" onClick={() => setRouteState({ q: null, st: null })} /> : undefined}>
            <SearchBox id="ws-q" value={q} onChange={setQ} placeholder="Search agents or work orders" />
            <Select id="ws-act" aria-label="Activity" value={act} onChange={setAct} options={[{ value: "all", label: "Activity: all" }, { value: "busy", label: "Busy" }, { value: "idle", label: "Idle" }]} />
          </FilterBar>
          {list.length ? (
            <div className="grid g3 ws">
              {list.map(({ s, agentId, running, next, over }) => {
                const w = running[0];
                const e = w ? openEntry(w) : undefined;
                return (
                  <section key={s.id} className="card ws-card" id={`ws-card-${s.id}`}>
                    <div className="card-h">
                      <div className="row nowrap" style={{ minWidth: 0 }}>
                        <Avatar id={agentId} />
                        <div style={{ minWidth: 0 }}><h3 className="ell">{s.agent}</h3><div className="hint ell">{s.name}{(modelOf(agentId) ?? e?.model) ? ` · ${short(modelOf(agentId) ?? e?.model ?? "")}` : ""}</div></div>
                      </div>
                      <Chip text={running.length ? "Working" : "Idle"} cls={running.length ? "info" : "idle"} />
                    </div>
                    <div className="card-b ws-b">
                      {w ? (
                        <>
                          <div className="row spread nowrap"><a className="mono" id={`ws-wo-${s.id}`} href={hashFor("record", w.id)} onClick={(e) => { e.preventDefault(); open(w.id); }}>{w.id}</a><span className="mono dim">{fmt.dur(Math.max(0, (ctx?.now ?? Date.now()) - (e?.startedAt ?? w.createdAt)))}</span></div>
                          <div className="ell" title={w.title} style={{ fontWeight: 600 }}>{w.title}</div>
                          <div className="tok-stream" aria-live="off">
                            {streamLines(woEvents.get(w.id) ?? [], e?.tokens ?? 0, e?.cost ?? 0, w.progress ?? 0, s.name).map((l, i, all) => (
                              <div key={i} style={{ opacity: 0.5 + i * 0.25 }}>{`${i === all.length - 1 ? "▸" : "✓"} ${l}`}{i === all.length - 1 ? <span className="caret">▍</span> : null}</div>
                            ))}
                          </div>
                        </>
                      ) : (
                        <div className="ws-idle">
                          <div className="label">Idle</div>
                          <p className="muted">Nothing running at this station.</p>
                          {next ? (<><div className="mono" style={{ fontSize: 12 }}><span className="dim">Next up </span><a href={hashFor("record", next.id)} onClick={(e) => { e.preventDefault(); open(next.id); }}>{next.id}</a></div><div className="ell dim" style={{ fontSize: 12 }}>{next.title}</div></>) : <div className="dim" style={{ fontSize: 12 }}>Queue is empty.</div>}
                        </div>
                      )}
                      <div className="row spread ws-f">
                        <span className="mono" style={{ fontSize: 12 }}><span className="muted">{Math.min(running.length, s.slots)}/{s.slots} slots</span>{over ? <> · <span style={{ color: "var(--warn)" }}>+{over} over capacity</span></> : null}</span>
                        <span className="row">
                          <a className="btn sm" id={`ws-talk-${s.id}`} href={`${hashFor("conversations", null, w && ctx ? projectOf(ctx, w).id : scopeToken(scope))}${w ? `?c=${encodeURIComponent(w.id)}` : ""}`}>Talk</a>
                          {w ? <StopRun woId={w.id} station={s.name} /> : null}
                        </span>
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="grid g3 ws" id="ws-none" />
          )}
        </>
      )}</Async>}
    </Page>
  );
}

/** Three lines of what the agent is doing: the work order's latest events (oldest first), then where the run stands. Missing events fall back to the run's own totals. */
function streamLines(events: string[], tokens: number, cost: number, progress: number, station: string): string[] {
  const recent = events.slice(0, 2).reverse(); // the feed is newest first
  const fallback = [`${tokens.toLocaleString()} tokens used`, `$${cost.toFixed(2)} spent at this station`];
  const first = recent.length === 2 ? recent : [...fallback.slice(0, 2 - recent.length), ...recent];
  return [...first, `${progress}% through ${station}`];
}

/** "Stop run": parks the work order in the needs-a-person bay (the server's own stop for one work order) after a confirm. Guarded by the move the server allows this person. */
function StopRun({ woId, station }: { woId: string; station: string }) {
  const ui = useUI();
  const cat = useCatalog();
  const t = useTravelerWo(woId).data;
  const bay = cat?.bays.find((b) => b.id === "person" && t?.allowed.moves[b.id]?.allowed) ?? cat?.bays.find((b) => t?.allowed.moves[b.id]?.allowed);
  const park = useCommand(() => ops.park(woId, bay?.id ?? "", `Run stopped at ${station}`, undefined, t ? { ifMatch: t.version } : undefined), {});
  const why = !t ? "Checking what you may do here." : !bay ? (t.allowed.moves.person?.reason || "You may not stop this run.") : null;
  const go = async () => {
    const ok = await ui.confirm({ title: `Stop the run on ${woId}?`, body: "The agent stops after its current tool call. The work order is parked at this station and a person is asked what to do.", ok: "Stop run", kind: "danger" });
    if (ok) void park.run().then((r) => { if (r?.ok) ui.toast(`Run stopped on ${woId}`, "warn"); });
  };
  return <Btn small kind="danger" label="Stop run" id={`ws-stop-${woId}`} disabledReason={why} onClick={() => void go()} />;
}
