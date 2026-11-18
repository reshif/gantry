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

/** The prototype calls the last station "Release"; the catalogue's station is "Close" (tag, release notes, close the issue). */
export const protoStation = (s: { id: string; name: string }): string => (s.id === "close" ? "Release" : s.name);

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
              <i>{done ? "✓" : i + 1}</i>{protoStation(s)}
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

/** The prototype's date and time ("15 Jan 06:50"), in the viewer's own time zone. */
export function when(t: number): string {
  const d = new Date(t);
  return `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** The prototype's "30m ago", "5h ago", "3d ago". */
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  return h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
}

export type AttemptRow = { n: number; station: string; tone: string; outcome: string; dur: number; tokens: number; model: string };
/**
 * One row per attempt, not per station visit: the first pass through the route is attempt 1, and a station the work came back to
 * (sent back, retried) starts the next attempt. An attempt that a later one replaced is "Reworked"; the open one is "Running".
 */
export function attemptsOf(wo: TWo, cat: Catalog): AttemptRow[] {
  const seen = new Map<string, number>();
  const groups = new Map<number, TWo["history"]>();
  for (const h of wo.history) {
    const v = (seen.get(h.station) ?? 0) + 1;
    seen.set(h.station, v);
    groups.set(v, [...(groups.get(v) ?? []), h]);
  }
  const last = Math.max(0, ...groups.keys());
  return [...groups].map(([n, hs]) => {
    const tail = hs[hs.length - 1]!;
    const open = n === last && !tail.endedAt && wo.state !== "done";
    const rework = n < last;
    return {
      n,
      station: cat.stations.find((s) => s.id === tail.station)?.name ?? tail.station,
      tone: open ? "info" : rework ? "warn" : "ok",
      outcome: open ? "Running" : rework ? "Reworked" : "Passed",
      dur: hs.reduce((t, h) => t + Math.max(0, (h.endedAt ?? h.startedAt) - h.startedAt), 0),
      tokens: hs.reduce((t, h) => t + h.tokens, 0),
      model: tail.model,
    };
  });
}
