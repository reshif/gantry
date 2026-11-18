/**
 * One work order on one page, as the prototype's record: the header (where it is, what it is doing, what you may do), then seven tabs:
 * Overview, Journey (the timeline, with the written record and its replay below), Gates, Attempts and runs, Conversation (the agent
 * session with its composer and side threads), Cost and Events. The route is `#record/<WO>` or `#record/<WO>/<tab>`.
 */
import { useCallback } from "react";
import { navigate } from "../../lib/router";
import { Btn, Tabs } from "../../ui/primitives";
import { Loading } from "../../ui/async";
import { useWoSession } from "../conversations/session-api";
import { useRecordData } from "../record/data";
import { Picker } from "../record/Picker";
import { useUI } from "../../ui/overlay-context";
import { DossierHead, reviewGate } from "./Head";
import { Overview } from "./Overview";
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
  const setTab = useCallback((t: DossierTab) => navigate("record", t === "overview" ? id : `${id}/${t}`), [id]);
  if (d.loading) return <div className="view rec-view"><Loading id="rec-loading" label="the record" /></div>;
  const status = statusOf(d.error);
  if (d.error || !d.wo || !d.rec || !d.project || !d.cat) {
    if (status === 401) return <Picker />;
    if (status === 403 || status === 404 || (!d.error && !d.wo)) return <NotFound id={id} />;
    return <Picker note={`Could not load ${id}.`} />;
  }
  const { wo, rec, project, cat } = d;
  const rg = reviewGate(wo, cat);
  const decide = () => {
    if (rg) void ui.open((close) => <ReviewDialog wo={wo} gate={rg.g} rec={rec} onClose={close} />);
  };
  const review = rg ? <Btn label={rg.g.id === "G0G1" ? "Confirm brief" : `Review ${rg.g.label}`} kind="ok" small id="dz-gates-review" guard={rg.ap} onClick={decide} /> : null;
  return (
    <div className="page dz" id="dz">
      <DossierHead wo={wo} cat={cat} project={project} session={session} rec={rec} />
      <Tabs idPrefix="dz-tab" items={DOSSIER_TABS.map((t) => ({ id: t.id, label: t.label }))} active={tab} onChange={(t) => setTab(t as DossierTab)} />
      <div role="tabpanel" aria-labelledby={`dz-tab-${tab}`}>
        {tab === "overview" ? <Overview wo={wo} rec={rec} cat={cat} project={project} session={session} />
        : tab === "journey" ? <JourneyTimeline wo={wo} cat={cat} project={project} />
        : tab === "gates" ? <GatesTab wo={wo} cat={cat} project={project} rec={rec} review={review} />
        : tab === "attempts" ? <AttemptsTab wo={wo} cat={cat} rec={rec} />
        : tab === "conversation" ? <ConversationTab wo={wo} session={session} loading={sess.isLoading} />
        : tab === "costs" ? <CostTab wo={wo} cat={cat} project={project} />
        : <EventsTab rec={rec} wo={wo} cat={cat} />}
      </div>
    </div>
  );
}
