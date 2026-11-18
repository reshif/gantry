/**
 * Console (#console), the Control Room prototype's "submit a work order" screen: the New work order form on the left (the same fields,
 * validation, classifier preview and guarded submit as the dialog), the route preview and the latest submissions on the right.
 * The chat with the factory Console lives in Agents at work (`#workspace`, New chat).
 */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { useMe } from "../api/queries";
import { pickProject } from "../lib/routes";
import { usePrefs } from "../lib/prefs";
import { Async } from "../ui/async";
import { Card, Page } from "../ui/cr";
import { NewWorkOrderDialog } from "./work-orders/New";
import { useFloorRead } from "./floor/kit";
import { useCatalog } from "./projects/kit";
import { WoStateChip } from "./work-orders/state";

export default function ConsoleSubmitView() {
  const me = useMe();
  const prefs = usePrefs();
  const projectId = me ? pickProject(me, prefs.project) : null;
  const floor = useFloorRead(projectId);
  const cat = useCatalog();
  const [n, setN] = useState(0);
  if (!me) return null;
  const recent = (floor.data?.workOrders ?? []).slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
  const aside = (
    <Card title="Recent submissions" flush id="con-recent">
      <Async query={floor} what="recent submissions" id="con-recent-list" isEmpty={() => false}>{() => (
        <div className="list">
          {recent.map((w) => (
            <div key={w.id} className="li">
              <div className="main1"><span className="t1">{w.title}</span><span className="t2 mono">{`${w.id} · ${fmt.ago(w.createdAt, Date.now())}`}</span></div>
              <WoStateChip w={w} gates={cat?.gates ?? []} />
            </div>
          ))}
        </div>
      )}</Async>
    </Card>
  );
  return (
    <Page eyebrow="Operate" title="Console" sub="Submit a work order. Gantry classifies it, routes it and asks only what it needs." cls="console-submit">
      <NewWorkOrderDialog key={n} variant="page" preset={{ source: "console" }} onClose={() => setN((x) => x + 1)} aside={aside} />
    </Page>
  );
}
