import "./connection.css";
import { PAUSED_HINT, connection, useConnection } from "./store";
import { Btn } from "../../ui/primitives";

const TEXT = { live: "Live", reconnecting: "Reconnecting", paused: "Paused", offline: "Offline" } as const;
const HINT = {
  live: "Live updates are on.",
  reconnecting: "Live updates dropped. Reconnecting; screens refresh on a timer meanwhile.",
  paused: PAUSED_HINT,
  offline: "No network. Showing the last information we had.",
} as const;

/** Live / reconnecting / offline, in the top bar's status cluster. Announces changes politely; the label hides on narrow screens, the dot stays. */
export function ConnectionIndicator() {
  const { state } = useConnection();
  return (
    <span className={`conn conn-${state}`} id="conn-indicator" role="status" title={HINT[state]}>
      <span className="conn-dot" aria-hidden="true" />
      <span className="conn-label">{TEXT[state]}</span>
      <span className="conn-sr">{HINT[state]}</span>
      {state === "paused" ? <Btn small kind="ghost" onClick={() => connection.reconnect()}>Reconnect</Btn> : null}
    </span>
  );
}
