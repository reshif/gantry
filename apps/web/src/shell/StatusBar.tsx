/** The thin status bar at the bottom of the app (Control Room): live link, belt count, gates waiting, then the factory status cluster (clock, freezes). */
import { useHome } from "../api/queries";
import type { HomeFull } from "../views/home/data";
import { useConnection } from "../lib/connection/store";
import { StatusCluster } from "./StatusCluster";

const LIVE = { live: "LIVE", reconnecting: "RECONNECTING", offline: "OFFLINE" } as const;
const TONE = { live: "ok pulse", reconnecting: "warn", offline: "bad" } as const;

export function StatusBar() {
  const { state } = useConnection();
  const home = useHome().data as HomeFull | undefined;
  const motion = home?.sections?.motion;
  const gates = home ? home.approvals.filter((a) => !a.repo).length : null;
  return (
    <footer className="sbar" id="statusbar" role="contentinfo">
      <span className="live" id="conn-indicator" title={state === "live" ? "Live updates are on." : "Live updates are not connected."}><span className={`lamp ${TONE[state]}`} /><b>{LIVE[state]}</b></span>
      {motion ? <span>BELT <b>{motion.inFlight}</b> WOs</span> : null}
      {gates !== null ? <span>GATES WAITING <b>{gates}</b></span> : null}
      {motion ? <span className="hide-m">SHIPPED TODAY <b>{motion.shippedToday}</b></span> : null}
      <span style={{ marginLeft: "auto" }}><StatusCluster /></span>
    </footer>
  );
}
