/** The thin status bar (prototype): live link, belt count, gates waiting, throughput, workers, and a ticking UTC clock on the right. */
import { useEffect, useMemo, useState } from "react";
import { useActivity, useHome } from "../api/queries";
import type { HomeFull } from "../views/home/data";
import { eventRows } from "../lib/eventText";
import { useConnection } from "../lib/connection/store";

const LIVE = { live: "LIVE", reconnecting: "RECONNECTING", offline: "OFFLINE" } as const;
const TONE = { live: "ok pulse", reconnecting: "warn", offline: "bad" } as const;
const HOUR = 3_600_000;

/** HH:MM:SS UTC, ticking each second. */
export function UtcClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span style={{ marginLeft: "auto" }} id="clock">{`${new Date(now).toISOString().slice(11, 19)} UTC`}</span>;
}

/** Station entries per hour, the mean of the last six hours (the Home throughput chart's buckets). null until the feed has loaded. */
export function useThroughput(): number | null {
  const activity = useActivity();
  const events = useMemo(() => eventRows(activity.data), [activity.data]);
  if (!activity.data) return null;
  const now = Date.now();
  const n = events.filter((e) => e.type === "wo.enter" && now - e.at >= 0 && now - e.at < 6 * HOUR).length;
  return n / 6;
}

export function StatusBar() {
  const { state } = useConnection();
  const home = useHome().data as HomeFull | undefined;
  const throughput = useThroughput();
  const motion = home?.sections?.motion;
  const gates = home ? new Set(home.approvals.filter((a) => !a.repo).map((a) => a.wo ?? a.gate)).size : null;
  return (
    <footer className="sbar" id="statusbar" role="contentinfo">
      <span className="live" id="conn-indicator" title={state === "live" ? "Live updates are on." : "Live updates are not connected."}><span className={`lamp ${TONE[state]}`} /><b>{LIVE[state]}</b></span>
      {motion ? <span>BELT <b>{motion.inFlight}</b> WOs</span> : null}
      {gates !== null ? <span>GATES WAITING <b>{gates}</b></span> : null}
      {throughput !== null ? <span className="hide-m" id="sb-throughput">THROUGHPUT <b>{throughput.toFixed(1)}</b>/h</span> : null}
      {/* The API reports one worker service, not a pool size: no honest a/b figure to show (backend gap). */}
      <span className="hide-m" id="sb-workers" title="The API does not report how many workers are running.">WORKERS <b>n/a</b></span>
      <UtcClock />
    </footer>
  );
}
