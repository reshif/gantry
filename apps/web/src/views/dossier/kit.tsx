/** Small pieces the work order screens share: the prototype's numbered station strip, the "Not found" page and the tab-in-the-address helper. */
import type { ReactNode } from "react";
import type { Catalog, Project } from "@gantry/domain";
import { Btn, Empty } from "../../ui/primitives";
import { Page } from "../../ui/cr";
import { Loading } from "../../ui/async";
import { navigate } from "../../lib/router";
import type { TWo } from "../traveler/model";

/** "WO-1/journey" splits into the work order id and the sub-page (tab or file) after it. */
export function splitParam(param: string | null | undefined): { id: string; sub: string } {
  const [id = "", sub = ""] = (param || "").split("/");
  return { id: id.toUpperCase(), sub };
}

/** The prototype's strip: a numbered dot per station joined by plain lines; done stations are green, the current one is ringed (amber at a gate, red when blocked), stations the class skips are dimmed. */
export function ProtoPipe({ wo, cat, project }: { wo: TWo; cat: Catalog; project: Project | null }) {
  const order = project?.flow?.order?.length ? project.flow.order : cat.stations.filter((s) => !s.custom).map((s) => s.id);
  const stations = order.map((id) => cat.stations.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s);
  const cur = wo.station;
  const tone = wo.state === "waiting" ? "warn" : wo.state === "blocked" || wo.state === "failed" || wo.state === "killed" ? "bad" : "";
  return (
    <div className="pipe" role="list" aria-label={`Route of ${wo.id}`}>
      {stations.map((s, i) => {
        const idx = cat.stations.findIndex((x) => x.id === s.id);
        const done = wo.state === "done" || idx < cur;
        const isCur = idx === cur && wo.state !== "done";
        const skipped = !wo.route.includes(s.id) && !wo.history.some((h) => h.station === s.id);
        const gate = cat.gates.find((g) => g.after === s.id);
        const waiting = gate && wo.gates[gate.id]?.status === "waiting";
        return (
          <span key={s.id} style={{ display: "contents" }}>
            {i ? <span className={`ln ${done ? "done" : ""}`} aria-hidden="true" /> : null}
            <span role="listitem" className={`st ${done ? "done" : ""}${isCur ? ` cur ${tone}` : ""}`} {...(skipped ? { style: { opacity: 0.45 } } : {})} {...(waiting && gate ? { title: `${gate.label} waiting` } : {})}>
              <i>{done ? "✓" : i + 1}</i>{s.name}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** A work order the viewer cannot open: the prototype's "Not found" page with the way back (shown for 403 and 404). */
export function NotFound({ id }: { id: string }) {
  return (
    <Page eyebrow="Work order" title="Not found">
      <div className="card">
        <Empty icon="search" title={`No work order ${id}`} text="It may have been removed, or you may not have access to its project." action={<Btn label="Back to work orders" kind="primary" id="wo-notfound-back" onClick={() => navigate("work-orders")} />} />
      </div>
    </Page>
  );
}

export function LoadingPage({ what }: { what: string }): ReactNode {
  return <div className="page"><Loading id="wo-loading" label={what} /></div>;
}

export const statusOf = (e: unknown): number | undefined => (e as { status?: number } | null)?.status;
