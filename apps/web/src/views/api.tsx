/**
 * API & triggers (spec 8.8, 8.10, 11.7, 12.5), in the Blueprint prototype's layout: stat strip and six tabs held in the URL (Keys, Triggers, Reference, Playground,
 * Request log, Limits). Keys are service accounts shown once and always expiring; triggers are a flush table whose rows open an editor drawer (with
 * "Simulate incoming" and the run history); the reference carries a "Try it" section that really submits with a pasted key.
 * Not offered, on purpose: "The API here runs on local sample logic" (it is the real API); the conversation endpoint (not in the public API); and the
 * Ed25519 and HMAC-SHA512 signing choices (the delivery implements HMAC-SHA256 only).
 */
import { Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
import { KeysTab } from "./api/Keys";
import { LimitsTab } from "./api/Limits";
import { LogTab } from "./api/Log";
import { PlayTab } from "./api/Playground";
import { RefTab } from "./api/Reference";
import { TriggersTab } from "./api/Triggers";
import { useApiData } from "./api/kit";
import { Async, qState } from "../ui/async";
import { useTab } from "./connect/kit";
import "../styles/views/api.css";

export default function ApiView() {
  const d = useApiData();
  const [tab, setTab] = useTab(["keys", "triggers", "reference", "playground", "log", "limits"]);
  if (!d.me) return null;
  const active = d.keys.filter((k) => !k.revoked && !k.expired);
  const on = d.triggers.filter((t) => t.enabled);
  const errors = d.log.filter((x) => x.status >= 400).length;
  const tabs = [
    { id: "keys", label: "Keys", count: active.length }, { id: "triggers", label: "Triggers", count: d.triggers.length }, { id: "reference", label: "Reference" }, { id: "playground", label: "Playground" },
    { id: "log", label: "Request log", count: d.last24h }, { id: "limits", label: "Limits" },
  ];
  return (
    <div className="view cx api-view">
      <ViewHead title="API & triggers" kicker="All lines" sub="Programmatic ways to put work on the line." />
      <StatRow id="api-stats">
        <Stat label="Active keys" value={qState(d.keysQ, () => String(active.length))} sub={`of ${d.keys.length}`} />
        <Stat label="Triggers on" value={qState(d.trigQ, () => String(on.length))} sub={`of ${d.triggers.length}`} tone="done" />
        <Stat label="Requests, 24 h" value={qState(d.logQ, () => String(d.last24h))} sub={`${errors} errors`} tone={errors ? "wait" : undefined} />
        <Stat label="Rate limit" value={d.cfg ? `${d.cfg.rateLimit}/min` : "n/a"} />
      </StatRow>
      <Tabs idPrefix="api-tab" items={tabs} active={tab} onChange={setTab} />
      <div id="api-tab-panel" role="tabpanel" aria-labelledby={`api-tab-${tab}`}>
        {tab === "reference" ? <RefTab d={d} /> : tab === "playground" ? <PlayTab d={d} /> : tab === "log" ? (
          <Async query={d.logQ} what="the request log" id="api-log">{() => <LogTab d={d} />}</Async>
        ) : tab === "triggers" ? (
          <Async query={d.trigQ} what="triggers" id="api-trig">{() => <TriggersTab d={d} />}</Async>
        ) : tab === "limits" ? (
          <Async query={d.cfgQ} what="the API limits" id="api-limits">{() => <LimitsTab d={d} />}</Async>
        ) : (
          <Async query={d.keysQ} what="API keys" id="api-keys">{() => <KeysTab d={d} onCreated={() => undefined} />}</Async>
        )}
      </div>
    </div>
  );
}
