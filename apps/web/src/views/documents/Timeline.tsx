/**
 * The run timeline (agent workspace, Phase 2): what each station run did, in order, with its model calls and cost as Gantry metered them.
 * Tool calls show only their name and a short target (the edge extracts them; no transcript text reaches the browser).
 */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { Empty } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { useWoTimeline, type RunTimeline, type TimelineEntry } from "./api";

const station = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const TOOL: Record<string, string> = { Read: "Read", Grep: "Searched", Glob: "Listed", Bash: "Ran", Edit: "Edited", Write: "Wrote", "gantry:write_document": "Wrote document", "gantry:ask": "Asked", "gantry:assume": "Assumed", "gantry:web_fetch": "Read page", "gantry:propose_research_plan": "Proposed a plan" };
const time = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
/** Claude Code loads deferred tool definitions with ToolSearch: say so in words, without the raw tool ids. */
const pretty = (tool: string, detail: string): [string, string] =>
  tool === "ToolSearch" ? ["Loaded tools", detail.replace(/^select:/, "").replace(/mcp__gantry__/g, "").replace(/,/g, ", ")] : [TOOL[tool] ?? tool, detail.replace(/mcp__gantry__/g, "gantry:")];

function Line({ e }: { e: TimelineEntry }) {
  const body =
    e.kind === "step" ? (() => { const [what, detail] = pretty(e.tool, e.detail); return <><span className="tl-what">{what}</span>{detail ? <span className="mono tl-detail" title={detail}>{detail}</span> : null}</>; })()
    : e.kind === "source" ? <><span className="tl-what">Source</span><span className="md-cite is-static">{e.ref}</span><span className="tl-detail">{e.title || e.url}</span></>
    : e.kind === "document" ? <><span className="tl-what">Document</span><span className="mono tl-detail">{`${e.name} v${e.version}`}</span></>
    : e.kind === "result" ? <><span className={`tl-what tl-out is-${e.outcome}`}>{e.outcome === "succeeded" ? "Finished" : e.outcome === "needs_person" ? "Waiting for a person" : e.outcome === "failed" ? "Failed" : e.outcome}</span>{e.text ? <span className="tl-detail">{e.text}</span> : null}</>
    : <span className="tl-what">{e.text}</span>;
  return <li className={`tl-line is-${e.kind}`}><span className="tl-t muted mono">{time(e.at)}</span><span className="tl-body">{body}</span></li>;
}

function Run({ r, compact }: { r: RunTimeline; compact?: boolean }) {
  const live = r.state === "running" || r.state === "starting";
  const all = Array.isArray(r.entries) ? r.entries : [];
  const entries = compact ? all.slice(-6) : all;
  return (
    <section className={`tl-run${live ? " is-live" : ""}`} aria-label={`${station(r.station)} run`}>
      <header className="tl-run-h">
        <strong>{station(r.station)}</strong>
        <span className={`tl-state is-${r.state}`}>{live ? `Working${r.turn ? ` · turn ${r.turn}` : ""}` : r.state}</span>
        <span className="small muted tl-meter">{`${r.calls} model call${r.calls === 1 ? "" : "s"} · ${fmt.num(r.tokens)} tokens · ${fmt.money(r.costUsd)}`}</span>
      </header>
      {compact && all.length > entries.length ? <p className="small muted tl-more">{`${all.length - entries.length} earlier steps`}</p> : null}
      <ol className="tl-list">{entries.map((e, i) => <Line key={i} e={e} />)}</ol>
    </section>
  );
}

/** All recent runs of the work order, newest first. */
export function RunTimelineView({ woId }: { woId: string }) {
  const q = useWoTimeline(woId);
  const [all, setAll] = useState(false);
  if (!q.data) return <Async query={q} what="the run timeline" id="tl">{() => null}</Async>;
  const runs = Array.isArray(q.data.runs) ? q.data.runs.filter((r) => !!r && typeof r === "object") : null;
  if (!runs) return <Empty icon="warn" title="The run timeline could not be shown" text="The server sent a timeline in a shape this page does not understand. Nothing was changed. Reload to try again." />;
  if (!runs.length) return <Empty icon="clock" title="No runs yet" text="Each station's run shows here as it works: the files it reads, the pages it fetches, what it writes and what it costs." />;
  const shown = all ? runs : runs.slice(0, 3);
  return (
    <div className="tl" id="tl">
      {shown.map((r, i) => <Run key={r.runId ?? i} r={r} />)}
      {runs.length > shown.length ? <button type="button" className="linkish small" onClick={() => setAll(true)}>{`Show ${runs.length - shown.length} older runs`}</button> : null}
    </div>
  );
}

/** The live run in a side panel: the last few steps of the run that is working now, if any. */
export function LiveRun({ woId, onOpen }: { woId: string; onOpen: () => void }) {
  const raw = useWoTimeline(woId).data?.runs;
  const runs = Array.isArray(raw) ? raw : [];
  const r = runs.find((x) => x.state === "running" || x.state === "starting");
  if (!r) return null;
  return (
    <section className="wos-side-sec" id="wos-live">
      <h3 className="sub-h">Working now</h3>
      <Run r={r} compact />
      <button type="button" className="linkish small" onClick={onOpen}>Open the full timeline</button>
    </section>
  );
}
