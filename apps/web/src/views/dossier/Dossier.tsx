/**
 * One work order on one page: the header (where it is, what it is doing, what you may do), then two tabs.
 * Document is the written record of the work order, in sections. Activity is the conversation with the station's agent, with its proposals and gates.
 * The side column holds the properties, what waits on you, the brief and the outline. The route is `#record/<WO>` or `#record/<WO>/activity`.
 */
import { useCallback, useEffect, useRef } from "react";
import { navigate } from "../../lib/router";
import { Btn, Empty, Panel, Tabs, ViewHead } from "../../ui/primitives";
import { Loading } from "../../ui/async";
import { reducedMotion } from "../../lib/prefs";
import { WoSessionPage } from "../conversations/Session";
import { useWoSession } from "../conversations/session-api";
import { Meter, Scrubber, Sections, useCopyMarkdown, useExportRecord } from "../record/Lifecycle";
import { useRecordData, type SectionId } from "../record/data";
import { journeyOf, toRecEvent } from "../traveler/model";
import { useHashQuery } from "./hashQuery";
import { useActors } from "../../ui/actors";
import { fmtDate, plainName } from "./time";
import { DossierHead } from "./Head";
import { Props } from "./Props";
import { BriefPanel, CriteriaPanel, GatesPanel, PlanPanel, RunsPanel } from "./Panels";

export type DossierTab = "document" | "activity" | "gates" | "runs";

export function Dossier({ id, tab: pathTab }: { id: string; tab: DossierTab }) {
  // the tab is view state in the URL (?tab=activity); an old #record/WO-x/activity path still opens the same tab
  const [q, setQ] = useHashQuery("tab");
  const tab: DossierTab = q === "activity" || q === "gates" || q === "runs" || q === "document" ? q : pathTab;
  const [full] = useHashQuery("full");
  const copyMd = useCopyMarkdown();
  const exportRec = useExportRecord();
  const actor = useActors();
  const d = useRecordData(id);
  const sess = useWoSession(id);
  const session = sess.data;
  const root = useRef<HTMLDivElement>(null);
  const setTab = useCallback((t: DossierTab) => { setQ(t === "document" ? null : t); }, [setQ]);
  const scroll = (el: HTMLElement | null, focus?: HTMLElement | null) => {
    el?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    focus?.setAttribute("tabindex", "-1");
    focus?.focus({ preventScroll: true });
  };
  // a link to a part of the conversation opens the Activity tab first, then scrolls once it has rendered
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (tab !== "activity" || !pending.current) return;
    const target = pending.current;
    const t = setTimeout(() => { scroll(document.getElementById(target), document.getElementById(target)); pending.current = null; }, 120);
    return () => clearTimeout(t);
  }, [tab, session]);
  // a link to a section of the document opens the Document tab first, then scrolls once it has rendered
  const pendingSection = useRef<SectionId | null>(null);
  const scrollToSection = useCallback(() => {
    const s = pendingSection.current;
    if (!s) return;
    const el = document.getElementById(`rec-sec-${s}`);
    if (!el) return;
    pendingSection.current = null;
    const det = el.querySelector("details");
    if (det) det.open = true;
    scroll(el, el.querySelector<HTMLElement>(".rec-sec-title"));
  }, []);
  useEffect(() => {
    if (tab !== "document" || !pendingSection.current) return;
    const t = setTimeout(scrollToSection, 120);
    return () => clearTimeout(t);
  }, [tab, d.loading, scrollToSection]);
  const toActivity = (target?: string) => {
    pending.current = target ?? "wos-input";
    if (tab !== "activity") setTab("activity");
    else { scroll(document.getElementById(pending.current), document.getElementById(pending.current)); pending.current = null; }
  };

  if (d.loading) return <div className="view rec-view"><Loading id="rec-loading" label="the record" /></div>;
  const status = (d.error as { status?: number } | null)?.status;
  if (d.error || !d.wo || !d.rec || !d.project || !d.cat) {
    const missing = status === 403 || status === 404 || (!d.error && !d.wo);
    return (
      <div className="view rec-view" id="dz-missing">
        <ViewHead plain title={missing ? "Work order not found" : "Work order could not be loaded"} />
        <Panel>
          <Empty
            title={missing ? `${id} does not exist` : `Could not load ${id}`}
            text={status === 403 ? "It belongs to a project outside your access." : missing ? "Pick one from the register." : "The server did not answer. Try again in a moment."}
            action={<Btn label="Work orders" id="dz-missing-wos" onClick={() => navigate("work-orders")} />}
          />
        </Panel>
      </div>
    );
  }
  const { wo, rec, project, cat } = d;
  const c = { wo, rec, project, cat, pre: "rec-", compact: false, doc: true };
  const jump = (s: SectionId) => {
    pendingSection.current = s;
    if (tab !== "document") setTab("document");
    else scrollToSection();
  };
  const events = journeyOf(rec.events.map(toRecEvent));
  const tone = (t: string) => (/Approved|Released/.test(t) ? "ok" : /Reject|Killed|fail/i.test(t) ? "bad" : "");
  const timeline = (wo.log ?? []).slice().reverse();
  return (
    <div className="view rec-view dz" id="dz" ref={root}>
      <DossierHead wo={wo} cat={cat} project={project} session={session} onActivity={() => toActivity()} />
      <Tabs idPrefix="dz-tab" items={[{ id: "document", label: "Document" }, { id: "activity", label: "Activity", count: wo.log?.length ?? 0 }, { id: "gates", label: "Gates", count: Object.keys(wo.gates ?? {}).length }, { id: "runs", label: "Runs", count: wo.history.length }]} active={tab} onChange={(t) => setTab(t as DossierTab)} />
      <div className="dz-pane" role="tabpanel" aria-labelledby={`dz-tab-${tab}`}>
        {tab === "document" ? (
          <>
            <div className="cols w21">
              <div className="stack">
                <BriefPanel wo={wo} />
                <CriteriaPanel wo={wo} />
                <PlanPanel wo={wo} />
              </div>
              <Props wo={wo} cat={cat} project={project} />
            </div>
            {full === "1" ? <details className="dz-replay" id="dz-docs" open>
              <summary>Station documents and full history</summary>
              <div className="dz-exp">
                <Btn label="Copy as Markdown" small icon="copy" id="rec-copy" onClick={() => void copyMd(wo.id)} />
                <Btn label="Export" small icon="ledger" id="rec-export" onClick={() => void exportRec(wo.id)} />
              </div>
              <Meter rec={rec} pre="rec-" onJump={jump} />
              <Scrubber c={c} events={events} pre="rec-" />
              <Sections c={c} />
            </details> : null}
          </>
        ) : tab === "gates" ? (
          <GatesPanel wo={wo} cat={cat} />
        ) : tab === "runs" ? (
          <RunsPanel wo={wo} cat={cat} />
        ) : (
          <div className="cols w21">
            <Panel title="Timeline">
              {timeline.length ? (
                <ol className="tl">
                  {timeline.map((l, i) => (
                    <li key={i} className={tone(l.text)}><time>{fmtDate(l.at)}</time><div><b>{plainName(actor(l.who).name)}</b>{` ${l.text}`}</div></li>
                  ))}
                </ol>
              ) : <Empty title="No events yet" text="Events appear here as the work order moves." />}
            </Panel>
            <Panel title="Conversation" flush>
              <div className="dz-main dz-conv">
                <WoSessionPage woId={id} bare back={() => setTab("document")} />
              </div>
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
