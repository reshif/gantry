/**
 * One work order on one page, as the prototype's record: the header (where it is, what it is doing, what you may do), then seven tabs:
 * Overview, Journey (the timeline, with the written record and its replay below), Gates, Attempts and runs, Conversation (the agent
 * session with its composer and side threads), Cost and Events. The route is `#record/<WO>` or `#record/<WO>/<tab>`.
 */
import { useCallback, useEffect, useRef } from "react";
import { navigate } from "../../lib/router";
import { Btn, Tabs } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { Loading } from "../../ui/async";
import { reducedMotion } from "../../lib/prefs";
import { useWoSession } from "../conversations/session-api";
import { Scrubber, Sections, Meter } from "../record/Lifecycle";
import { useRecordData, type SectionId } from "../record/data";
import { journeyOf, toRecEvent } from "../traveler/model";
import { Picker } from "../record/Picker";
import { useUI } from "../../ui/overlay-context";
import { DossierHead, reviewGate } from "./Head";
import { Overview } from "./Overview";
import { waitingOnYou } from "./Props";
import { AttemptsTab, ConversationTab, CostTab, EventsTab, GatesTab, JourneyTimeline } from "./tabs";
import { NotFound, statusOf } from "./kit";
import { ReviewDialog } from "./ReviewDialog";

export const DOSSIER_TABS = [
  { id: "overview", label: "Overview" },
  { id: "journey", label: "Journey" },
  { id: "gates", label: "Gates" },
  { id: "attempts", label: "Attempts and runs" },
  { id: "conversation", label: "Conversation" },
  { id: "costs", label: "Cost" },
  { id: "events", label: "Events" },
] as const;
export type DossierTab = (typeof DOSSIER_TABS)[number]["id"];
/** Addresses from before the seven tabs: Document is now part of Journey, Activity is the Conversation. */
export const tabFromParam = (raw: string): DossierTab => (raw === "document" ? "journey" : raw === "activity" ? "conversation" : (DOSSIER_TABS.find((t) => t.id === raw)?.id ?? "overview"));

export function Dossier({ id, tab }: { id: string; tab: DossierTab }) {
  const ui = useUI();
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
  // a link to a part of the conversation opens the Conversation tab first, then scrolls once it has rendered
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (tab !== "conversation" || !pending.current) return;
    const target = pending.current;
    const t = setTimeout(() => { scroll(document.getElementById(target), document.getElementById(target)); pending.current = null; }, 120);
    return () => clearTimeout(t);
  }, [tab, session]);
  // a link to a section of the document opens the Journey tab first, then scrolls once it has rendered
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
    if (tab !== "journey" || !pendingSection.current) return;
    const t = setTimeout(scrollToSection, 120);
    return () => clearTimeout(t);
  }, [tab, d.loading, scrollToSection]);
  const toActivity = (target?: string) => {
    pending.current = target ?? "wos-input";
    if (tab !== "conversation") setTab("conversation");
    else { scroll(document.getElementById(pending.current), document.getElementById(pending.current)); pending.current = null; }
  };

  if (d.loading) return <div className="view rec-view"><Loading id="rec-loading" label="the record" /></div>;
  const status = statusOf(d.error);
  if (d.error || !d.wo || !d.rec || !d.project || !d.cat) {
    if (status === 401) return <Picker />;
    if (status === 403 || status === 404) return <NotFound id={id} />;
    return <Picker note={`Could not load ${id}.`} />;
  }
  const { wo, rec, project, cat } = d;
  const c = { wo, rec, project, cat, pre: "rec-", compact: false, doc: true };
  const jump = (s: SectionId) => {
    pendingSection.current = s;
    if (tab !== "journey") setTab("journey");
    else scrollToSection();
  };
  const rg = reviewGate(wo, cat);
  const decide = () => {
    if (rg) void ui.open((close) => <ReviewDialog wo={wo} gate={rg.g} rec={rec} onClose={close} />);
  };
  const waiting = waitingOnYou(wo, cat, session);
  const events = journeyOf(rec.events.map(toRecEvent));
  const review = rg ? <Btn label={rg.g.id === "G0G1" ? "Confirm brief" : `Review ${rg.g.label}`} kind="ok" small id="dz-gates-review" guard={rg.ap} onClick={decide} /> : null;
  return (
    <div className="page dz" id="dz" ref={root}>
      <DossierHead wo={wo} cat={cat} project={project} session={session} rec={rec} />
      <div className="dz-tabbar">
        <Tabs idPrefix="dz-tab" items={DOSSIER_TABS.map((t) => ({ id: t.id, label: t.label }))} active={tab} onChange={(t) => setTab(t as DossierTab)} />
        {waiting.length ? (
          <Btn cls="dz-tabnote need" label={`Waiting on you (${waiting.length})`} icon="check" onClick={() => (waiting[0]?.go === "decide" ? decide() : toActivity(waiting[0]?.target))} />
        ) : <span className="dz-tabnote faint"><Icon name="check" />Nothing waits on you</span>}
      </div>
      <div role="tabpanel" aria-labelledby={`dz-tab-${tab}`}>
        {tab === "overview" ? <Overview wo={wo} rec={rec} cat={cat} project={project} session={session} />
        : tab === "journey" ? (
          <div className="stack" id="dz-journey-tab">
            <JourneyTimeline wo={wo} cat={cat} project={project} />
            <div id="dz-doc" className="stack">
              <div className="label">Written record</div>
              <Meter rec={rec} pre="rec-" onJump={jump} />
              <details className="dz-replay">
                <summary>Step through this work order&apos;s history</summary>
                <Scrubber c={c} events={events} pre="rec-" />
              </details>
              <Sections c={c} />
            </div>
          </div>
        )
        : tab === "gates" ? <GatesTab wo={wo} cat={cat} project={project} rec={rec} review={review} />
        : tab === "attempts" ? <AttemptsTab wo={wo} cat={cat} />
        : tab === "conversation" ? <ConversationTab wo={wo} session={session} loading={sess.isLoading} />
        : tab === "costs" ? <CostTab wo={wo} cat={cat} />
        : <EventsTab rec={rec} />}
      </div>
    </div>
  );
}
