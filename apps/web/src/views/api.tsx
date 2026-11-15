/**
 * API & triggers (spec 8.8, 8.10, 11.7, 12.5). Port of legacy/js/views/api.js against /api-keys, /api-config, /api-requests and /triggers:
 * API keys (service accounts, shown once, expiring), the endpoint reference, a playground that really submits with a pasted key, the request log, limits,
 * and triggers with "Simulate incoming" and their run history. Not ported, on purpose: "The API here runs on local sample logic" (it is the real API);
 * the conversation endpoint (not in the public API), and the Ed25519 and HMAC-SHA512 signing choices (the delivery implements HMAC-SHA256 only).
 */
import { useState } from "react";
import { Tabs, ViewHead } from "../ui/primitives";
import { KeysTab } from "./api/Keys";
import { LimitsTab } from "./api/Limits";
import { LogTab } from "./api/Log";
import { PlayTab } from "./api/Playground";
import { RefTab } from "./api/Reference";
import { TriggersTab } from "./api/Triggers";
import { useApiData } from "./api/kit";
import { Async, qState } from "../ui/async";

export default function ApiView() {
  const d = useApiData();
  const [tab, setTab] = useState("keys");
  if (!d.me) return null;
  const active = d.keys.filter((k) => !k.revoked && !k.expired);
  const on = d.triggers.filter((t) => t.enabled);
  const tabs = [
    { id: "keys", label: "Keys", count: active.length }, { id: "ref", label: "Endpoints" }, { id: "play", label: "Playground" },
    { id: "log", label: "Request log", count: d.last24h }, { id: "triggers", label: "Triggers", count: d.triggers.length }, { id: "limits", label: "Limits" },
  ];
  return (
    <div className="view cx api-view">
      <ViewHead
        title="API & triggers"
        sub="Submit and follow work orders from other systems, and open work from source control, issue trackers, CI and schedules. Triggers are off until you switch them on."
        meta={[["Active keys", qState(d.keysQ, () => String(active.length))], ["Requests 24h", qState(d.logQ, () => String(d.last24h))], ["Rate limited 24h", qState(d.logQ, () => String(d.limited24h))], ["Triggers on", qState(d.trigQ, () => `${on.length} of ${d.triggers.length}`)]]}
      />
      <Tabs idPrefix="api-tab" items={tabs} active={tab} onChange={setTab} />
      <div id="api-tab-panel" role="tabpanel" aria-labelledby={`api-tab-${tab}`}>
        {tab === "ref" ? <RefTab d={d} /> : tab === "play" ? <PlayTab d={d} /> : tab === "log" ? (
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
