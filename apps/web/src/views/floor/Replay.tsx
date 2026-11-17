/** Replay of the floor: scrubber with event marks over the project's event log (legacy floor.js replayBar). The floor itself is rebuilt by the server for the chosen time. */
import { useEffect, useRef, useState } from "react";
import { MIN, fmt, type EventEntry } from "@gantry/domain";
import { useProjectEvents } from "../../api/queries";
import { Btn, Segmented, Select } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { setReplay, usePrefs } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { EV_LABEL, MARK_TYPES, markCls, replayRange, useFloorCtx, type ReplayCtx } from "./kit";

/** The replay the person chose, kept in their preferences so Floor and the Work orders board share it; null while live. */
export function useReplayBase(projectId: string | null): Omit<ReplayCtx, "state"> | null {
  const r = usePrefs().replay;
  if (!r || !projectId) return null;
  const span: "24h" | "7d" = r.span === "7d" ? "7d" : "24h";
  const rg = replayRange(span);
  const from = typeof r.from === "number" ? r.from : rg.from;
  const to = typeof r.to === "number" ? r.to : rg.to;
  const at = Math.max(from, Math.min(to, typeof r.at === "number" ? r.at : to));
  return { at: Math.round(at / MIN) * MIN, span, from, to, speed: typeof r.speed === "number" ? r.speed : 1 };
}

/** Play, enter and exit for a replay: each play step advances the replay clock, and each step is one read at that time. */
export function useReplayPlayer(projectId: string, rp: ReplayCtx | null, focusOnExit: string): { playing: boolean; setPlaying: (v: boolean) => void; enter: () => void; exit: () => void } {
  const [playing, setPlaying] = useState(false);
  const hasReplay = !!rp;
  const rpRef = useRef(rp);
  rpRef.current = rp;
  useEffect(() => {
    if (!playing || !hasReplay) return;
    const t = setInterval(() => {
      const c = rpRef.current;
      if (!c) return;
      const base = c.span === "7d" ? 60 * MIN : 10 * MIN;
      let next = c.at + base * c.speed * 0.5;
      if (next >= c.to) {
        setPlaying(false);
        next = c.to;
      }
      setReplay({ at: next });
    }, 500);
    return () => clearInterval(t);
  }, [playing, hasReplay]);
  useEffect(() => {
    if (!rp) setPlaying(false);
  }, [rp]);
  useEffect(() => {
    if (playing && rp && rp.at >= rp.to - MIN) setReplay({ at: rp.from });
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps
  const enter = () => {
    const rg = replayRange("24h");
    setReplay({ at: rg.to - 6 * 3_600_000, span: "24h", project: projectId, speed: 1, from: rg.from, to: rg.to });
  };
  const exit = () => {
    setPlaying(false);
    setReplay(null);
    setTimeout(() => document.getElementById(focusOnExit)?.focus(), 60);
  };
  return { playing, setPlaying, enter, exit };
}

export const SPEEDS: Record<"24h" | "7d", Array<[number, string]>> = {
  "24h": [[1, "10 min/s"], [4, "40 min/s"], [12, "2 h/s"]],
  "7d": [[1, "1 h/s"], [4, "4 h/s"], [12, "12 h/s"]],
};

/** Events of the project in the replay window, oldest first. */
export function useReplayEvents(projectId: string, ctx: ReplayCtx | null): EventEntry[] {
  const q = useProjectEvents(ctx ? projectId : null, { from: ctx ? Math.floor(ctx.from / MIN) * MIN : 0, to: ctx ? Math.ceil(ctx.to / MIN) * MIN : 0 });
  const d = q.data as EventEntry[] | { items: EventEntry[] } | undefined;
  return Array.isArray(d) ? d : (d?.items ?? []);
}

function useEvText() {
  const ctx = useFloorCtx();
  const actor = useActors();
  return (e: EventEntry): string => {
    const gd = e.gate ? ctx.cat.gates.find((g) => g.id === e.gate) : undefined;
    const st = e.station ? ctx.cat.stations.find((s) => s.id === e.station) : undefined;
    const who = e.by ? actor(e.by).name : "a person";
    const repo = e.repo ? (ctx.repos.find((r) => r.id === e.repo)?.name ?? e.repo) : "";
    switch (e.type) {
      case "gate.decision": return `${gd ? gd.label : e.gate} decided by ${who}${e.trust != null ? ` (cell at L${e.trust})` : ""}`;
      case "trust.auto": return `${gd ? gd.label : e.gate} passed under trust at L${e.trust}`;
      case "halt": return `${e.scope === "repo" ? repo : "Project"} halted by ${actor(e.by).name}${e.text ? `: ${e.text}` : ""}`;
      case "resume": return `${e.scope === "repo" ? repo : "Project"} resumed by ${actor(e.by).name}`;
      case "kill": return `${e.scope === "factory" ? "Factory" : e.scope === "workorder" ? "Work order" : "Project"} killed by ${actor(e.by).name}${e.text ? `: ${e.text}` : ""}`;
      case "restore": return `${e.scope === "factory" ? "Factory" : e.scope === "workorder" ? "Work order" : "Project"} restored by ${actor(e.by).name}${e.text ? `: ${e.text}` : ""}`;
      case "release": return `Released ${e.text ?? ""}`;
      case "wo.submit": return `Submitted${e.text ? `: ${e.text}` : ""}`;
      case "wo.enter": return `Entered ${st ? `${st.no} ${st.name}` : e.station}`;
      case "wo.bay": return `Moved to ${ctx.cat.bays.find((b) => b.id === e.bay)?.name ?? e.bay}${e.text ? `: ${e.text}` : ""}`;
      case "trust.change": return `Trust L${e.from} to L${e.to}${e.text ? `: ${e.text}` : ""}`;
      default: return e.text ?? e.type;
    }
  };
}

const LEGEND: Array<[string, string]> = [["mk-gate", "gate decision by a person"], ["mk-trust", "passed under trust"], ["mk-halt", "halt"], ["mk-resume", "resume"], ["mk-kill", "kill"], ["mk-restore", "restore"], ["mk-release", "release"]];

export function ReplayBar({ rp, playing, setPlaying, onExit }: { rp: ReplayCtx; playing: boolean; setPlaying: (v: boolean) => void; onExit: () => void }) {
  const ctx = useFloorCtx();
  const events = useReplayEvents(ctx.project.id, rp);
  const evText = useEvText();
  const openTraveler = useOpenTraveler();
  const dragging = useRef(false);
  const [live, setLive] = useState<number | null>(null);
  const shown = live ?? rp.at;
  const span = rp.to - rp.from;
  const marks = events.filter((e) => MARK_TYPES.includes(e.type) && e.at >= rp.from && e.at <= rp.to);
  const before = marks.filter((e) => e.at < rp.at - 1000);
  const after = marks.filter((e) => e.at > rp.at + 1000);
  const prevE = before[before.length - 1];
  const nextE = after[0];
  const counts: Record<string, number> = {};
  for (const e of marks) counts[markCls(e)] = (counts[markCls(e)] ?? 0) + 1;
  const recent = events.filter((e) => e.at <= rp.at && e.at >= rp.from && e.type !== "wo.enter").slice(-5).reverse();
  const jump = (at: number) => {
    setPlaying(false);
    setReplay({ at });
  };
  return (
    <section className="fl-replay" id="floor-replay" aria-label="Replay controls">
      <div className="fl-rp-head">
        <div className="fl-rp-stamp" role="status">
          <Icon name="replay" />
          <span>Replay · not live</span>
          <span className="fl-rp-at mono" id="floor-rp-at" aria-live="polite">{fmt.stamp(shown)}</span>
        </div>
        <div className="fl-rp-ctl">
          <Segmented
            name="floor-rp-span"
            label="Replay window"
            items={[{ id: "24h", label: "Last 24h" }, { id: "7d", label: "Last 7 days" }]}
            value={rp.span}
            onChange={(v) => {
              setPlaying(false);
              const s = v === "7d" ? "7d" : "24h";
              const rg = replayRange(s);
              setReplay({ span: s, speed: 1, from: rg.from, to: rg.to, at: Math.max(rg.from, rp.at) });
            }}
          />
          <Btn label="Previous event" small icon="back" id="floor-rp-prev" aria="Jump to the previous event" disabledReason={prevE ? null : "No earlier event in this window."} onClick={() => prevE && jump(prevE.at + 1000)} />
          <Btn label={playing ? "Pause" : "Play"} small kind="primary" icon={playing ? "pause" : "play"} id="floor-rp-play" onClick={() => setPlaying(!playing)} />
          <Btn label="Next event" small icon="chevron" id="floor-rp-next" aria="Jump to the next event" disabledReason={nextE ? null : "No later event in this window."} onClick={() => nextE && jump(nextE.at + 1000)} />
          <label className="fl-rp-speed" htmlFor="floor-rp-speed">
            <span className="small muted">Speed</span>
            <Select id="floor-rp-speed" aria-label="Replay speed" options={SPEEDS[rp.span].map((s) => ({ value: String(s[0]), label: s[1] }))} value={String(rp.speed)} onChange={(v) => setReplay({ speed: Number(v) })} />
          </label>
          <Btn label="Back to live" small icon="st-run" id="floor-rp-live" onClick={onExit} />
        </div>
      </div>
      <div className="fl-rp-track">
        <input
          type="range"
          className="fl-rp-range"
          id="floor-rp-scrub"
          min={Math.floor(rp.from)}
          max={Math.ceil(rp.to)}
          step={MIN}
          value={Math.round(shown)}
          aria-label="Replay time"
          aria-valuetext={fmt.stamp(shown)}
          onPointerDown={() => {
            dragging.current = true;
            setPlaying(false);
          }}
          onChange={(e) => {
            const v = Number(e.target.value);
            setLive(v);
            if (!dragging.current) {
              setReplay({ at: v });
              setLive(null);
            }
          }}
          onPointerUp={(e) => {
            dragging.current = false;
            setReplay({ at: Number((e.target as HTMLInputElement).value) });
            setLive(null);
          }}
          onKeyUp={() => {
            if (live !== null) {
              setReplay({ at: live });
              setLive(null);
            }
          }}
        />
        <div className="fl-rp-marks" aria-hidden="true">
          {marks.map((e) => (
            <span
              key={e.id}
              className={`fl-mk ${markCls(e)}${e.at <= rp.at ? " is-past" : ""}`}
              style={{ left: `${(((e.at - rp.from) / span) * 100).toFixed(2)}%` }}
              data-tip={`${fmt.stamp(e.at)} · ${EV_LABEL[e.type] ?? e.type}${e.wo ? ` · ${e.wo}` : ""} · ${evText(e)}`}
              onClick={() => jump(e.at + 1000)}
            />
          ))}
          <span className="fl-rp-now" style={{ left: `${(((shown - rp.from) / span) * 100).toFixed(2)}%` }} />
        </div>
        <div className="fl-rp-axis mono">
          <span>{fmt.stamp(rp.from)}</span>
          <span>{`${marks.length} events marked`}</span>
          <span>{`now ${fmt.ist(rp.to)}`}</span>
        </div>
      </div>
      <div className="fl-rp-foot">
        <ul className="fl-rp-legend" aria-label="Mark legend">
          {LEGEND.map((l) => (
            <li key={l[0]}>
              <span className={`fl-mk-key ${l[0]}`} aria-hidden="true" />
              {`${l[1]} ${counts[l[0]] ?? 0}`}
            </li>
          ))}
        </ul>
        <div className="fl-rp-recent">
          <div className="fl-rp-recent-h">Up to this moment</div>
          {recent.length ? (
            <ol className="fl-rp-list">
              {recent.map((e) => (
                <li key={e.id}>
                  <span className={`fl-mk-key ${markCls(e)}`} aria-hidden="true" />
                  <span className="mono muted">{fmt.ist(e.at)}</span>
                  {e.wo ? (
                    <button type="button" className="linkish mono" id={`floor-rp-wo-${e.id}`} onClick={() => openTraveler(e.wo as string)}>
                      {e.wo}
                    </button>
                  ) : null}
                  <span>{evText(e)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">No events yet in this window.</p>
          )}
        </div>
      </div>
      <p className="footnote">The floor below is rebuilt from the event log and traveler history at the chosen time. Approvals, moves, halts and kills are locked until you go back to live. Tokens open the live traveler.</p>
    </section>
  );
}
