/**
 * One work order on one page: the header (where it is, what it is doing, what you may do), then two tabs.
 * Document is the written record of the work order, in sections. Activity is the conversation with the station's agent, with its proposals and gates.
 * The side column holds the properties, what waits on you, the brief and the outline. The route is `#record/<WO>` or `#record/<WO>/activity`.
 */
import { useCallback, useEffect, useRef } from "react";
import { navigate } from "../../lib/router";
import { Btn, Tabs } from "../../ui/primitives";
import { Loading } from "../../ui/async";
import { reducedMotion } from "../../lib/prefs";
import { WoSessionPage } from "../conversations/Session";
import { useWoSession } from "../conversations/session-api";
import { Scrubber, Sections } from "../record/Lifecycle";
import { useRecordData, type SectionId } from "../record/data";
import { journeyOf, toRecEvent } from "../traveler/model";
import { Picker } from "../record/Picker";
import { DossierHead } from "./Head";
import { Overview } from "./Overview";
import { AttemptsTab, CostTab, EventsTab, GatesTab, JourneyTab } from "./Tabs";
import { Props } from "./Props";

export type DossierTab = "overview" | "journey" | "gates" | "attempts" | "activity" | "cost" | "events" | "document";
/** The prototype's tab order; "activity" is its Conversation tab, "document" (the station documents) follows the prototype's tabs. */
export const DOSSIER_TABS: Array<{ id: DossierTab; label: string }> = [
  { id: "overview", label: "Overview" }, { id: "journey", label: "Journey" }, { id: "gates", label: "Gates" }, { id: "attempts", label: "Attempts and runs" },
  { id: "activity", label: "Conversation" }, { id: "cost", label: "Cost" }, { id: "events", label: "Events" }, { id: "document", label: "Document" },
];

export function Dossier({ id, tab }: { id: string; tab: DossierTab }) {
  const d = useRecordData(id);
  const sess = useWoSession(id);
  const session = sess.data;
  const root = useRef<HTMLDivElement>(null);
  const setTab = useCallback((t: DossierTab) => navigate("record", t === "overview" ? id : `${id}/${t}`), [id]);
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
    if (status === 401) return <Picker />;
    return <Picker note={status === 403 || status === 404 ? `${id} was not found, or it belongs to a project outside your access. Pick a record you can see.` : `Could not load ${id}.`} />;
  }
  const { wo, rec, project, cat } = d;
  const c = { wo, rec, project, cat, pre: "rec-", compact: false, doc: true };
  const jump = (s: SectionId) => {
    pendingSection.current = s;
    if (tab !== "document") setTab("document");
    else scrollToSection();
  };
  const decide = () => {
    const b = document.getElementById("trv-approve");
    scroll(document.getElementById("dz-head"), b);
  };
  const events = journeyOf(rec.events.map(toRecEvent));
  return (
    <div className="view rec-view dz" id="dz" ref={root}>
      <DossierHead wo={wo} cat={cat} project={project} session={session} />
      <div className="dz-tabbar">
        <Tabs idPrefix="dz-tab" items={DOSSIER_TABS} active={tab} onChange={(t) => setTab(t as DossierTab)} />
      </div>
      {tab === "overview" ? (
        <div role="tabpanel" aria-labelledby="dz-tab-overview"><Overview wo={wo} rec={rec} cat={cat} project={project} session={session} /></div>
      ) : tab === "journey" ? (
        <div role="tabpanel" aria-labelledby="dz-tab-journey"><JourneyTab wo={wo} cat={cat} /></div>
      ) : tab === "gates" ? (
        <div role="tabpanel" aria-labelledby="dz-tab-gates"><GatesTab wo={wo} rec={rec} cat={cat} acts={wo.allowed.approve ? <Btn label={`Review ${wo.allowed.approve.gate}`} kind="ok sm" id="dz-gates-review" onClick={decide} /> : undefined} /></div>
      ) : tab === "attempts" ? (
        <div role="tabpanel" aria-labelledby="dz-tab-attempts"><AttemptsTab wo={wo} cat={cat} /></div>
      ) : tab === "cost" ? (
        <div role="tabpanel" aria-labelledby="dz-tab-cost"><CostTab wo={wo} cat={cat} /></div>
      ) : tab === "events" ? (
        <div role="tabpanel" aria-labelledby="dz-tab-events"><EventsTab rec={rec} cat={cat} /></div>
      ) : (
      <div className="dz-grid">
        <div className="dz-main" role="tabpanel" aria-labelledby={`dz-tab-${tab}`}>
          {tab === "document" ? (
            <>
              <details className="dz-replay">
                <summary>Step through this work order&apos;s history</summary>
                <Scrubber c={c} events={events} pre="rec-" />
              </details>
              <Sections c={c} />
            </>
          ) : (
            <WoSessionPage woId={id} bare back={() => setTab("document")} />
          )}
        </div>
        <Props wo={wo} rec={rec} cat={cat} project={project} session={session} onJump={jump} onActivity={toActivity} onDecide={decide} />
      </div>
      )}
    </div>
  );
}
