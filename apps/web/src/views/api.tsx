/**
 * API & triggers (spec 8.8, 8.10, 11.7, 12.5). Port of legacy/js/views/api.js against /api-keys, /api-config, /api-requests and /triggers:
 * API keys (service accounts, shown once, expiring), the endpoint reference, a playground that really submits with a pasted key, the request log, limits,
 * and triggers with "Simulate incoming" and their run history. Not ported, on purpose: "The API here runs on local sample logic" (it is the real API);
 * the conversation endpoint (not in the public API), and the Ed25519 and HMAC-SHA512 signing choices (the delivery implements HMAC-SHA256 only).
 */
import { useState } from "react";
import { Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
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
    { id: "keys", label: "Keys", count: active.length }, { id: "triggers", label: "Triggers", count: d.triggers.length }, { id: "ref", label: "Reference" },
    { id: "log", label: "Request log", count: d.last24h }, { id: "limits", label: "Limits" }, { id: "play", label: "Playground" },
  ];
  return (
    <div className="view cx api-view">
      <ViewHead
        title="API & triggers"
        sub="Programmatic ways to put work on the line."
      />
      <StatRow id="api-stats">
        <Stat label="Active keys" value={qState(d.keysQ, () => String(active.length))} sub={`of ${d.keys.length}`} />
        <Stat label="Triggers on" value={qState(d.trigQ, () => String(on.length))} sub={`of ${d.triggers.length}`} tone="done" />
        <Stat label="Requests, 24 h" value={qState(d.logQ, () => String(d.last24h))} sub={`${d.log.filter((x) => x.status >= 400).length} errors`} tone={d.log.some((x) => x.status >= 400) ? "wait" : undefined} />
        <Stat label="Rate limit" value={d.cfg ? `${d.cfg.rateLimit}/min` : "n/a"} />
      </StatRow>
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
