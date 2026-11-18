/**
 * API and triggers (spec 8.8, 8.10, 11.7, 12.5), the Control Room screen: head with Create key or New trigger for the open tab, tabs API keys,
 * Triggers and Quick start (`?tab=`), search, sortable tables with paging in the URL, and a trigger drawer (`?open=`). Quick start shows the
 * curl for submitting a work order, then the endpoint reference, playground, request log and limits as sections.
 */
import { useEffect, useState } from "react";
import { Btn, Tabs } from "../ui/primitives";
import { Async } from "../ui/async";
import { Card, Page } from "../ui/cr";
import { useUI } from "../ui/overlay-context";
import { CreateKey, KeysTab } from "./api/Keys";
import { LimitsTab } from "./api/Limits";
import { LogTab } from "./api/Log";
import { PlayTab } from "./api/Playground";
import { ENDPOINTS, RefTab, curl } from "./api/Reference";
import { NewTrigger, TriggerDrawer, TriggersTab } from "./api/Triggers";
import { CodeBlock, useApiData, useCanAny } from "./api/kit";
import { ClearOnClose, oneOf, useUrlState } from "./connect/kit";

const TABS = ["keys", "triggers", "docs"] as const;

export default function ApiView() {
  const ui = useUI();
  const d = useApiData();
  const url = useUrlState({ tab: "keys", q: "", sort: "", dir: "", page: "0", open: "" });
  const tab = oneOf(url.v.tab, TABS, "keys");
  const keyGuard = useCanAny("api.keys", d.vis);
  const trGuard = useCanAny("triggers.edit", d.vis);

  const openTrigger = (id: string): void => {
    url.set({ open: id });
    ui.drawer.open(`api-tr:${id}`, (close) => <ClearOnClose param="open" id={id}><TriggerDrawer id={id} close={close} /></ClearOnClose>);
  };
  const [opened, setOpened] = useState("");
  useEffect(() => {
    if (url.v.open && url.v.open !== opened && d.triggers.some((t) => t.id === url.v.open)) {
      setOpened(url.v.open);
      if (!ui.drawer.isOpen(`api-tr:${url.v.open}`)) openTrigger(url.v.open);
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d.me) return null;

  const active = d.keys.filter((k) => !k.revoked && !k.expired);
  const acts = tab === "keys"
    ? <Btn label="Create key" kind="primary" icon="plus" id="api-key-new" guard={keyGuard} onClick={() => ui.open((c) => <CreateKey d={d} close={c} onCreated={() => undefined} />)} />
    : tab === "triggers"
      ? <Btn label="New trigger" kind="primary" icon="plus" id="api-tr-new" guard={trGuard} onClick={() => ui.open((c) => <NewTrigger d={d} close={c} onCreated={openTrigger} />)} />
      : undefined;
  const urlList = { v: url.v, set: url.set, clear: () => url.clear("tab", "open") };

  return (
    <Page eyebrow="Connect" title="API and triggers" sub="How outside systems create work: scoped API keys and event triggers." cls="api-view" acts={acts}>
      <Tabs idPrefix="api-tab" items={[{ id: "keys", label: "API keys", count: active.length }, { id: "triggers", label: "Triggers", count: d.triggers.length }, { id: "docs", label: "Quick start" }]} active={tab} onChange={(t) => url.set({ tab: t, q: "", sort: "", dir: "", open: "" })} />
      <div id="api-tab-panel" role="tabpanel" aria-labelledby={`api-tab-${tab}`}>
        {tab === "triggers" ? (
          <Async query={d.trigQ} what="triggers" id="api-trig">{() => <TriggersTab d={d} url={urlList} openTrigger={openTrigger} />}</Async>
        ) : tab === "docs" ? (
          <>
            <Card title="Submit a work order from code">
              <CodeBlock id="api-quickstart-copy" label="curl" text={curl(ENDPOINTS[0]!)} />
              <p className="muted" style={{ marginTop: 12 }}>Keys are scoped to one project and a list of actions. The secret is shown once when created.</p>
            </Card>
            <details className="int-more" id="api-more-ref"><summary>Endpoints</summary><RefTab d={d} /></details>
            <details className="int-more" id="api-more-play"><summary>Playground</summary><PlayTab d={d} /></details>
            <details className="int-more" id="api-more-log"><summary>Request log</summary><Async query={d.logQ} what="the request log" id="api-log">{() => <LogTab d={d} />}</Async></details>
            <details className="int-more" id="api-more-limits"><summary>Limits</summary><Async query={d.cfgQ} what="the API limits" id="api-limits">{() => <LimitsTab d={d} />}</Async></details>
          </>
        ) : (
          <Async query={d.keysQ} what="API keys" id="api-keys">{() => <KeysTab d={d} url={urlList} />}</Async>
        )}
      </div>
    </Page>
  );
}
