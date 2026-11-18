/**
 * Console (#console), the Control Room prototype's "submit a work order" screen: the New work order form on the left (the same fields,
 * validation, classifier preview and guarded submit as the dialog), the route preview and the latest submissions on the right.
 * The chat with the factory Console lives in Agents at work (`#workspace`, New chat).
 */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { useMe } from "../api/queries";
import { navigate } from "../lib/router";
import { useScope } from "../lib/scope";
import { Btn, Empty } from "../ui/primitives";
import { Async } from "../ui/async";
import { Card, Page } from "../ui/cr";
import { NewWorkOrderDialog, takePendingProject } from "./work-orders/New";
import { useFloorRead } from "./floor/kit";
import { useCatalog } from "./projects/kit";
import { WoStateChip } from "./work-orders/state";

export default function ConsoleSubmitView() {
  const me = useMe();
  const scope = useScope();
  // Under All projects a work order needs a project: ask, never fall back to the last one.
  const [chosen, setChosen] = useState<string | null>(() => takePendingProject());
  const projectId = scope.all ? (scope.projects.some((p) => p.id === chosen) ? chosen : null) : scope.projectId;
  const floor = useFloorRead(projectId);
  const cat = useCatalog();
  const [n, setN] = useState(0);
  if (!me) return null;
  if (scope.all && !projectId) {
    return (
      <Page eyebrow="Operate" title="Console" sub="Submit a work order. Gantry classifies it, routes it and asks only what it needs." cls="console-submit"
        acts={<Btn id="con-chats" icon="chat" label="Chats" onClick={() => navigate("workspace", "chats")} />}>
        <Empty
          id="con-pick-project"
          icon="projects"
          title="Pick a project for this work order"
          text="You are looking at All projects. A work order belongs to one project, so choose which."
          action={<div className="row" style={{ flexWrap: "wrap", gap: 8, justifyContent: "center" }}>{scope.projects.filter((p) => p.status !== "archived").map((p) => <Btn key={p.id} label={p.name} id={`con-pick-${p.id}`} onClick={() => setChosen(p.id)} />)}</div>}
        />
      </Page>
    );
  }
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
    <Page eyebrow="Operate" title="Console" sub="Submit a work order. Gantry classifies it, routes it and asks only what it needs." cls="console-submit"
      acts={<Btn id="con-chats" icon="chat" label="Chats" onClick={() => navigate("workspace", "chats")} />}>
      <NewWorkOrderDialog key={n} variant="page" preset={{ source: "console", ...(projectId ? { project: projectId } : {}) }} onClose={() => setN((x) => x + 1)} aside={aside} />
    </Page>
  );
}
