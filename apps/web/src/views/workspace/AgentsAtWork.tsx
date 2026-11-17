/**
 * Agents at work: the Control Room prototype's "workspace" screen. One card per station agent: what it is running right now (the work order,
 * its time at the station, tokens and cost so far), its slot use, and where to talk to it. Read from the floor read of the chosen project
 * (stations, work orders and their open history entry); nothing here is invented. The conversations hub lives at `#workspace/chats`.
 */
import { useMemo, useState } from "react";
import { fmt } from "@gantry/domain";
import { useMe } from "../../api/queries";
import { pickProject } from "../../lib/routes";
import { navigate } from "../../lib/router";
import { usePrefs } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { Async } from "../../ui/async";
import { useActors } from "../../ui/actors";
import { Avatar, Btn, Chip, FilterBar, SearchBox, Select } from "../../ui/primitives";
import { CrEmpty, Page, Stats } from "../../ui/cr";
import { buildBelt, NO_FILTER } from "../floor/conveyor";
import { openEntry, useFloorRead, useFloorState, type FWo } from "../floor/kit";

const short = (m: string) => m.replace(/^claude-/, "");
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export function AgentsAtWork() {
  const me = useMe();
  const prefs = usePrefs();
  const projectId = me ? pickProject(me, prefs.project) : null;
  const floorQ = useFloorRead(projectId);
  const { value: ctx } = useFloorState(projectId, null);
  const actors = useActors();
  const open = useOpenTraveler();
  const [q, setQ] = useState("");
  const [act, setAct] = useState("all");

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
  const busy = cards.filter((c) => c.running.length).length;
  const runs = cards.reduce((n, c) => n + c.running.length, 0);
  const tokens = cards.reduce((n, c) => n + c.running.reduce((m, w) => m + (openEntry(w)?.tokens ?? 0), 0), 0);
  const cost = cards.reduce((n, c) => n + c.running.reduce((m, w) => m + (openEntry(w)?.cost ?? 0), 0), 0);

  return (
    <Page
      eyebrow="Operate" title="Agents at work" cls="ws-agents"
      sub="What each station's agent is doing right now. You can open a conversation or the work order."
      acts={<Btn label="Conversations" icon="chat" id="ws-open-chats" onClick={() => navigate("workspace", "chats")} />}
    >
      <Async query={floorQ} what="the agents on this project" id="ws-agents" isEmpty={() => false}>{() => (
        <>
          <Stats items={[
            { l: "Agents busy", v: `${busy} / ${cards.length}`, tone: "info" },
            { l: "Runs in flight", v: runs, tone: "agent" },
            { l: "Tokens in flight", v: compact(tokens), d: "open runs" },
            { l: "Cost so far", v: `$${cost.toFixed(2)}`, d: "open runs" },
          ]} />
          <FilterBar label="Filter agents" count={`${list.length} of ${cards.length}`}>
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
                        <div style={{ minWidth: 0 }}><h3 className="ell">{s.agent}</h3><div className="hint ell">{s.name}{e?.model ? ` · ${short(e.model)}` : ""}</div></div>
                      </div>
                      <Chip text={running.length ? "Working" : "Idle"} cls={running.length ? "info" : "idle"} />
                    </div>
                    <div className="card-b ws-b">
                      {w ? (
                        <>
                          <div className="row spread nowrap"><a className="mono" id={`ws-wo-${s.id}`} href={`#workspace/wo:${w.id}`} onClick={(e) => { e.preventDefault(); open(w.id); }}>{w.id}</a><span className="mono dim">{fmt.dur(Math.max(0, (ctx?.now ?? Date.now()) - (e?.startedAt ?? w.createdAt)))}</span></div>
                          <div className="ell" title={w.title} style={{ fontWeight: 600 }}>{w.title}</div>
                          <div className="tok-stream">
                            <div>{`✓ ${(e?.tokens ?? 0).toLocaleString()} tokens used`}</div>
                            <div>{`✓ $${(e?.cost ?? 0).toFixed(2)} spent at this station`}</div>
                            <div>{`▸ ${w.progress ?? 0}% through ${s.name}`}<span className="caret">▍</span></div>
                          </div>
                        </>
                      ) : (
                        <div className="ws-idle">
                          <div className="label">Idle</div>
                          <p className="muted">Nothing running at this station.</p>
                          {next ? (<><div className="mono" style={{ fontSize: 12 }}><span className="dim">Next up </span>{next.id}</div><div className="ell dim" style={{ fontSize: 12 }}>{next.title}</div></>) : <div className="dim" style={{ fontSize: 12 }}>Queue is empty.</div>}
                        </div>
                      )}
                      <div className="row spread ws-f">
                        <span className="mono" style={{ fontSize: 12 }}><span className="muted">{Math.min(running.length, s.slots)}/{s.slots} slots</span>{over ? <> · <span style={{ color: "var(--warn)" }}>+{over} over capacity</span></> : null}</span>
                        <span className="row">
                          <Btn small label="Talk" id={`ws-talk-${s.id}`} disabledReason={w ? null : "Nothing is running here to talk about."} onClick={() => w && navigate("workspace", `wo:${w.id}`)} />
                          {w ? <Btn small label="Open" id={`ws-open-${s.id}`} onClick={() => open(w.id)} /> : null}
                        </span>
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="card"><CrEmpty icon="chat" title="No agents match" text="Clear the search or the activity filter." /></div>
          )}
        </>
      )}</Async>
    </Page>
  );
}
